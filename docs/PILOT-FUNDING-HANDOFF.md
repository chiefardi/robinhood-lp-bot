# Alexandria rules-only pilot: funding handoff

## Scope

Robinhood Chain (4663), native ETH funding. Dedicated experiment wallet only.
Total intended funding: approximately $100, not $100 per position. Funding does
not activate the bot. Never send from an unsupported network simply because the
hex address matches. Check the bot's `/wallet` output before transferring.

Staged settings:

- $29 per entry; three total attempts, including failed/uncertain attempts and
  replacements; at most three open positions; at most one new attempt per hour.
- $90 gross session cap (actual costs count); remaining cash is a gas/cost buffer.
- Single-sided USDG range below token spot, exact hook-free Uniswap v4 pool only,
  static 3-5% fee. The range is generated from pool ticks, not a fixed -35/+25% band.
- Hard SL trigger -10% on estimated liquidation value versus immutable entry cash
  basis. Trailing arms at +10%, triggers 5 percentage points below the observed
  peak. Fixed TP disabled. Fees are included in exit valuation.
- Session loss circuit -$15. These are triggers, not guaranteed realized limits.
- Management poll 30 seconds; price spikes between observations can be missed.
- Entry activity: exact-pool volume at least $500k/5m and $1m/1h, two-way 5m trades,
  reported pool liquidity at least $50k; token tax ceiling 5%.
- Rules-only screening; coverage-aware holder checks documented in the pilot guide.
- No compounding, re-ranging, automatic replacement or legacy OOR exits.

These are experimental controls, not evidence of positive expected return. High
fees and short-lived volume do not guarantee profitable exit liquidity.

## Sequence after deployment verification

1. Service must be healthy with auto **OFF**, entries **PAUSED**, zero unresolved
   executions, and an initialized empty session. Do not reset an active session.
2. Chief funds the dedicated wallet with about $100 of native ETH on chain 4663.
   Obtain current ETH/USD first rather than reusing a stale ETH quantity.
3. Recheck on-chain balance, chain, inventory, fresh data and exit routes after
   deposit. Do not claim funded mint/close verification from offline tests.
4. Explicit activation is separate: `/auto on` starts real exit monitoring while
   entries remain paused; `/auto resume` permits real entry spending.
5. `/auto pause` stops new entries but leaves exits running. `/auto off` also stops
   exits and DOES NOT close positions. Use pause if existing positions need protection.
6. Review after two hours from activation. Three attempts are a session lifetime
   cap, not a rolling daily allowance. Do not delete the ledger to bypass a block.

Actual execution failures or uncertain settlement require receipt-by-receipt
reconciliation; there is no blind retry. Keep the wallet isolated from unrelated
transfers or manual trades during an entry/exit workflow.
