import test from 'node:test';
import assert from 'node:assert/strict';
import * as exit from '../src/chain/v4/exit-quote.ts';
import {freshEthUsd} from '../src/chain/fresh-price.ts';
import {ethers} from 'ethers';
import {STATEVIEW_ABI, V4_POSM_ABI} from '../src/chain/v4/abis.ts';

const ZERO = '0x0000000000000000000000000000000000000000';
const TOKEN = '0x1111111111111111111111111111111111111111';
const WETH = '0x2222222222222222222222222222222222222222';
const OWNER = '0x3333333333333333333333333333333333333333';
const POSM = '0x4444444444444444444444444444444444444444';
const STATE = '0x5555555555555555555555555555555555555555';
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const Q128 = 1n << 128n;
const NOW = 1_800_000_000_000;
const L = 1000000000000000000n;
const INFO = (BigInt(0x1000000 - 60) << 8n) | (60n << 32n);

// Only external RPC/HTTP boundaries are faked. SDK principal math, fee arithmetic,
// validation, currency routing and net cash calculation remain production code.
function fixture(options = {}) {
  const block = {number: 123, timestamp: NOW / 1000 - 1, hash: '0x' + 'aa'.repeat(32), ...options.block};
  const key = {currency0: ZERO, currency1: TOKEN, fee: 3000n, tickSpacing: 60n, hooks: ZERO, ...options.key};
  const values = {
    ownerOf: OWNER,
    getPositionLiquidity: L,
    getPoolAndPositionInfo: [key, INFO],
    getSlot0: [1n << 96n, 0n, 0n, 3000n],
    getFeeGrowthInside: [Q128, Q128 * 2n],
    getPositionInfo: [L, 0n, 0n],
    decimals: 18n,
    symbol: 'USDG',
    ...options.values,
  };
  const sold = [];
  const deps = {
    owner: OWNER, positionManager: POSM, stateView: STATE, weth: WETH,
    chainId: 4663, slippagePct: 5, exitCostBufferUsd: 0.25,
    now: () => NOW,
    getBlock: async tag => {
      assert.ok(tag === 'latest' || tag === 123);
      return block;
    },
    readContract: async req => {
      assert.equal(req.blockTag, 123, 'every state/metadata read must use the pinned block');
      if (req.functionName === 'ownerOf' || req.functionName === 'getPositionLiquidity' || req.functionName === 'getPoolAndPositionInfo') {
        assert.equal(req.address, POSM);
        assert.deepEqual(req.args, ['42']);
      } else if (req.functionName.startsWith('get')) assert.equal(req.address, STATE);
      const value = values[req.functionName];
      if (value instanceof Error) throw value;
      return value;
    },
    sellQuote: async (address, amount) => {
      sold.push({address, amount});
      // Hand-checked token principal is floor(1e18 * (sqrt(1.0001^60)-1)/sqrt(...)).
      assert.equal(amount, 2002995354955910780n, 'quote the entire token principal plus fees');
      return {tokenIn: address, tokenOut: NATIVE, amountIn: amount.toString(), amountOut: '10000000000000000', observedAt: NOW, ...options.route};
    },
    ethReference: async () => ({usd: 2000, observedAt: NOW, ...options.price}),
    ...options.deps,
  };
  return {deps, sold};
}

test('principal plus accrued fees become net estimated ETH cash, not a USD-symbol peg', async () => {
  assert.equal(typeof exit.createV4ExitQuoter, 'function');
  const f = fixture();
  const result = await exit.createV4ExitQuoter(f.deps)('42');
  // Native: 1 ETH fees + 0.002995354955910780 principal. Token: 0.01 ETH
  // full-size route less 5%, then $0.25 future gas budget.
  assert.ok(Math.abs(result.netUsd - 2024.7407099118216) < 1e-9);
  assert.equal(result.observedAt, NOW - 1000);
  assert.equal(result.blockNumber, 123);
  assert.equal(f.sold.length, 1);
});

for (const [label, options] of [
  ['missing owner', {values: {ownerOf: undefined}}],
  ['foreign owner', {values: {ownerOf: TOKEN}}],
  ['empty liquidity', {values: {getPositionLiquidity: 0n}}],
  ['negative liquidity', {values: {getPositionLiquidity: -1n}}],
  ['missing fee growth', {values: {getFeeGrowthInside: undefined}}],
  ['reverted fee read', {values: {getFeeGrowthInside: new Error('revert')}}],
  ['mismatched liquidity', {values: {getPositionInfo: [L + 1n, 0n, 0n]}}],
  ['unknown decimals', {values: {decimals: undefined}}],
  ['unreasonable decimals', {values: {decimals: 255n}}],
  ['unknown symbol', {values: {symbol: '?'}}],
  ['nonzero hooks', {key: {hooks: TOKEN}}],
  ['stale block', {block: {timestamp: NOW / 1000 - 61}}],
  ['future block', {block: {timestamp: NOW / 1000 + 10}}],
  ['invalid sqrt', {values: {getSlot0: [0n, 0n, 0n, 3000n]}}],
  ['missing tick', {values: {getSlot0: [1n << 96n, null, 0n, 3000n]}}],
  ['missing protocol fee', {values: {getSlot0: [1n << 96n, 0n, undefined, 3000n]}}],
  ['inconsistent static fee', {values: {getSlot0: [1n << 96n, 0n, 0n, 10000n]}}],
  ['overflow fee growth', {values: {getFeeGrowthInside: [1n << 256n, 0n]}}],
  ['wrapped implausible fees', {values: {getPositionInfo: [L, Q128, Q128 * 3n]}}],
  ['stale price', {price: {observedAt: NOW - 61_000}}],
  ['zero price', {price: {usd: 0}}],
  ['infinite price', {price: {usd: Infinity}}],
  ['stale sell quote', {route: {observedAt: NOW - 61_000}}],
  ['mismatched quote input', {route: {amountIn: '1'}}],
  ['wrong quote input currency', {route: {tokenIn: WETH}}],
  ['wrong quote output', {route: {tokenOut: TOKEN}}],
  ['empty route output', {route: {amountOut: '0'}}],
  ['negative route output', {route: {amountOut: '-1'}}],
  ['overflow route output', {route: {amountOut: (1n << 256n).toString()}}],
  ['implausible route output', {route: {amountOut: '1000000000000000000000000'}}],
  ['missing route', {deps: {sellQuote: async () => null}}],
  ['route failure', {deps: {sellQuote: async () => {throw new Error('route unavailable');}}}],
]) test(`fails closed on ${label}`, async () => {
  await assert.rejects(() => exit.createV4ExitQuoter(fixture(options).deps)('42'));
});

test('WETH is valued directly without a swap haircut; USD-like names are not trusted pegs', async () => {
  const f = fixture({key: {currency1: WETH}});
  const result = await exit.createV4ExitQuoter(f.deps)('42');
  assert.ok(Math.abs(result.netUsd - 6011.731419823643) < 1e-9);
  assert.equal(f.sold.length, 0);
});

test('untrusted token/token pair sells both full amounts, never uses the pool spot ratio', async () => {
  const calls = [];
  const f = fixture({key: {currency0: TOKEN, currency1: '0x6666666666666666666666666666666666666666'}, deps: {
    sellQuote: async (address, amount) => {
      calls.push([address, amount]);
      return {tokenIn: address, tokenOut: NATIVE, amountIn: amount.toString(), amountOut: '10000000000000000', observedAt: NOW};
    },
  }});
  const result = await exit.createV4ExitQuoter(f.deps)('42');
  assert.equal(result.netUsd, 37.75);
  assert.deepEqual(calls.map(c => c[1]), [1002995354955910780n, 2002995354955910780n]);
});

test('a block that becomes stale during quoting is rejected', async () => {
  let now = NOW;
  const f = fixture({deps: {now: () => now, ethReference: async () => {now += 61_000; return {usd: 2000, observedAt: now};}}});
  await assert.rejects(() => exit.createV4ExitQuoter(f.deps)('42'));
});

test('fresh ETH reference validates HTTP/value, briefly caches, and never serves expired fallback', async t => {
  let now = NOW;
  let count = 0;
  let fail = false;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => {
    count++;
    if (fail) return new Response('{}', {status: 503});
    return new Response(JSON.stringify({data: {amount: '2000', currency: 'USD'}}));
  });
  assert.deepEqual(await freshEthUsd(), {usd: 2000, observedAt: NOW});
  now += 1000;
  assert.deepEqual(await freshEthUsd(), {usd: 2000, observedAt: NOW});
  assert.equal(count, 1);
  now += 61_000;
  fail = true;
  await assert.rejects(freshEthUsd, /fresh ETH\/USD/i);
});

test('ETH fallback preserves the upstream quote timestamp rather than making old prices new', async t => {
  const now = NOW + 120_000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).includes('coinbase')) return new Response('{}', {status: 503});
    return new Response(JSON.stringify({ethereum: {usd: 2100, last_updated_at: (now - 50_000) / 1000}}));
  });
  assert.deepEqual(await freshEthUsd(), {usd: 2100, observedAt: now - 50_000});
});

test('ETH reference refuses invalid currency and stale fallback even with valid positive prices', async t => {
  const now = NOW + 240_000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async url => new Response(JSON.stringify(
    String(url).includes('coinbase') ? {data: {amount: '2000', currency: 'EUR'}} :
      {ethereum: {usd: 2100, last_updated_at: (now - 61_000) / 1000}},
  )));
  await assert.rejects(freshEthUsd, /fresh ETH\/USD/i);
});

test('public quote adapter performs only pinned eth_call reads and GET price/routes, with no signing', async t => {
  process.env.RH_WALLET_KEY = '0x' + '11'.repeat(32); // deterministic public test key, never funded
  process.env.KYBERSWAP_ROUTER_ADDRESS = STATE;
  const {cfg, C} = await import('../src/config.ts');
  const {provider, wallet} = await import('../src/chain/client.ts');
  const saved = {posm: C.v4PositionManager, sv: C.v4StateView, weth: C.weth, slip: cfg.lp.slippagePct, cost: cfg.autoLp.exitCostBufferUsd};
  Object.assign(C, {v4PositionManager: POSM, v4StateView: STATE, weth: WETH});
  cfg.lp.slippagePct = 5;
  cfg.autoLp.exitCostBufferUsd = 0.25;
  const now = NOW + 360_000;
  const block = {number: 123, timestamp: now / 1000 - 1, hash: '0x' + 'aa'.repeat(32)};
  t.mock.method(Date, 'now', () => now);
  t.mock.method(provider, 'getBlock', async () => block);
  t.mock.method(provider, 'broadcastTransaction', async () => assert.fail('no broadcast'));
  t.mock.method(wallet(), 'sendTransaction', async () => assert.fail('no wallet sends'));
  t.mock.method(wallet(), 'signTransaction', async () => assert.fail('no signing'));
  const f = fixture({values: {ownerOf: wallet().address}});
  const iface = new ethers.Interface([...V4_POSM_ABI, ...STATEVIEW_ABI, 'function decimals() view returns (uint8)', 'function symbol() view returns (string)']);
  t.mock.method(provider, 'call', async tx => {
    assert.equal(tx.blockTag, 123);
    const decoded = iface.parseTransaction({data: tx.data});
    const args = decoded.name === 'getPoolAndPositionInfo' || decoded.name === 'ownerOf' || decoded.name === 'getPositionLiquidity' ? [decoded.args[0].toString()] : [...decoded.args];
    const result = await f.deps.readContract({address: tx.to, functionName: decoded.name, args, blockTag: tx.blockTag});
    return iface.encodeFunctionResult(decoded.name, decoded.name === 'getPoolAndPositionInfo' || !decoded.name.startsWith('get') || decoded.name === 'getPositionLiquidity' ? [result] : result);
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.ok(!options?.method || options.method === 'GET', 'no build/POST API');
    if (String(url).includes('coinbase')) return new Response(JSON.stringify({data: {amount: '2000', currency: 'USD'}}));
    const u = new URL(url);
    assert.ok(u.pathname.endsWith('/routes'));
    assert.equal(u.searchParams.get('tokenIn'), TOKEN);
    assert.equal(u.searchParams.get('amountIn'), '2002995354955910780');
    return new Response(JSON.stringify({code: 0, data: {routerAddress: STATE, routeSummary: {
      tokenIn: TOKEN, tokenOut: NATIVE, amountIn: '2002995354955910780', amountOut: '10000000000000000', route: [[{exchange: 'fixture'}]],
    }}}));
  });
  try {
    const result = await exit.quoteV4Exit('42');
    assert.ok(Math.abs(result.netUsd - 2024.7407099118216) < 1e-9);
    assert.equal(result.observedAt, now - 1000);
  } finally {
    Object.assign(C, {v4PositionManager: saved.posm, v4StateView: saved.sv, weth: saved.weth});
    cfg.lp.slippagePct = saved.slip;
    cfg.autoLp.exitCostBufferUsd = saved.cost;
  }
});
