import test from 'node:test';
import assert from 'node:assert/strict';
import { screenTokens } from '../src/radar/screen.ts';

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
