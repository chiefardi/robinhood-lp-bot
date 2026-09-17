# Rules-only pilot: live validation, 2026-09-17

## Verified change

Chief approved rules-only screening. Alexandria's existing configuration now has
`autoLp.requireLlm=false`, `autoLp.enabled=false`, and `autoLp.entryPaused=true`.
No other configuration was changed. A root-only configuration backup was verified
before the change. The running service loaded the changed configuration successfully.
The server test suite passed 110/110 tests after the change.

The wallet remains unfunded with nonce zero on chain 4663. No auto session was
initialized and no transaction was sent. Stop-loss and trailing activation settings
are still zero; this is not an activated or fully configured trading pilot.

## Root cause

The adapter expects `current_linked_holding_rate` and
`current_bundler_holding_rate` in token security responses. Neither appeared in
the sampled live responses. The current entry guard therefore cannot pass these
samples. This is an integration limitation, not an API authentication failure.

GMGN documents `stat.top_bundler_trader_percentage` as a **volume** ratio. It is
not a substitute for current supply held. Historical `bundler_rate` is also not a
current-holdings substitute. No fallback mapping was introduced.

Sources inspected:

- https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-token/SKILL.md
- https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-holder-analysis/SKILL.md

## Read-only holder probes

Observed 08:24:27-08:24:43 UTC. These are vendor-reported snapshots, not current
recommendations or on-chain ownership proofs. Queries used the documented CLI,
limit 100, sorted by supply share, separately for all holders, bundlers and rat
traders. Heavy requests were paced; earlier unpaced attempts hit rate limits.

| Token | Reported holder count | Top-100 supply coverage | Reported bundler wallets | Returned bundler rows |
| --- | ---: | ---: | ---: | ---: |
| PONS | 96,060 | 69.57% | 1,000 | 100 |
| GOOGL | 65,556 | 92.97% | 181 | 100 |
| musebook | 7,866 | 68.69% | 3 | 3 |

Responses contained a `list` without a pagination cursor or completeness proof.
A matching count for musebook does not prove complete linked-wallet coverage.
GMGN tags also appeared on rows marked as DEX/pool addresses: summing every
bundler-tagged row would misstate normal-wallet exposure. For example, GOOGL's
returned tagged rows represented 46.44% of supply in aggregate, but only about
0.0965% was on rows classified as normal wallets (`addr_type=0`). Do not treat
pool custody as proof that a bundler controls those tokens.

## Historical activation boundary at 08:24 UTC (superseded below)

Rules-only removes the LLM-key dependency, not the security checks. The existing
unknown-exposure block remains in force. Replacing it with a documented,
coverage-aware tagged-holder/concentration policy requires an explicit policy
decision: observed tags and common-funder evidence are not complete beneficial-
ownership detection. Missing coverage must never be presented as zero exposure.

Before activation: settle that policy and test its implementation; explicitly set
the pilot exit parameters; initialize the session; verify funded balances and gas;
obtain funded-activation approval. None happened during this configuration change.

## Follow-up candidate at 08:54 UTC

Chief authorized continuing through funding readiness. The replacement policy is
documented in ALEXANDRIA-AUTO-PILOT.md: partial vendor-tagged holdings with every
unobserved token included in the risk bound, plus concentration and shared-funder
flags. It does not claim full linked-wallet ownership detection.

Staged live code successfully read the documented holder endpoint. PONS had 69.59%
coverage and was rejected; musebook had 68.92% and was rejected. GOOGL had 92.91%
coverage, 8.03% tagged-risk-plus-unobserved bound, and passed the holder gate only.
This is not a trade recommendation or proof that any exact pool passes all gates.
