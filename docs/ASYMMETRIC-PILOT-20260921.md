# Approved asymmetric entry pilot

Chief approved replacing new single-sided entries with two-sided asymmetric entries.
Existing positions, $29 size, three simultaneous positions, $90 outstanding basis,
-$15 session circuit, screening and all exit settings remain unchanged.

## Implementation

- New opt-in `autoLp.mode=asymmetric`; defaults remain single. Existing centered
  `inrange` mode remains available and unchanged.
- Target range is 0.80 to 1.10 times spot expressed as USDG per token. Convert using
  actual sqrt price and currency order, then round outward to legal ticks. Coarse
  tick spacing widens the actual range; ticks in the entry notice are authoritative.
- Funding split follows the tick-derived liquidity amounts, not a fixed 50/50.
  Same arithmetic is used in preflight and mint funding. Both ETH buy legs are
  simulated and both return routes built before reservation. Sale builds are not
  sell simulations and do not guarantee future exit execution.
- Combined quoted round-trip loss plus the existing gas reserve must remain below
  the existing stop-loss percentage. This is a quote check, not a profitability
  prediction; actual swaps still use existing slippage protections.
- After buys, recompute the target range around fresh pool state for the new NFT.
  Unused newly acquired balances are swept; pre-existing inventory is untouched.
  Changing entry mode mid-flight invalidates broadcast permission.
- New deposits retain `mode=inrange` for legacy readers and record
  `entryStrategy=asymmetric`. Entry notifications identify the strategy. No position
  is automatically re-ranged, topped up, compounded, or migrated.

## Verification before review

- RED: three absent geometry/funding APIs, asymmetric mint incorrectly centered,
  four auto-routing cases using a single funding leg/wrong mint path, and incorrect
  parked-USDG notification. GREEN after implementation.
- Geometry checks both currency orders, outward tick rounding, fractional price,
  invalid state. Real SDK mint fixtures cover both orderings and post-funding price
  movement, exact budget split, and preserving original token/USDG balances.
- Funding failures and excess costs block reservation; mode changes block execution.
- Full suite 252/252; main typecheck, build, ops typecheck and whitespace checks pass.
- No deployment or new-mode live execution at this checkpoint. Independent review
  and deployment receipt follow separately.

## Deployment receipt — 2026-09-21

- Independent review of `78ef493..3a28b48` found no critical/important blockers.
  Minor known limitation: Telegram `/set alpmode` still exposes single/inrange;
  asymmetric is operations-configured for this pilot, not a new chat control.
- Local and separate VPS staging: 252/252 tests, main typecheck, build, and ops
  typecheck passed. Staging tests ran while the old service managed the open NFT.
- Representative ASKR route probe: both buys simulated and both returns built;
  estimated combined round-trip cost plus gas reserve 1.1394%. No transaction
  broadcast. This was route readiness, not a pool eligibility or profit verdict.
- Runtime `3a28b48398409d939f2f22ae5eae86b208c39146` deployed on Tencent
  Alexandria. Only persistent configuration change: `autoLp.mode` from `single`
  to `asymmetric`. All capital, selection, and exit settings unchanged.
- Before the brief restart, backed up config/data in root-only
  `/opt/robinhood-lp-bot/backups/asymmetric-20260921-activation/state-before.tgz`.
  Stopped-service wallet health, fresh exit quote, nonce and ledger checks passed.
  No financial ledger mutation was needed for activation.
- Readback verified original position data unchanged and immutable session cash
  history unchanged. Existing ASKR NFT `3031196` remains open with original
  $29.093990135991 basis and fresh available exit valuation. Session unpaused,
  no entry blocker, service active/running with zero automatic restarts.
- Updated Telegram `/auto status` delivery acknowledged, zero transport failures.
- No asymmetric live mint has yet been observed; existing real-SDK fixtures and
  read-only live route checks do not constitute a completed new-mode trade.
