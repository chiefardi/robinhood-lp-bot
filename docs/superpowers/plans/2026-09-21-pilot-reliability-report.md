# Pilot reliability implementation report

Date: 2026-09-21. Task 1 implementation on `codex/hunt-entry-pilot`.
Baseline: `9a9191e277370dee9decab83eaf1b24d50c67c2d`.

## Implemented

- Explicit persisted pause classification/revision; manual and legacy pauses are never converted to data permission. Subsequent operator pauses defeat awaited automatic recovery and explicit-resume funding checks. Data recovery requires at least three successful checks spanning 60 seconds, at least 20 seconds apart, with gaps over 90 seconds and process restarts resetting the streak.
- Recovery runs under the existing wallet lock after exit management, using latest/pending nonce equality, strict owned inventory, existing execution/exit intents, fresh open-position quotes, exit settings, the existing 0.0004 ETH gas reserve, current entry-size funding, and the read-only USDG funding/return preflight. It rechecks enable/config pause, session loss and pause revision before clearing. Recovery progress is in status; external errors are not copied into recovery status.
- Quotes retain the existing buffered `netUsd` arithmetic. Additive observations expose expected exit value after the same gas reserve, explicit slippage haircut, exact principal/accrued fee raw quantities, currency identities/decimals and pinned [lower, upper) in-range status. No additional fee-only route requests. Fee USD values are explicitly indicative allocations at the full-size route's average, not independent executable quotes or realized earnings.
- Position status/cash reports show expected/buffered value, observation freshness, actual settlement differences and sampled productivity. Close notices now use the final pre-close quote, not the initial loop mark. Large status/PnL reports are split on complete lines for Telegram transport.
- Bounded persisted exact-pool activity history: chain/version/full v4 pool ID, up to 512 pools and 128 observations per pool, 30-minute retention, no duplicate provider-observation timestamps. Repeated eligible snapshots across at least three observations and five minutes, without a six-minute sampling gap, get a soft preference in qualification batching and final dispatch. Final ordering uses the actual qualified pool's history. Unknown/new pools remain eligible under the existing gates.
- Hunt alerts replace heuristic score/FOMO claims with actual m5/h1 volumes and coverage/reason. Internal heuristic score and its existing gating role remain unchanged; unrelated screen/LLM behavior is unchanged.
- Sampled range productivity persists monitoring start, observed/in-range/unknown seconds, first observed in-range time and per-currency raw fee deltas. First sample is a baseline; fees already present are not monitoring earnings. Long gaps and every process restart interval are unknown. Reset/decreased fee balances or currency changes reset their fee baseline instead of recording negative accrual. In-range duration conservatively requires both adjacent observations to be in range.
- Invalid optional diagnostic metrics are discarded as unavailable and cannot disable an otherwise valid buffered SL/TP decision. Corrupt optional persisted diagnostics are likewise unavailable. Financial ledger corruption still fails closed. Position/pool identity and block/time regression remain validated; pool identity persists through diagnostic gaps.

## RED / GREEN evidence

1. Initial recovery/quote/notice run: 56 tests, 44 passing and 12 expected failures. Failures showed absent data-pause API, absent expected/haircut observation fields, and the old initial-loop estimate in the close notice.
2. Initial history/productivity run: six expected failures for missing persisted history, missing sampled productivity and missing observation validation.
3. Notification RED: one failure showed the old `80/100` / FOMO line instead of volume/history evidence. GREEN after rendering change.
4. Integrated focused checkpoint: 67/67 passed, including manual-pause race, restart/gap/config resets, fee baselines/resets, unchanged buffered quote arithmetic and final pre-close estimate.
5. Additional self-review RED cases: duplicate/unordered persisted history, explicit resume versus later operator pause, missing report chunking, malformed additive diagnostics blocking a valid SL, operator pause overwritten by uncertainty, pool identity lost across a diagnostic gap, impossible persisted sampled counters. All passed after bounded fixes.
6. Read-only recovery boundary tests cover owned-inventory failure, nonce mismatch/change, missing gas/funds, unavailable route, excessive existing round-trip loss threshold, stale prices/routes and invalid protection. No real RPC, wallet signing or Telegram sends were used by this implementation task.

## Final local verification

- `rtk npm test`: 239/239 passed, zero failed/skipped (full Node test suite).
- `rtk npm run typecheck`: exit 0.
- `rtk npm run build`: exit 0.
- `rtk proxy npx tsc --noEmit -p tsconfig.ops.json`: exit 0.
- `rtk git diff --check`: exit 0.

All five commands were rerun together against the final implementation tree before commit. The report is a documentation-only addition after that run.

## Safety and verification limits

- No configuration, signing, deployment, SSH, push, real Telegram message or wallet transaction was performed by this task. Existing dirty `src/types.ts` is excluded from staging and preserved.
- No entry amount, capital/slot/loss limit, security gate, activity floor, fee universe, TP/SL/trailing/timer parameter or exit decision policy was changed. No new entry rejection/wait gate, rotation, rerange, compounding, LLM or external dependency was added.
- Recovery behavior is tested offline; whether it has occurred live must be reported separately by deployment verification. Existing production legacy pause remains operator-only.
- Persistence means repeated provider snapshots, not independent/non-overlapping five-minute buckets, organic-volume proof or a profit guarantee. Sampling does not reconstruct exact historical range occupancy. Downtime/gaps have no fabricated activity or fee earnings.
- Existing funded-route preflight builds/simulates read-only route data; it does not guarantee a later fill. Expected and buffered valuations remain estimates, not settled cash. Historical cash basis/settlements are not backfilled or recomputed.
- Coordinator owns independent review and Task 2 deployment/preflight/resume. Keep branch/workspace as-is for that review.
