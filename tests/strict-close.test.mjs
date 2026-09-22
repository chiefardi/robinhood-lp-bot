import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { ethers } from 'ethers';

const POSM = '0x1111111111111111111111111111111111111111';
const USER = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x3333333333333333333333333333333333333333';
const WETH = '0x4444444444444444444444444444444444444444';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const transfer = new ethers.Interface(['event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)']);

// Only the I/O boundary is replaced: production close calldata, exact-amount
// accounting, receipt checks and error propagation execute unchanged.
function fixture(options = {}) {
  let clockNow=Date.now();
  const calls = { sends: [], swaps: [], balanceBlocks: [], ledger: 0 };
  let burned = false;
  const balances = new Map([[TOKEN, 900719925474099312345n], [USDG, 100000000n]]);
  const tokenStart = balances.get(TOKEN);
  const receiptEvent = transfer.encodeEventLog(transfer.getEvent('Transfer'), [USER, ethers.ZeroAddress, 12n]);
  const receipt = { status: 1, blockNumber: options.missingBurnBlock ? undefined : 42, logs: [{ address: POSM, ...receiptEvent }] };
  const provider = {
    send: async (method) => {
      assert.equal(method, 'eth_getBlockByNumber');
      return { number: options.invalidPreflightBlock ? 'bad' : '0x28', timestamp: '0x' + (Math.floor(Date.now() / 1000) - (options.stalePreflight ? 90 : 0)).toString(16) };
    },
    call: async () => { if (options.simulateFail) throw new Error('simulation failed'); },
    getBalance: async () => 1000000000000000000n,
    getTransactionReceipt: async () => options.missingSwapReceipt ? null : { status: 1, blockNumber: options.missingSwapBlock ? undefined : 45 },
  };
  const signer = { address: USER, sendTransaction: async (tx) => {
    calls.sends.push(tx);
    if (options.sendFail) throw new Error('transport uncertainty');
    return { hash: '0xburn' };
  } };
  class Contract {
    constructor(address) { this.address = address.toLowerCase(); }
    async getPoolAndPositionInfo() { return [{ currency0: USDG, currency1: TOKEN, fee: 5000, tickSpacing: 100, hooks: ethers.ZeroAddress }, 0n]; }
    async ownerOf() { return options.wrongOwner ? TOKEN : USER; }
    async getPositionLiquidity() { return options.empty ? 0n : 100n; }
    async balanceOf(_owner, readOptions) {
      calls.balanceBlocks.push(readOptions?.blockTag);
      if (options.balanceFail) throw new Error('balance unavailable');
      if (options.staleLatest && burned && !readOptions?.blockTag) return this.address === TOKEN ? tokenStart : 100000000n;
      return balances.get(this.address) ?? 0n;
    }
  }
  const dependencies = {
    ethers: { ethers: { ...ethers, Contract } },
    '@uniswap/sdk-core': { default: {} }, '@uniswap/v4-sdk': { default: {} },
    '../../config.js': { C: { weth: WETH, v4PositionManager: POSM }, cfg: { chainId: 4663, lp: { autoSwapOnClose: true } } },
    '../client.js': { provider, wallet: () => signer, overrides: async () => { options.onOverrides?.(); clockNow+=options.gasDelayMs??0; return {}; }, waitTx: async () => {
      if (options.waitFail) throw new Error('receipt timeout');
      burned = true;
      balances.set(TOKEN, tokenStart + 123456789012345678901n);
      balances.set(USDG, 150000000n);
      return options.badReceipt ? { status: 1, logs: [] } : receipt;
    } },
    '../tokens.js': { tokenMeta: async (a) => {
      if (options.metadataFail) throw new Error('metadata unavailable');
      return { symbol: a === USDG ? 'USDG' : 'TEST', decimals: a === USDG ? 6 : 18 };
    } },
    './abis.js': { STATEVIEW_ABI: [], V4_POSM_ABI: [] }, './poolkey.js': { NATIVE: ethers.ZeroAddress },
    './mint.js': {}, './list.js': {}, '../price.js': {},
    '../kyber.js': { KYBER_NATIVE: 'native', kyberSwap: async (input, output, amount, strict) => {
      calls.swaps.push({ input, output, amount, strict });
      if (options.swapWait) await options.swapWait;
      if (options.swapThrow || (options.tokenSwapThrow && input.toLowerCase() === TOKEN)) throw new Error('swap uncertain');
      if (options.noRoute) return null;
      if (!options.residual) balances.set(input.toLowerCase(), balances.get(input.toLowerCase()) - amount);
      return { tx: '0xswap', amountOut: options.zeroOutput ? 0n : 123n };
    } },
    '../ledger.js': { appendLedger: () => { calls.ledger++; } },
    '../../util/files.js': { dataPath: (x) => x, readJson: () => ({}), writeJson: () => {} },
    '../../util/log.js': { logger: () => ({ info() {}, warn() {} }) },
  };
  const source = readFileSync(new URL('../src/chain/v4/close.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const api = {};
  vm.runInNewContext(outputText, { Date:class extends Date {static now(){return clockNow}}, exports: api, require(name) { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; }, setTimeout, clearTimeout }, { filename: 'close.ts' });
  return { api, calls, balances, tokenStart, burned: () => burned };
}

test('strict close API is available without using legacy marked-value accounting', () => {
  assert.equal(typeof fixture().api.closeV4PositionStrict, 'function');
});

test('strict close sells exact received USDG and token amounts while preserving all pre-held inventory', async () => {
  const f = fixture();
  const r = await f.api.closeV4PositionStrict('12', 'TRAIL');
  assert.equal(r.completed, true);
  assert.equal(r.strict, true);
  assert.equal(r.confirmedBlockNumber, 45);
  assert.equal(r.recv1Raw, '123456789012345678901');
  assert.equal(f.calls.swaps.length, 2);
  assert.equal(f.calls.swaps[0].input.toLowerCase(), USDG);
  assert.equal(f.calls.swaps[0].amount, 50000000n);
  assert.equal(f.calls.swaps[1].input.toLowerCase(), TOKEN);
  assert.equal(f.calls.swaps[1].amount, 123456789012345678901n);
  assert.equal(typeof f.calls.swaps[0].strict?.assertActive, 'function');
  assert.deepEqual(f.calls.balanceBlocks.slice(0, 2), [40, 40]);
  assert.equal(f.balances.get(TOKEN), f.tokenStart);
  assert.equal(f.balances.get(USDG), 100000000n);
  assert.equal(f.calls.ledger, 0);
  assert.equal(f.calls.sends.length, 1);
});

for (const flag of ['metadataFail', 'balanceFail', 'wrongOwner', 'empty', 'simulateFail', 'stalePreflight', 'invalidPreflightBlock']) {
  test(`strict close fails before broadcast on ${flag}`, async () => {
    const f = fixture({ [flag]: true });
    await assert.rejects(() => f.api.closeV4PositionStrict('12'), (e) => e.broadcastPossible === false);
    assert.equal(f.calls.sends.length, 0);
    assert.equal(f.calls.swaps.length, 0);
  });
}

for (const flag of ['sendFail', 'waitFail', 'badReceipt', 'swapThrow', 'noRoute', 'residual', 'zeroOutput', 'missingBurnBlock', 'missingSwapReceipt', 'missingSwapBlock']) {
  test(`strict close latches uncertainty without a second burn or force-close on ${flag}`, async () => {
    const f = fixture({ [flag]: true });
    await assert.rejects(() => f.api.closeV4PositionStrict('12'), (e) => e.broadcastPossible === true);
    assert.equal(f.calls.sends.length, 1);
    assert.equal(f.calls.ledger, 0);
  });
}

test('strict close stays pending until the swap settles', async () => {
  let release;
  const swapWait = new Promise((resolve) => { release = resolve; });
  const f = fixture({ swapWait });
  let complete = false;
  const result = f.api.closeV4PositionStrict('12').then(() => { complete = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.swaps.length, 1);
  assert.equal(complete, false);
  release();
  await result;
  assert.equal(complete, true);
});

test('a failed second sale stays uncertain after USDG conversion rather than reporting completed cash exit', async () => {
  const f = fixture({ tokenSwapThrow: true });
  await assert.rejects(() => f.api.closeV4PositionStrict('12'), (e) => e.broadcastPossible === true && e.positionBurned === true);
  assert.equal(f.calls.sends.length, 1);
  assert.equal(f.calls.swaps.length, 2);
  assert.equal(f.balances.get(USDG), 100000000n);
  assert.equal(f.balances.get(TOKEN), f.tokenStart + 123456789012345678901n);
  assert.equal(f.calls.ledger, 0);
});

test('post-transaction inventory reads use confirmed blocks instead of cached latest balances', async () => {
  const f = fixture({ staleLatest: true });
  const result = await f.api.closeV4PositionStrict('12');
  assert.equal(result.recv0Raw, '50000000');
  assert.equal(result.recv1Raw, '123456789012345678901');
  assert.equal(f.calls.swaps.length, 2);
});

test('stopping auto while gas overrides load prevents the initial burn broadcast', async () => {
  let enabled = true;
  const f = fixture({ onOverrides: () => { enabled = false; } });
  await assert.rejects(() => f.api.closeV4PositionStrict('12', 'TRAIL', {
    beforeBurn() { if (!enabled) throw new Error('Auto stopped before burn'); },
  }), (e) => e.broadcastPossible === false && /Auto stopped before burn/.test(e.message));
  assert.equal(f.calls.sends.length, 0);
  assert.equal(f.calls.swaps.length, 0);
});

test('a liquidation quote expiring during close preflight cannot authorize burn',async()=>{
 const observedAt=Date.now();const f=fixture({gasDelayMs:61_000});
 await assert.rejects(()=>f.api.closeV4PositionStrict('12','MAX_HOLD',{quoteObservedAt:observedAt}),e=>e.broadcastPossible===false&&/quote/i.test(e.message));
 assert.equal(f.calls.sends.length,0);assert.equal(f.calls.swaps.length,0);
});
