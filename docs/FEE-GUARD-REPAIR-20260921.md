# Fee guard incident and recovery

The scanner floor was changed from 3% to 1%, but validateEntryBudget retained a
hardcoded 3% floor. At 09:29:15 UTC CEREBRO's 2% pool passed initial screening and
funding simulation, reserved an entry, then synchronously failed `invalid strict
pool` before wallet access. The generic failure path retained an uncertain entry.
This blocked new entries and also blocked the later queued ASKR MAX_HOLD exit.
The earlier configuration-only completion claim was incomplete.

## Repair

- Execution fee floor now 10,000 ppm, ceiling unchanged at 50,000 ppm.
- Real SDK/mint tests reproduce failures at 1%, 1.9%, 2% before the fix and pass
  after it; 3%/5% pass, below 1% and above 5% reject without swaps/broadcasts.
- Candidate copy distinguishes initial screening from final entry approval.
  Hunter command responses use the actual configured band, not hardcoded 3-5%.
- Operator-only no-broadcast reconciliation supports a nonzero unchanged nonce
  for a reviewed synchronous guard rejection. It preserves the aborted entry,
  attaches evidence, and keeps entries paused. It is not automatic reconciliation.

## Evidence and limits

Runtime 3a28b48398409d939f2f22ae5eae86b208c39146 and incident logs were reviewed:
the throwing guard executes before wallet() and all funding/mint operations.
Recorded pre-attempt deployment observation had nonce 53. Fresh confirmed/pending
nonce remained 53; CEREBRO balance was zero; strict inventory matched ASKR only.
Historical RPC state queries failed because the RPC was not archival. The stored
proof is an operator attestation corroborated by those observations, not a claim
that historical balances or a complete explorer transaction history were fetched.

Independent review found no blockers for this explicitly operator-only workflow.
260 tests passed locally and on the VPS; local main and ops typechecks/build pass.
Runtime d835f1613a111594c2492aa203fbb4b02ad02b1c deployed. Root-only backup:
/opt/robinhood-lp-bot/backups/fee-guard-repair-20260921/state-before.tgz.

The CEREBRO attempt was retained as aborted, with every other entry unchanged.
The existing manager then completed ASKR #3031196's queued MAX_HOLD exit:
$29.093990135991 basis, $30.697479229055684 settled cash value. No new exit rule
was introduced and no manual forced trade was sent. Following settlement, fresh
wallet inventory, nonce, funding, session loss and configuration checks passed.
Entries resumed with no blocker; asymmetric mode, $29 size and all other limits
unchanged. No lower-fee live mint is claimed by these checks.
