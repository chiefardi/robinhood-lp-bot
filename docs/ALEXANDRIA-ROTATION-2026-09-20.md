# Three parallel slots and timed exits — 2026-09-20

Chief approved the following in this task, including application to already-open
ASKR #2948897: three concurrent distinct-token positions; $29 entries; $90
outstanding cost-basis cap; one entry per rolling hour; reusable settled slots;
unchanged cumulative -$15 session circuit, -10% SL and +10%/5pp trailing;
after 120 minutes, profit-taking at >= +5% estimated net; maximum hold 360 minutes.

## State and migration

No session reset or deletion. Existing entry times, cash basis, peaks, closed
settlements and the verified never-broadcast MONEY record remain in the ledger.
Only the capacity calculation changes from lifetime attempts/turnover to
outstanding reservations and cost basis. Unknown execution still blocks all
entries/retries. No manual recovery of unknown financial state is added.

Code defaults keep new timers off; activation explicitly sets 120/5/360. Before
activation: protect a backup of live config/ledger, confirm the bot is not in a
financial operation, stop the service, verify wallet/chain/inventory/funding and
fresh liquidation quotes, persist settings, evaluate existing positions against
their original timestamps, and only then explicitly resume the existing session.
If a close is latched, entries remain blocked until confirmed cash settlement.
Restarting the service executes the approved exit through its regular strict
burn-and-convert-to-ETH workflow. No separate manual sale path is introduced.

## Verification required

- Three concurrent slots, fourth rejected; confirmed close permits replacement.
- Aborted audit preserved without consuming a slot; uncertain/closing never free it.
- Outstanding basis includes entry costs; appreciated market value does not force sale.
- Historical losses accumulate across more than three attempts and retain the $15 latch.
- Exact 120-minute/+5% and 360-minute boundaries; restarts retain deadlines.
- SL/trailing priority, fresh-quote-only retries, correct notifications and status.
- Full unit suite, app/ops typechecks, build, independent review and live readback.

These are experimental settings, not evidence of profitable expected returns.
