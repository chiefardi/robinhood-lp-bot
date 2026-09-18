import test from 'node:test';
import assert from 'node:assert/strict';
import { activityLimits, poolActivityFailure, heuristicScreenFailure } from '../src/radar/entry-guard.ts';
import { dispatchCandidateHooks, huntCandidateDecision, singleFlight, hasViableDexPool } from '../src/radar/scanLoop.ts';

test('hunt uses its own exact-pool floors without weakening watch', () => {
  const watch = { minVol5m: 100_000, minVol1h: 1_000_000 };
  const auto = { huntMinVol5m: 1_000, huntMinVol1h: 5_000 };
  const pool = { vol5m: 1_500, volH1: 7_500, buys5m: 2, sells5m: 2, observedAt: 1_000 };
  assert.equal(poolActivityFailure(pool, activityLimits('hunt', watch, auto), 1_000), null);
  assert.equal(poolActivityFailure(pool, activityLimits('watch-spike', watch, auto), 1_000), 'exact pool volume below pilot thresholds');
  assert.deepEqual(activityLimits('hunt', watch, {}), watch);
});

test('hunt callbacks complete one at a time so a rejected leader does not hide the next candidate', async () => {
  const events = [];
  await dispatchCandidateHooks([1, 2], async n => {
    events.push(`start ${n}`);
    await Promise.resolve();
    events.push(`end ${n}`);
    if (n === 1) throw new Error('candidate rejected');
  });
  assert.deepEqual(events, ['start 1', 'end 1', 'start 2', 'end 2']);
});

test('alert cooldown mutes repeat notifications but not armed hunt entry checks', () => {
  assert.deepEqual(huntCandidateDecision(100_000, 0, 120, false), { evaluate: true, notify: true });
  assert.deepEqual(huntCandidateDecision(100_000, 99_000, 120, false), { evaluate: false, notify: false });
  assert.deepEqual(huntCandidateDecision(100_000, 99_000, 120, true), { evaluate: true, notify: false });
});

test('hunt enforces configured score and action even without an LLM key', () => {
  const verdict = (score, action) => ({ llm: { score, action, summary: 'fixture' }, llmSource: 'heuristic', gmgn: null });
  assert.equal(heuristicScreenFailure(verdict(80, 'ape'), 75, 'ape'), null);
  assert.equal(heuristicScreenFailure(verdict(74, 'ape'), 75, 'ape'), 'screen score/action below pilot threshold');
  assert.equal(heuristicScreenFailure(verdict(80, 'watch'), 75, 'ape'), 'screen score/action below pilot threshold');
  assert.equal(heuristicScreenFailure(null, 75, 'ape'), 'screen verdict missing');
});

test('a slow hunt scan is shared instead of launching overlapping scans', async () => {
  let runs = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const scan = singleFlight(async () => { runs++; await gate; return runs; });
  const first = scan();
  const second = scan();
  assert.equal(runs, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), [1, 1]);
  assert.equal(await scan(), 2);
});

test('Dex prefilter skips only pools that cannot clear existing 24h gates', () => {
  const limits = { minVolUsd: 10_000, minPoolFeesUsd: 250, feeMaxPpm: 50_000, minPoolLiqUsd: 50_000 };
  const pair = (vol24h, version = 'v4') => ({ pairAddr: '0x' + 'a'.repeat(64), version, vol24h, liqUsd: 60_000 });
  assert.equal(hasViableDexPool(new Map([['a', pair(12_000)]]), limits), true);
  assert.equal(hasViableDexPool(new Map([['a', pair(4_000)]]), limits), false);
  assert.equal(hasViableDexPool(new Map([['a', pair(12_000, 'v3')]]), limits), false);
  assert.equal(hasViableDexPool(new Map([['a', { ...pair(12_000), liqUsd: 40_000 }]]), limits), false);
  assert.equal(hasViableDexPool(new Map(), limits), false);
});
