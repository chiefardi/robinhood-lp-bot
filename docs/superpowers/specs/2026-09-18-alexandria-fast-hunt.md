# Alexandria five-minute hunt — approved pilot design

## Goal and boundary

Make the existing funded Alexandria Robinhood Chain pilot discover fresh, active Uniswap v4 USDG pools around the clock. Keep the existing cash-basis entry/exit path, strict inventory checks, GMGN security and holder rules, $29 size, three total entry attempts, $90 gross session reservation, at most three open, one attempt per hour, -$15 loss circuit, 10% stop and +10%/5-point trailing exit. No automatic session reset, no v3/ETH-quoted fallback, no LLM dependency, no forced trade when no candidate passes.

Chief approved implementation and funded activation within these limits on September 18, then explicitly chose to retain three **total** attempts rather than recycle closed slots. Thus “24/7” means continuous scan and management until the bounded pilot finishes, not unlimited re-entry.

## Diagnosis

The live service is active and scanning, but the current hunt uses GMGN's 24-hour token ranking and sorts a utility-favoring thesis score before querying exact pools. In the observed live window it repeatedly reconsidered the same few candidates, which failed exact-pool activity, holder coverage, or the score/action gate. The separate watch already uses a five-minute GMGN ranking, but selects a token's deepest DexScreener pool, requires $100k/5m and $1m/1h plus rising activity, and applies a v3 WETH round-trip test unsuitable as the sole discovery lane for v4 USDG LPs. Blockscout's HTTP 403 weakens UI portfolio enumeration but is not the observed entry blocker; strict RPC inventory stays mandatory.

## Design

1. The hunt queries up to 100 Robinhood tokens from GMGN's five-minute volume ranking, without selecting by utility/meme narrative. Preserve its current prefilter for explicit honeypot/tax/launchpad flags and market-cap bound. A failed GMGN call yields no candidate; it never bypasses safety.
2. For those tokens, inspect DexScreener Robinhood v4 USDG pairs. Prioritize by **exact-pool** five-minute volume, requiring valid five-minute and one-hour volume and both buys and sells. Keep existing 24-hour pool volume/fee and liquidity prefilters. On-chain qualify a rotating batch of at most 12 shortlisted USDG tokens per scan, with three concurrent RPC workers; recently checked tokens wait 15 minutes unless five-minute volume doubles, allowing lower-ranked tokens a turn without a 100-token RPC burst. Among a token's USDG pools, filter hook-free, 3–5% and current activity **before** selecting by 24-hour fee opportunity. Preserve the chosen pool ID through funded preflight.
3. Replace the fast lane's utility-weighted action score with a deterministic exact-pool activity score, where passing the existing hunt m5/h1 thresholds and two-way trades earns the minimum configured 75, and stronger recent volume ranks higher. This score is a traffic heuristic, not a safety verdict or profit prediction. The entry path must still independently re-fetch GMGN security/holders, exact-pool activity, pool identity/state, balances, inventory and quote freshness immediately before mint/broadcast.
4. Keep the watch path separate and unchanged. Do not turn down its thresholds or interpret its v3 swap simulation as v4 safety proof. Correct the hunt candidate's `vol1h` field to use exact-pool one-hour volume rather than the five-minute token-wide value.
5. Operationally verify clean tests/typecheck/build, a read-only live scan that reaches the exact-pool stage, chain 4663/wallet/ledger/exit supervision, then deploy this code to the existing systemd service. Enable funded entries only if these gates pass. Alert on scanner/risk-monitoring failure; preserve entry pause on uncertain financial state. Do not reset the ledger or touch untracked user changes.
6. Limit funded GMGN preflights to two fresh candidates per scan. Retry a rejected token after 15 minutes, or sooner only when its exact-pool five-minute volume doubles. This reduces repeated holder/security calls while allowing the next candidate to be evaluated. Distinguish ordinary no-pool rejection from DexScreener/RPC failure; alert on systemic lookup failure rather than reporting an ordinary empty scan.

## Acceptance checks

- A fixture with a busy v4 USDG pool omitted by the old utility score reaches qualification from the five-minute list; a high token-wide-volume token whose exact pool is quiet does not.
- Missing m5/h1 data or one-sided five-minute transactions fail closed; a qualifying pool is ranked by exact-pool activity, not token narrative.
- Live checks show the service remains active, scans continue, the risk manager polls, the risk ledger has at most three total attempts and $90 gross, and no unexpected transaction is sent during read-only validation.
- A real mint is **not** a success criterion. If no pool passes the unchanged security/holder/financial gates, the system must report that honestly while remaining armed and scanning.
