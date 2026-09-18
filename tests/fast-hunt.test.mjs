import test from 'node:test';
import assert from 'node:assert/strict';
import { screenTokens } from '../src/radar/screen.ts';
import { rankExactPoolCandidates, fastPoolScore } from '../src/radar/fast-hunt.ts';
import * as pipeline from '../src/telegram/pipeline.ts';
import { dexPairs } from '../src/chain/dexscreener.ts';
import * as guard from '../src/radar/entry-guard.ts';

const trend = (symbol, volume, overrides = {}) => ({
  address: symbol === 'DOG' ? '0x' + 'a'.repeat(40) : '0x' + 'b'.repeat(40),
  name: symbol === 'DOG' ? 'Dog Meme' : 'Oracle Network', symbol,
  priceUsd: 0.01, change24hPct: 10, change1hPct: 2, volume,
  liquidity: 80_000, marketCap: 500_000, athMarketCap: 1_000_000,
  swaps: 100, buys: 60, sells: 40, holders: 2000, top10Rate: 0.2,
  launchpad: 'noxa', launchpadPlatform: 'noxa', twitter: 'project', website: 'https://example.org', telegram: '',
  twitterDup: 0, telegramDup: 0, websiteDup: 0, twitterChanged: false, ctoFlag: false, isOg: false,
  smartWallets: 10, kolWallets: 3, sniperCount: 0, botDegenCount: 0, visitingCount: 100, hotLevel: 2,
  rugRatio: 0, bundlerRate: 0.05, entrapmentRatio: 0, devHoldRate: 0, sniperHoldRate: 0,
  buyTax: 0, sellTax: 0, isHoneypot: false, isRenounced: true, isOpenSource: true,
  lockPercent: 1, burnStatus: 'yes', ageMs: 3_600_000, ...overrides,
});

test('fast hunt keeps a high-volume meme ahead of a lower-volume utility token', async () => {
  let requested;
  const result = await screenTokens({
    interval: '5m', minVolume: 0, limit: 100, rankBy: 'volume', llm: false,
    trend: async options => { requested = options; return [trend('DOG', 90_000), trend('ORACLE', 30_000)]; },
  });
  assert.equal(requested.interval, '5m');
  assert.equal(requested.limit, 100);
  assert.deepEqual(result.results.map(r => r.token.symbol), ['DOG', 'ORACLE']);
});

const floors = { minVolUsd: 10_000, minPoolFeesUsd: 250, feeMaxPpm: 50_000, minPoolLiqUsd: 50_000, minVol5m: 1_000, minVol1h: 5_000 };
const pair = (vol5m, volH1, extra = {}) => ({
  pairAddr: '0x' + 'c'.repeat(64), version: 'v4', vol24h: 30_000, liqUsd: 80_000,
  baseTokenAddress:'0x'+'a'.repeat(40), quoteTokenAddress:'0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  vol5m, volH1, buys5m: 3, sells5m: 2, observedAt: 1000, ...extra,
});
const row = (symbol, score, volume) => ({ token: trend(symbol, volume), score, kind: 'meme', community: 'clear', fomo: 50, flags: [] });

test('fast hunt ranks exact v4 pool activity rather than token volume or utility score', () => {
  const quiet = row('ORACLE', 95, 500_000);
  const busy = row('DOG', 20, 50_000);
  const maps = new Map([
    [quiet.token.address.toLowerCase(), new Map([['quiet', pair(500, 100_000)]])],
    [busy.token.address.toLowerCase(), new Map([['busy', pair(8_000, 50_000)]])],
  ]);
  const ranked = rankExactPoolCandidates([quiet, busy], maps, floors, 1000);
  assert.deepEqual(ranked.map(x => x.result.token.symbol), ['DOG']);
  assert.equal(ranked[0].vol5m, 8_000);
});

test('fast hunt excludes missing activity, one-sided trading, and v3 pools', () => {
  const tokens = [row('DOG', 80, 80_000), row('ORACLE', 80, 70_000)];
  const maps = new Map([
    [tokens[0].token.address.toLowerCase(), new Map([['missing', pair(undefined, 40_000)], ['v3', pair(20_000, 40_000, { version: 'v3' })]])],
    [tokens[1].token.address.toLowerCase(), new Map([['one-sided', pair(20_000, 40_000, { sells5m: 0 })]])],
  ]);
  assert.deepEqual(rankExactPoolCandidates(tokens, maps, floors, 1000), []);
});

test('fast hunt activity score starts at 75 and rises with exact-pool volume', () => {
  assert.equal(fastPoolScore(pair(1_000, 5_000), floors, 1000), 75);
  assert.ok(fastPoolScore(pair(8_000, 40_000), floors, 1000) > 75);
  assert.equal(fastPoolScore(pair(100_000, 100_000, { sells5m: 0 }), floors, 1000), null);
});

test('fast hunt excludes busy ETH-only pools before spending its qualification budget', () => {
  const r=row('DOG',80,200_000);
  const eth=pair(100_000,200_000,{quoteTokenAddress:'0x'+'e'.repeat(40)});
  const maps=new Map([[r.token.address.toLowerCase(),new Map([['eth',eth]])]]);
  assert.deepEqual(rankExactPoolCandidates([r],maps,floors,1000),[]);
});

test('DexScreener enrichment carries token-pair identity into the shortlist', async () => {
  const previous=globalThis.fetch;
  const token='0x'+'9'.repeat(40);
  globalThis.fetch=async()=>({json:async()=>({pairs:[{
    chainId:'robinhood',pairAddress:'0x'+'8'.repeat(64),dexId:'uniswap',labels:['v4'],
    baseToken:{address:token},quoteToken:{address:'0x5fc5360d0400a0fd4f2af552add042d716f1d168'},
    volume:{h24:30_000,h1:10_000,m5:2_000},txns:{m5:{buys:4,sells:2}},liquidity:{usd:80_000},
  }]})});
  try {
    const p=[...(await dexPairs(token,1000)).values()][0];
    assert.equal(p.baseTokenAddress,token.toLowerCase());
    assert.equal(p.quoteTokenAddress,'0x5fc5360d0400a0fd4f2af552add042d716f1d168');
  } finally {globalThis.fetch=previous}
});

test('hunt forwards the chosen pool one-hour volume, not five-minute token volume', () => {
  assert.equal(typeof pipeline.buildHuntCandidate, 'function');
  const candidate = pipeline.buildHuntCandidate(row('DOG', 82, 90_000), {liqUsd:80_000,volH1:12_000,vol5m:2_000,v4:{poolId:'0x'+'c'.repeat(64)},marketCap:500_000});
  assert.equal(candidate.source, 'hunt');
  assert.equal(candidate.vol1h, 12_000);
  assert.equal(candidate.expectedPoolId,'0x'+'c'.repeat(64));
});

test('funded preflight blocks a changed pool ID before it can reserve capital', () => {
  assert.equal(typeof guard.expectedPoolFailure,'function');
  assert.equal(guard.expectedPoolFailure('0x'+'a'.repeat(64),'0x'+'b'.repeat(64)),'selected pool changed since hunt; await fresh scan');
  assert.equal(guard.expectedPoolFailure('0x'+'a'.repeat(64),'0x'+'a'.repeat(64)),null);
});
