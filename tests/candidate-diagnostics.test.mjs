import test from 'node:test';
import assert from 'node:assert/strict';
import * as candidate from '../src/chain/candidate.ts';
const evaluateCandidatePools = (...args) => candidate.evaluateCandidatePools(...args);

const poolId = '0x' + 'a'.repeat(64);
const pool = {
  poolId, fee: 40000, quote: 'usd', liquidity: 1n,
  poolKey: {currency0:'0x0000000000000000000000000000000000000001',currency1:'0x0000000000000000000000000000000000000002',fee:40000,tickSpacing:10,hooks:'0x0000000000000000000000000000000000000000'},
  tickSpacing:10,sqrtPriceX96:1n,tick:0,lpFee:40000,
};
const limits = {
  feeMinPpm:30000,feeMaxPpm:50000,minVolUsd:10000,minPoolLiqUsd:50000,
  maxVolLiqRatio:20,minPoolFeesUsd:250,minFeeYieldPct:0,minSpikeX:0,
};
const pair = {
  pairAddr:poolId,dexId:'uniswap',version:'v4',vol24h:20000,liqUsd:60000,
  chgH1:3,chgH6:5,volH1:2500,vol5m:300,buys5m:2,sells5m:2,observedAt:123,
};

test('reports no discovered v4 pools without suggesting that a token failed a volume gate', () => {
  const result = evaluateCandidatePools([],new Map(),limits);
  assert.equal(result.pool,null);
  assert.deepEqual(result.rejected,{'no-v4-pools-returned':1});
});

test('reports missing exact DexScreener pool data separately from low pool volume', () => {
  const result = evaluateCandidatePools([pool],new Map(),limits);
  assert.equal(result.pool,null);
  assert.deepEqual(result.rejected,{'dex-pair-data-missing':1});
});

test('reports each pool filter without changing an eligible pool selection', () => {
  const thin = {...pool,poolId:'0x'+'b'.repeat(64)};
  const result = evaluateCandidatePools([pool,thin],new Map([
    [poolId,{...pair,vol24h:5000}],
    [thin.poolId,{...pair,pairAddr:thin.poolId,liqUsd:1000}],
  ]),limits);
  assert.equal(result.pool,null);
  assert.deepEqual(result.rejected,{'24h-volume-below-minimum':1,'pool-liquidity-below-minimum':1});

  const pass = evaluateCandidatePools([pool],new Map([[poolId,pair]]),limits);
  assert.equal(pass.pool?.v4.poolId,poolId);
  assert.equal(pass.pool?.feesUsd,800);
  assert.deepEqual(pass.rejected,{});
});

test('formats the rejected pool counts as a compact stable log message', () => {
  assert.equal(candidate.formatCandidateRejection({'fee-outside-band':2,'24h-volume-below-minimum':1}),
    '24h-volume-below-minimum=1, fee-outside-band=2');
});

test('USDG-only qualification does not select a busier ETH pool', () => {
  const eth = {...pool, poolId:'0x'+'d'.repeat(64), quote:'eth'};
  const dex = new Map([
    [poolId,pair],
    [eth.poolId,{...pair,pairAddr:eth.poolId,vol24h:100_000}],
  ]);
  assert.equal(evaluateCandidatePools([eth,pool],dex,limits,'usd').pool?.v4.poolId,poolId);
});

test('auto qualification selects an active USDG pool over a quiet higher-fee-volume pool', () => {
  const quiet = {...pool,poolId:'0x'+'e'.repeat(64)};
  const dex = new Map([
    [poolId,{...pair,vol5m:2_000,volH1:10_000,observedAt:123}],
    [quiet.poolId,{...pair,pairAddr:quiet.poolId,vol24h:100_000,vol5m:100,volH1:1_000,observedAt:123}],
  ]);
  const activity={minVol5m:1_000,minVol1h:5_000,now:123};
  assert.equal(evaluateCandidatePools([quiet,pool],dex,limits,'usd',activity).pool?.v4.poolId,poolId);
});

test('auto qualification rejects hooked pools before an entry reservation', () => {
  const hooked = {...pool,poolId:'0x'+'f'.repeat(64),poolKey:{...pool.poolKey,hooks:'0x0000000000000000000000000000000000000001'}};
  const dex = new Map([[hooked.poolId,{...pair,pairAddr:hooked.poolId,vol5m:2_000,volH1:10_000,observedAt:123}]]);
  const activity={minVol5m:1_000,minVol1h:5_000,now:123};
  const result=evaluateCandidatePools([hooked],dex,limits,'usd',activity);
  assert.equal(result.pool,null);
  assert.equal(result.rejected['hooked-pool'],1);
});

test('USDG-only qualification does not waste RPC discovery on ETH pools', () => {
  assert.equal(typeof candidate.discoveryTargetsForQuote,'function');
  assert.deepEqual(candidate.discoveryTargetsForQuote('usd'),{eth:false,usd:true});
  assert.deepEqual(candidate.discoveryTargetsForQuote(undefined),{eth:true,usd:true});
});
