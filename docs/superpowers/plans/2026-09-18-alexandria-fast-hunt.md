# Alexandria Five-Minute Hunt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the bounded Alexandria pilot an exact-pool, five-minute-volume discovery lane that can feed its existing autonomous LP entry and exit controls.

**Architecture:** Reuse GMGN token discovery and DexScreener pool enrichment, but rank the hunt by exact-pool recent activity before on-chain qualification. Keep the existing strict entry, risk ledger, and exit logic untouched. Deploy only after local and read-only live verification.

**Tech Stack:** TypeScript, Node 20+, `node:test`, ethers, GMGN CLI, DexScreener, systemd.

**Spec:** `docs/superpowers/specs/2026-09-18-alexandria-fast-hunt.md`

## Global Constraints

- Robinhood Chain ID 4663; exact hook-free Uniswap v4 USDG pools with fee 3–5% only.
- Entry $29; at most three total attempts, three open, one attempt/hour and $90 gross per session; no automatic reset or recycling.
- Preserve GMGN explicit non-honeypot, known tax, top-100 holder coverage and concentration checks and the exact-pool m5/h1/two-way activity recheck.
- Preserve the 10% cash stop, +10% activation/5-point trailing exit, -$15 session circuit, strict inventory and uncertain-transaction fail-close.
- Rules-only; no LLM key. Do not touch the user's existing `src/types.ts` edit or change the watch lane.

---

### Task 1: Five-minute token shortlist

**Files:** Modify `src/radar/screen.ts`; test `tests/fast-hunt.test.mjs`.

**Interfaces:** `screenTokens({interval:'5m', minVolume:0, limit:100, rankBy:'volume', llm:false})` returns a volume-ordered `ScreenResult[]` after the existing explicit unsafe/launchpad filters. `rankBy` defaults to the existing score sort for `/screen` consumers.

- [ ] Write a failing `node:test` case in `tests/fast-hunt.test.mjs` using a local injectable trending function returning two complete GMGN rows: a high-five-minute-volume meme and a lower-volume utility. Assert the meme is first with `rankBy:'volume'`, both are returned, and the call requested `interval:'5m'` and `limit:100`.
- [ ] Run `node --import tsx --test tests/fast-hunt.test.mjs`; confirm the failure is missing `rankBy`/injection behavior rather than malformed fixture data.
- [ ] Add the narrow screen option and trend injection with the existing GMGN function as default; preserve default score sort and prefilters.
- [ ] Re-run the focused test and existing screen tests; confirm zero failures.
- [ ] Commit only Task 1 files with message `feat: rank fast hunt by five-minute token volume`.

### Task 2: Exact-pool ranking and fail-closed activity

**Files:** Create `src/radar/fast-hunt.ts`; modify `src/radar/scanLoop.ts`; test `tests/fast-hunt.test.mjs`.

**Interfaces:** `rankExactPoolCandidates(rows, pairsByToken, limits)` returns descending `Array<{result:ScreenResult; vol5m:number}>`. It accepts only Robinhood v4 USDG Dex pairs satisfying the existing 24-hour viability check, known m5/h1, both buy/sell counts, and hunt activity floors. `fastPoolScore(pool, limits)` returns 75–100 on passing exact-pool data and `null` otherwise. `scanLoop` examines up to 100 ranked tokens via bounded Dex lookups, on-chain qualifies a rotating batch of at most 12 with three concurrent workers, then calls `qualifyCandidate(token, undefined, 'usd')` and re-scores its selected exact pool. `evaluateCandidatePools(..., 'usd')` and funded preflight share that USDG-only selection.

- [ ] Write failing focused tests: a high token-wide-volume/quiet-pool token is excluded; a meme with an active v4 pool is first regardless of its utility score; missing activity/one-sided trades are excluded; an exact pool at the configured floors receives score 75; a busier pool scores higher; a v3 pool never qualifies; a busier ETH pool cannot displace a USDG pool in USDG-only qualification.
- [ ] Run the focused test and confirm those behavioral assertions fail against the missing implementation.
- [ ] Implement the pure ranking/scoring functions, then wire them into `performScan` without changing watch. Keep lookup concurrency bounded and retain the single-flight scan guard.
- [ ] Re-run focused tests, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`; resolve any failures before progressing.
- [ ] Commit only Task 2 files with message `feat: prioritize exact v4 pool activity for auto hunt`.

### Task 3: Candidate semantics and operational handoff

**Files:** Modify `src/telegram/pipeline.ts`; test `tests/fast-hunt.test.mjs`; update `docs/ALEXANDRIA-AUTO-PILOT.md`.

**Interfaces:** The hunt candidate passed to `maybeAutoLp` carries `vol1h: pool.volH1` and the exact-pool activity score/action. The funded preflight remains the authority for entry. The operator doc states 24/7 monitoring with three total attempts, not unlimited rotation.

- [ ] Write a failing test around a pure candidate builder (or injected pipeline boundary) proving `vol1h` equals the exact pool's one-hour volume, not GMGN's selected-interval volume.
- [ ] Run the focused test and observe the mismatch.
- [ ] Make the smallest pipeline fix and document bounded 24/7 behavior.
- [ ] Re-run focused tests, full tests, typecheck, build and diff check.
- [ ] Commit only Task 3 files with message `fix: pass exact-pool activity to auto entry`.

### Task 4: Read-only live verification and bounded deployment

**Files:** No source edits unless verification exposes a defect; deployment uses the existing Alexandria host and service.

**Interfaces:** Deployed commit hash and the live systemd service match; the existing funded ledger is not reset. Dry-run/scan checks must send no transaction.

- [ ] Inspect the current branch diff, pre-existing `src/types.ts` edit, remote branch, and running VPS commit. Do not merge or stage unrelated files.
- [ ] Verify local `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` with fresh output.
- [ ] Run a read-only live scan/market-data preflight; verify at least one five-minute scan traverses the exact-pool stage, or report an external data limitation. Verify chain ID, wallet address, session entries, funding/gas, and strict inventory before activation.
- [ ] Deploy only the reviewed commit to the existing service, restart via its systemd unit, and confirm active state, restart count, deployed SHA, scan cadence and risk-cycle cadence. Preserve the existing `.env`, `config.json`, `data/auto-risk.json` and service wiring.
- [ ] Check after activation for a valid entry or an evidence-backed no-entry reason. Never claim a live trade unless a receipt and ledger record match; never send a test trade just to satisfy the acceptance check.
