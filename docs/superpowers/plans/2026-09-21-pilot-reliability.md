# Pilot Reliability and Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement Chief's approved outage recovery, valuation transparency, persistent-activity preference and measured range productivity without changing the pilot's risk or entry thresholds.

**Architecture:** Extend existing typed cash-risk state and read-only quote observations. Recover only explicitly classified data pauses under the wallet lock. Keep execution protections and netUsd decisions unchanged. Maintain a bounded exact-pool activity history for soft ranking; display observable reasons instead of a misleading confidence score.

**Tech Stack:** TypeScript, Zod, ethers, Node test runner, existing JSON persistence and Telegram.

**Spec:** Chief approved the four numbered recommendations immediately before "Alright. Implement" on September 21. This document captures those requirements and concrete safety boundaries.

## Global Constraints

- Preserve $29 sizing, three concurrent positions, $90 outstanding basis, -$15 session loss circuit, security checks, volume floors, fee universe and all TP/SL/timer settings.
- Preserve unrelated dirty `src/types.ts`; never stage it. Do not change production configuration or send transactions during implementation.
- Missing evidence is unavailable, never fabricated zero. Keep USD entry and settlement cash records immutable.
- No LLM, automatic rerange, auto-compound, new rotation exit, new hard screening gate, external dependency or fee-profit guarantee.
- User-facing English only. Deployment is performed by the coordinator after review and read-only preflight.

## Task 1: Integrated pilot improvement

Implementation is one coordinated task because risk observations, pause state, reporting and management share interfaces. Four bounded modules may be committed separately, but review the entire integration before deployment.

**Files:**
- Modify `src/radar/auto-risk.ts`, `risk-manager.ts`, `automanage.ts`, `cash-report.ts`, `src/chain/v4/exit-quote.ts`, `src/telegram/auto-controls.ts` and existing notification consumers as needed.
- Modify `src/radar/fast-hunt.ts`, `scanLoop.ts` and exact candidate notification renderer.
- Create small focused recovery/history/productivity modules if needed; tests under `tests/`.

### A. Controlled recovery

- Add an explicit persisted pause classification/revision. `pauseEntries` remains manual/nonrecoverable by default. Add a dedicated data-pause API; repeated data failures must NOT overwrite an operator, uncertainty, configuration, loss or legacy unclassified pause.
- All direct risk pause assignments must clear or invalidate recoverability as appropriate. A subsequent manual pause during awaited recovery checks must defeat recovery, including same session identity.
- Old string-only pauses remain nonrecoverable. Do not infer historical permission from an English reason string. Existing production pause is preserved on deployment; operator can explicitly resume separately.
- While auto is enabled and config entryPaused is false, recover a *typed data pause* only after three successful health samples spanning >=60 seconds, spaced >=20 seconds, fresh at recovery. Any failure, gap >90 seconds, restart or changed pause revision resets the streak.
- Under the wallet lock check: latest/pending nonce equality, strict owned inventory matches tracked positions, no reserved/closing/uncertain entries or outstanding latched exits, valid exit settings, sufficient gas/entry funding and live read-only USDG funding/return route. Existing open positions all require fresh valid liquidation observations. Recheck enabled/config pause, revision and session loss after awaited work before clearing only the data pause.
- Never auto-clear session loss, operator pause, unknown execution, initial session pause or legacy pause. Existing exit retries continue regardless of entry pause. Emit/log recovery and reason/progress through status without logging credentials.

### B. Exit-value transparency (no decision change)

- Extend quote observations with expected net exit value before slippage haircut but after the SAME gas reserve, buffered netUsd, explicit haircut/reserve amounts, principal/accrued-fee token quantities and in-range status from the pinned current tick and [lower, upper) range.
- Do not add RPC requests merely to invent a fee-only sell price. Fee quantities are exact; any USD fee estimate using the full-size route's average execution rate must be labeled indicative, not an independently executable quote or realized PnL.
- Preserve existing netUsd arithmetic bit-for-bit where practical. TP/SL/trailing/session decisions continue to consume netUsd.
- Persist optional observation fields backward-compatibly; validate finite/nonnegative values, decimal raw quantities, consistent identity and monotonic block/time. Do not backfill new metrics for old trades.
- Show expected vs buffered valuation with freshness and actual settlement/estimate difference on current/recent position reports. Update close notification estimate to the final pre-close observation rather than the earlier loop snapshot.

### C. Sustained-activity preference

- Bounded exact-pool history, keyed by full pool identity, persisted for restart continuity. Record unique fresh provider observations; duplicate timestamps do not count. Expire observations older than 30 minutes; invalid/corrupt history falls back to unknown, never overrides eligibility.
- Prefer repeated eligible activity across >=3 observations spanning >=5 minutes, with no >6-minute sampling gap. Describe it as repeated snapshots, not independent/non-overlapping five-minute buckets or organic-volume proof.
- Apply preference through qualification batching AND final dispatch so later raw-volume sorts cannot silently undo it. New pools remain eligible; within equal history quality use current exact-pool volume. No new waiting/rejection condition.
- Candidate notification replaces the hunt confidence score with actual m5/h1 volumes, observation coverage and persistence/unknown reason. Keep any required internal score for compatibility clearly heuristic and unchanged in its gating role; do not alter LLM screens used elsewhere.

### D. Range productivity

- Persist per-position sampled activity from successful pinned quote observations. Record monitored start, observed interval seconds, in-range seconds, unknown/gap seconds, first observed in-range time and raw accrued fee deltas by currency.
- Count intervals only when ordered successful samples are <=90 seconds apart; label sampled estimate (not exact historical occupancy). Long gaps/restart downtime must not count as active earning time.
- First observation is a baseline, not fees earned during monitoring. Unchanged fees => measured zero accrual; decreased/reset balances or currency changes => unavailable/reset baseline, not negative earnings. Store raw integer fee units, decimals and symbols with asset identities.
- Display sampled in-range percentage with observation coverage and raw fee accrual/hour. Any USD conversion is indicative at current quoted rate and separated from realized settlement. No new automatic exit/rotation policy.

### TDD and verification steps

- [ ] Write failing behavioral tests for recovery classification, manual-pause race, repeated checks/reset, missing/uncertain inventory and fresh quotes.
- [ ] Write failing quote/report tests proving expected value is higher by explicit haircut while identical netUsd still triggers existing exits; final preclose estimate is used in notices.
- [ ] Write failing ranking tests: persistent lower-volume pool preferred over unknown spike, unknown pool eligible, pool identity isolation, stale/duplicate samples ignored, dispatch retains preference.
- [ ] Write failing productivity tests: first sample baseline; 60s known interval; >90s gap unknown; out-of-range excluded; regression/fee reset unavailable; restart continuity.
- [ ] Run focused test files, observe expected assertion failures, then implement minimal changes and run green tests.
- [ ] Run full `rtk npm test`, `rtk npm run typecheck`, `rtk npm run build`, `rtk proxy npx tsc --noEmit -p tsconfig.ops.json`, `rtk git diff --check`.
- [ ] Self-review and commit explicit paths only. Write report with RED/GREEN evidence and safety limitations to `docs/superpowers/plans/2026-09-21-pilot-reliability-report.md`.

## Task 2: Review and deployment (coordinator)

- [ ] Independent review with exact baseline/head diff; fix important findings and repeat scoped tests.
- [ ] Fresh live preflight: same session, no outstanding workflow/pending nonce, entries paused. Backup config/data and previous commit before stopping.
- [ ] Deploy tested commit, rerun server tests and both typechecks. Verify ledger cash amounts and settings unchanged. Do not migrate a legacy pause into recoverable state.
- [ ] Verify service, real report delivery and observational history; report whether live recovery has actually occurred versus tested offline. No forced trade as a deployment test.

## Progress and decisions

- Plan approved by Chief's implementation request; using existing pilot branch unless Chief selects isolation. Existing unrelated src/types.ts is excluded.
- A/B/D share quote/state APIs and must be reviewed together; C only affects soft order and notices. No threshold or protection-policy conflict found.
- Conservative deployment choice: historical string-only pause remains manual. Auto recovery applies to future explicitly typed transient data pauses only.
