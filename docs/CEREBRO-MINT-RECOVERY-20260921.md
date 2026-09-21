# Confirmed mint cleanup incident

At 13:42:32 UTC CEREBRO entered the two-sided 2% fee execution path. Nine
successful wallet transactions (nonces 58-66) funded both assets, approved the
mint, minted NFT 3046085, and sold unused USDG. At 13:43:20 the original activity
snapshot exceeded 60 seconds; reusing the entry guard for the remaining CEREBRO
sale threw `exact pool activity stale or missing`. The risk reservation became
uncertain before NFT/cash-basis commit, leaving this live NFT outside exit management.

## Correction

Separate cleanup permission is used only after a validated confirmed mint. It
retains operator enable/pause, session loss and reservation checks but does not
require the original entry activity/security/funding snapshots to remain fresh.
Pre-buy and pre-mint eligibility checks remain unchanged. Exact acquired-only
leftover limits, fresh swap route/build/simulation, and receipt accounting remain.
Tests reproduce entry expiry during actual SDK mint cleanup and operator stops.
263 tests pass locally and on VPS; main/ops typecheck and local build pass.
Independent review found no blockers after binding recovery to the mint receipt.

## Recovery evidence

- Scanned timestamp-bounded full chain blocks, fetched and verified all nine
  contiguous successful wallet receipts, nonces 58-66. Current nonce was 67.
- Verified mint transaction targets PositionManager and contains ERC721
  Transfer(ZeroAddress, wallet, 3046085), plus current owner and nonzero liquidity.
- Decoded the trusted router's Swapped events, matching sender/receiver, input,
  output and exact spend. Historical debit is native funding plus receipt gas,
  less the recorded native return from unused USDG.
- Used actual ERC20 mint transfers, not rounded SDK display amounts. CEREBRO's
  actual debit was one raw token unit above its SDK display amount. The observed
  leftover exactly matched purchased minus deposited: 230651508186761390008 raw.
- Historical RPC state and debug tracing were unavailable. Recovery uses verified
  transaction receipts/events and current balances, not claimed archive readback.
- Sold only this leftover through the existing strict Kyber swap path. The before/
  after ETH balance delta includes approval/swap gas. CEREBRO/USDG/WETH balances
  were then zero and strict NFT inventory matched only 3046085.
- Cleanup transaction:
  0xf55127b6c4d80151a9c0dc2d9ddc21fd74244ba9339f8fe208ed18d287465eb7.
- Reconstructed fixed entry ETH/USD from the immutable reservation sizeUsd/sizeEth.
  Final cash basis: $26.411786596322553. Operator-only recovery attached receipts,
  retained original entry timestamp, and kept entries paused pending monitoring.

Runtime 424d589a187d79c269220b6d1294599378fd661c deployed. Backup is root-only
/opt/robinhood-lp-bot/backups/cerebro-cleanup-repair-20260921. Fresh live manager
valuation was available ($26.2040 buffered liquidation estimate); fresh funding,
inventory, session-loss and nonce checks passed, then entries resumed. No NFT
range, size limit, screening threshold or exit rule changed. Receipt-based recovery
does not guarantee a future entry can never encounter an external execution failure.
