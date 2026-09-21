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
