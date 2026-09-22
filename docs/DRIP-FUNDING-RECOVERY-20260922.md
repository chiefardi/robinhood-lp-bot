# Drip funding recovery and staged-entry repair — 2026-09-22

## Incident and receipt evidence

Approved response: Chief requested "FIX IT" after diagnosis of the Drip uncertain entry blocking two queued exits. No screening thresholds, allocation limits, or exit thresholds were loosened.

Session `9b1115a8-4ddb-4c4c-94bd-7d1bfe2d20d2`, attempt `22c507ad-3c25-44c1-abdb-039b3b7054a9`, Drip `0x6b1497cd68878f0b14ecbbd3db81b46103d66e3d`.

The Sep 21 23:48 WIB attempt bought Drip and USDG, then expired during Permit2 setup. No NFT was minted. Confirmed wallet nonces 80–82:

- Drip purchase: `0xb81974471dd71a54bda710ec07872436ef3bd466a2d7156adce5ce43a53358d0`
- USDG purchase: `0x59e0a365eb81364bd85db1706ed4a12a2be9bb10cc0acd8cbb33a5c2de20063b`
- USDG approval: `0x5176eb6940f39db29945525492666c12606ac9934d23a37c3845ee834d467e0f`

Before recovery, nonce latest/pending both 83; two known NFTs only. The exact purchase outputs remained in the wallet: 18,182.615805624370331648 Drip and 19.019722 USDG; WETH zero. Receipt/event identity, exact amounts, token transfer deltas, router, chain, wallet, and expected approval were verified.

## Recovery and realized outcomes

The stopped-service operator procedure acquired the bot process lock, backed up state, sold only the verified balances, and reconciled every recovery nonce including approval gas. Native balance delta matched trusted-router swap outputs minus all receipt gas exactly. Durable intent/progress files prohibit blind retry.

Recovery transactions, nonces 83–86:

- `0xc9f9cd46c242aa7c9c7d7971c080d217b8080edf31be5abf9a094c180b9ea43b`
- `0x49a8aad82991c9edc4650fd734a9898d7b0d8b390b133552347de5a9de2fad63`
- `0xfe521cc09366fc212709e943f048d36ab734dd33f89a0993977aac15d9dfe86c`
- `0x6ccf1e72465643a3ccd4495427a58361d00abb2ed5bb97ce3d2a93add28eac25`

Drip historical debit: 10,529,279,111,214,718 wei at entry ETH/USD 2762.98, basis **$29.092187598704044**. Net refund: 7,256,841,970,135,692 wei at settlement ETH/USD 2774.945, return **$20.13733734081819**. Realized loss **$8.954850257885854**, recorded as `ENTRY_ABORT`, not a fictitious LP or zero-cost aborted attempt.

Queued exits subsequently settled through the normal risk manager:

| NFT | Exit reason | Basis | Net settlement | Cash PnL |
|---|---|---:|---:|---:|
| CEREBRO 3046085 | TIME_TP | $26.4117865963 | $29.6751236252 | +$3.2633370288 |
| ASKR 3057429 | MAX_HOLD | $26.8838984961 | $28.7435351748 | +$1.8596366787 |

An early diagnostic restart interrupted a pre-broadcast ASKR close intent. It was explicitly reconciled under a stopped service only after unchanged nonce 87, no pending transactions, and both NFTs' ownership/liquidity were verified. No exit was blindly retried. Final deployment refuses to restart with any open/reserved/closing/uncertain record.

## Causes fixed

1. Discovery-time eligibility was reused throughout multi-transaction funding and approvals. Active in-range/asymmetric entries now refresh exact-pool/security observations at stage boundaries, without inventing new observation timestamps. Completed funding fixes its monetary basis; an already-executed funding simulation does not expire the subsequent approval stage.
2. A known typed eligibility rejection before any possible mint broadcast now compensates by selling only newly acquired balances. Refund receipts and restored token balances must confirm; otherwise the attempt remains uncertain. Actual pre-entry, pre-refund, and post-refund cash snapshots produce basis/refund separately. Pre-refund snapshot height is bounded by all observed unwrap, swap, ERC20, and Permit2 receipts. Original holdings are preserved.
3. RPC metadata failures previously cached `?`/18-decimal guesses permanently. Metadata reads now fail without caching fabricated values, allowing later reads to recover. This bug was separately blocking both queued exits.
4. Candidate qualification compared newly fetched observations to an earlier caller clock, falsely rejecting fresh data as future-dated. Evaluation now uses the clock after awaited reads, retaining original observation timestamps and the stale-data cutoff.

Unknown broadcasts, failed receipts, post-mint failures, operator stops, failed refunds, or failed cash/inventory verification remain fail-closed. No generalized blind transaction retry or bypass of unresolved-wallet accounting was added. The new automatic compensation applies to the active in-range/asymmetric mint path; legacy single-sided execution remains conservative.

## Verification and deployment

- Recovery ledger: `e75d516`; sanitized exit diagnostics: `212c8ec`; metadata cache fix: `c929466`; prevention runtime: `ebe4c7532318c22ad89ae891e73f6b6c664d55ef`.
- 278 tests pass locally and in VPS staging; TypeScript check passes both; local build passes. Regression failures were reproduced before repairs for stale funded entry, metadata poisoning, and qualification clock ordering.
- Independent review checked recovery receipt accounting and prevention transaction boundaries; its accounting and receipt-height findings were corrected before final deployment.
- Backups: `/opt/robinhood-lp-bot/backups/drip-funding-recovery-20260922/` (restricted permissions). Recovery scripts and sanitized receipt evidence retained in `/tmp/alexandria-drip-*`; local operators' scratch under `.superpowers/drip-repair-20260922/` is not committed.
- Resume preflight: no open/unresolved positions, exact NFT inventory empty, latest/pending nonce **97**, native **0.04206676929833309 ETH**, WETH/USDG zero, no loss circuit, valid exit settings, fresh funding simulation, session cash PnL **+$3.7504160630**. This is the entire existing session, not the three recovered outcomes alone.
- Existing pilot resumed with $29 size, three concurrent slots / $90 outstanding, unchanged fee band 1–5%, asymmetric range and TP/SL settings. No forced test entry, extra funding, or session reset.

Live recovery and exits are verified. The new future-entry compensation is regression-tested, not yet claimed to have executed on live funds after deployment. Provider outages can still pause entries safely.
