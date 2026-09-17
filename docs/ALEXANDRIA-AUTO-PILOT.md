# Alexandria Robinhood Auto — bounded pilot

This branch adds cash-basis trailing TP to the existing Robinhood LP Bot fork.
It does not activate trading, fund a wallet, deploy to a server, or implement a
full paper-trading engine. Tests use offline transaction/RPC boundaries.

## Controls and limits

- New sessions start paused. `/auto on` starts exit monitoring but leaves entries
  paused; `/auto resume` permits entries only after the protection checks pass.
- `/auto pause` pauses **new entries only**; exits continue while auto remains on.
- `/auto off` stops entries **and exits**. It does not close existing positions.
  It does not cancel a transaction already broadcast; an in-flight exit completes
  its asset sales so the wallet is not deliberately stranded halfway through.
- `/auto trail 10 5`: arm at +10% estimated cash PnL; close on a five-percentage-point
  drawdown from the observed peak. Example: peak +25% -> trigger at +20%.
  This disables fixed TP. `/auto tp 10` instead selects fixed TP and disables trailing.
- `/auto sl 10`: hard loss trigger at -10% estimated cash PnL. Changing protection
  pauses entries pending review/resume. A price gap, slow RPC or failed sale can
  produce a much larger realized loss; these are bot triggers, not guaranteed stops.
- `/auto session`: explicitly starts a new ledger only while auto is off and the
  previous session has no unresolved entries. Restarting the process does not reset it.
- Hard pilot limits: at most three total attempts, three open positions, one attempt
  per rolling hour, and $90 gross deployment reservations. Replacements count.
  Actual entry costs count toward remaining capacity: three exact $30 trades may not
  fit once gas is included. Reserve room for costs (e.g. roughly $29 per trade).
- The -$15 session loss circuit uses settled cash plus fresh liquidation estimates.
  It pauses entries and latches closes, but cannot guarantee a maximum realized loss.
- Review after two hours; this is an operator checkpoint, not an automatic timer.
- Compounding, automatic re-ranging, legacy OOR and fee-velocity exits are disabled
  for this bounded auto mode. Manual trading remains available when auto is off,
  no wallet operation is running and no uncertain execution needs reconciliation.

## Accounting and execution

`data/auto-risk.json` is the pilot's authoritative ledger, with immutable USD-valued
entry cash debits, reservation IDs, owned NFT IDs, peak PnL, close intents and settlements.
`/auto status` reports this ledger. Legacy `/ledger`, `/pnl` and profit cards are not
the pilot's cash-accounting source; upstream LP-versus-HODL reporting is unchanged.

Principal plus accrued fees are quoted for liquidation using pinned on-chain state,
full-amount sell routes, swap slippage haircuts and a configured gas reserve. The
estimate is not a guaranteed execution quote: removing the LP changes available
liquidity, token taxes can matter, and prices can move between transactions.

Strict mint and close preserve pre-existing token/USDG balances. Newly acquired
surplus and withdrawn non-ETH assets are sold back to ETH. Final cash snapshots
must include the final confirmed transaction block; receipt failures or changed
residual USDG cannot silently become a dollar PnL. Cash USD valuation uses the
fresh ETH/USD reference at the start of each entry/exit workflow.

Before an entry or close broadcasts, intent is persisted. If execution or final
accounting is uncertain, new entries and automatic retries are blocked. Restart
with a reserved/closing/uncertain record requires transaction-by-transaction
reconciliation. Do not delete the ledger or start a new session to clear this state.
The recovery procedure is deliberately manual: verify receipts, ownership,
liquidity and remaining token balances, then repair the specific ledger record
with evidence. There is no automatic unknown-transaction retry command.

Do not trade or transfer externally from the dedicated wallet during a workflow;
unrelated wallet flows would invalidate cash-delta accounting. Telegram manual
financial actions are blocked while auto is on or execution is unresolved.

## Entry screening and activation gates

Only exact, hook-free USDG v4 pools in the existing qualified 3–5% fee universe are
eligible. ETH-quoted/v3 fallback is blocked. Pool liquidity must be positive and
known; GMGN must explicitly report non-honeypot status and known taxes.
The approved rules-only pilot uses `token holders` (top 100 by total-supply share):

- At least 70% total-supply coverage, with valid distinct addresses, supply shares,
  vendor custody classifications and tag arrays. Missing/malformed data blocks entry.
- Observed normal-wallet supply tagged bundler, rat trader, sniper, dev team or
  creator is counted once. **All unobserved supply** is added to this tagged-risk
  amount; the resulting bound must be at most 30% of total supply.
- Vendor-classified pool/burn custody is excluded from normal-wallet concentration
  and tagged-wallet exposure, but is reported separately. It is not proof of safe
  custody or locked liquidity. Tradeable float below 2% blocks assessment.
- Largest observed normal wallet at most 10%; observed normal-wallet top ten at
  most 50%. Observed groups of two or more wallets sharing a reported native
  funder at most 20%. Shared funding is a risk flag, **not proof of common ownership**.
- Security and holder evidence must each be no older than 60 seconds, including
  at financial broadcast. Missing full-history linkage is not presented as known.

This replaces the earlier impossible required-field mapping. It screens vendor
labels and partial holdings, not complete beneficial ownership. Untagged linked
wallets, issuer/control privileges and incorrectly labelled custody can still be
missed. Historical launch bundles and bundler **volume** never become current
holdings. The old optional normalization fields no longer authorize entry.

Exact chosen-pool 5-minute and 1-hour volume must meet the configured watch
thresholds, with nonzero buys and sells in the last five minutes. Token-wide volume
is insufficient. These activity signals cannot establish organic volume by themselves.
The watch scanner discovers up to 100 Robinhood tokens from GMGN's five-minute
volume ranking on each pass, then reads each token's pools from DexScreener.
Unavailable discovery or a failed pool lookup is logged as a scan error. The
100-token ranking and two-minute scan cadence can miss short-lived surges; neither
is a market-wide guarantee.
GMGN requests are serialized and paced, with a five-minute cooldown on rate-limit
errors. Queued/stale or unavailable data blocks entry, not a safety bypass.

Chief explicitly selected rules-only on September 17: Alexandria uses
`requireLlm=false`. No model key is needed. A heuristic score is never presented
as a model verdict. Other deployments retain their configured LLM requirement.

Before live activation, separately verify:

1. Real GMGN holder response coverage and reject reasons; fixture tests alone do
   not establish that a live candidate passes the coverage-aware policy.
2. Correct chain 4663, wallet identity, fresh RPC/quote responses, and clean inventory.
3. Receipt-bound cash accounting and swap minimum outputs on the intended routes.
4. Available native gas, position sizing including fees, and an operator recovery plan.
5. Explicit approval for deployment, the chosen configuration and funded activation.

No configuration defaults enable auto or trailing. There is no LLM in the trailing
calculation; it is deterministic arithmetic.

## Verification

Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`.
Offline tests exercise persisted restarts, caps, missing state, trailing examples,
unknown transactions, screening failures, quote math, received-only asset sales,
receipt-block settlement, manual isolation, and English controls. They are not
evidence of profitable returns or successful live trading.
