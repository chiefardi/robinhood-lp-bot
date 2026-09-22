# Alexandria funding incident — 2026-09-19

## Root cause

On 2026-09-18 at 14:44:09 UTC, MONEY cleared screening and exact-pool gates.
`guardedEntry` reserved $29, then `openV4UsdgSingleSide` immediately threw because
`KYBERSWAP_ROUTER_ADDRESS` was unset. This occurred before the wallet was accessed
or any transaction broadcast. The generic post-reservation handler marked the
attempt uncertain and paused the session. Earlier verification covered scanning
and rejection gates, but failed to check this mandatory execution dependency.

The wallet remained at nonce 0, 0.041 ETH, zero WETH/USDG, and zero v3/v4 NFTs.
The incident-specific reconciliation script verifies those facts directly, pins
the wallet/session/attempt, and records proof rather than deleting the attempt.
The aborted attempt remains charged against all three-attempt/$90 pilot limits.
Reconciliation does not resume entries or permit resetting this pilot.

## Fix

- Pre-reservation funding checks: router configuration, deployed code, chain ID,
  exact input/output/amounts, quote/build, funding `eth_call`, reverse sale build,
  and freshness. A quoted funding round trip beyond the existing hard SL is rejected.
- Startup fails closed for missing router; `/auto resume` checks funding readiness.
- Actual swaps validate the fresh execution route/build too, not just a previous
  quote. Configured 0% slippage remains 0%, rather than silently becoming 5%.
- An isolated mainnet-fork lifecycle exposed a second bug: native-output balance
  delta was net of transaction gas, so a successful tiny USDG refund appeared to
  return zero. `amountOut` now adds the swap receipt fee back to obtain gross output.
  Cash-basis PnL still includes the actual wallet gas debit; fees are not hidden.

## Router verification and live read-only checks

Official [Kyber contract deployments](https://docs.kyberswap.com/developer-guide/aggregator-api/contracts.md)
list Robinhood chain 4663 MetaAggregationRouterV2 at
`0x6131B5fae19EA4f9D964eAc0408E4408b66337b5`. The live API returned the same
router and RPC confirmed its deployed code.

The $29 live funding probe at block 66932800 simulated ETH→USDG successfully,
built USDG→ETH successfully, and quoted approximately -0.0181% round-trip before
gas. It sent no transaction. PositionManager, StateView and Permit2 had deployed
code. Environment and ledger backups were taken before remediation.

## Verification scope

`ops/funding-probe.ts` is read-only. The reverse build is not an executed sale.
`ops/fork-lifecycle.ts` uses a disposable random wallet and Anvil bound to loopback
in a separate `/tmp` source/data copy. Production keys are forbidden. It exercises
funding, approvals, USDG-only mint, residual refund, cash basis, NFT inventory,
exit valuation, burn, sale back to ETH, and zero remaining inventory.

A complete Anvil lifecycle passed after the refund correction. Fork gas/fee
economics are approximate and must not be represented as realized live PnL.
No mainnet mint is proven by a simulation; the resumed scanner still has to find
a fresh candidate passing the unchanged safety gates (see the live result below).

Local verification: 175 tests passed; application and operations typechecks pass.
No screening, volume, holder-risk, position-size, loss, or total-attempt limits
were loosened. The already-approved pilot—not a new/recycled budget—is resumed
only after the final live probe, verified reconciliation, and ledger readback.

## Live result — 08:33 UTC / 15:33 WIB

Runtime commit `0e17485` was deployed, the MONEY no-broadcast incident was reconciled,
and the existing session resumed with its caps unchanged. URANUS passed current
GMGN/holder and exact-pool checks (5m volume $2,673; 1h $24,420; 7 buys/9 sells).
The $29 entry completed automatically at 08:33:01 UTC:

- [URANUS/USDG v4 position #2947439](https://app.uniswap.org/positions/v4/robinhood/2947439), 3.9% fee, single-sided.
- Recorded immutable cash basis: $29.127622 including entry costs.
- NFT ownership/inventory verified directly on-chain; wallet residual USDG/WETH zero.
- Automatic risk cycle wrote a fresh $27.297798 estimated liquidation mark at
  08:33:47 UTC. This estimate includes the configured swap haircut and exit buffer;
  it is not a realized sale or the Uniswap display value.
- Service active, zero restarts, session not paused, loss latch false.
- Original limits retained: one aborted attempt plus one open position, leaving
  one further attempt; $29 sizing, 10% SL, +10% trailing activation / 5pp giveback.

Protected environment/config/ledger backups remain on the host. The unrelated
local `src/types.ts` change was not staged or deployed. Subsequent uncertain entry
failures now generate a dedicated Telegram warning without echoing raw RPC URLs.
