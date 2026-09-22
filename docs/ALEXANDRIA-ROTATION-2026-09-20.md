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

## Live verification — 03:06 UTC / 10:06 WIB

- Runtime `a8973cd` deployed on Tencent `meridian-b`. Protected pre-deployment
  config/data backup: `/var/backups/robinhood-lp-rotation-20260920/` (root-only).
- 186 tests, app/ops typechecks and local build passed; server suite/typechecks
  also passed. Independent review identified and verified the fix for stale
  liquidation quotes during serial closes. Each close requotes before intent;
  the quote timestamp is checked again after awaited preflight, just before burn.
- Service restarted at 03:04:52 UTC, active with zero restarts. Timers 120/5/360,
  $29 sizing, three parallel slots and $90 outstanding basis verified live.
- Session `9b1115a8-4ddb-4c4c-94bd-7d1bfe2d20d2` and all three historical records
  preserved. ASKR #2948897 closed via the regular manager with `MAX_HOLD`.
- Recorded basis $29.1654287803; realized net ETH cash valued at the exit reference
  $34.1728971055; realized PnL +$5.0074683253 (+17.1691915%). Historical URANUS loss
  remains -$1.5922213153; cumulative settled session PnL is +$3.4152470100.
- On-chain burn and both asset sales have receipt status 1:
  - [NFT burn](https://robinhoodchain.blockscout.com/tx/0x95a732603e551913e12c3b721a6075ad6672c96cb70e571726ceaa2032a50f0b), block 67604798.
  - [USDG sale](https://robinhoodchain.blockscout.com/tx/0x82c25ce9d7ee96f38a7f2b31843a1c165e1f34fe7f829213029c94e2277f25e4), block 67605161.
  - [ASKR sale](https://robinhoodchain.blockscout.com/tx/0xc4eea086aa73c3d7c980c0b8dc456ba3522f944ae69f3b411c16e66afbb6d085), block 67605249.
- Wallet nonce 20 confirmed/pending, NFT count and ASKR liquidity zero; residual
  USDG and ASKR balances zero at block 67605668. Native ETH 0.042606425872467194
  before any subsequent entries. Ledger closed, no pause, entry gate allowed.
- Updated slot/trailing/timer status delivered to the existing Telegram destination.
  No position was forced to fill a slot; screened entries retain one-per-hour pacing.
