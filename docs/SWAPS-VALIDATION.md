# Swap implementation validation — 2026-09-18

## Published SDK 0.2.0

[`@polygonlabs/oms-server-wallet-sdk@0.2.0`](https://www.npmjs.com/package/@polygonlabs/oms-server-wallet-sdk/v/0.2.0) was published with public access and the `latest` tag at **2026-09-18T11:04:17.081Z**, at the package owner's request. It includes the complete Trails workflow and the Workers native-fetch fix.

- Runtime source: merged master `8c6c75beacafe069358d1bcebfcbb2e72e9068cd`; [CI passed](https://github.com/0xsequence-demos/waas-server-wallets/actions/runs/35333216609).
- Archive source: `a2201bdb413ab36ead938923472cd7f17796052a`, which only refreshes the package README relative to that master commit.
- Integrity: `sha512-txtCBkHYmg+6Nc5MRXyBqcqONdmIji2fgIsdVPEsqunrNw//fAo8k2Kzh9rcUUiWnXW2Qp7j/jn38h/wWf/b1g==`.
- [Registry archive](https://registry.npmjs.org/@polygonlabs/oms-server-wallet-sdk/-/oms-server-wallet-sdk-0.2.0.tgz): 57 files, matching the locally inspected archive byte for byte.
- Before publication: `pnpm test:package` passed at `2026-09-18T11:01:20.788Z`.
- After publication: a new external consumer installed the exact version by registry name and passed ESM imports of root and `/trails`, strict NodeNext compilation, quote/recovery codecs and encrypted storage checks at `2026-09-18T11:05:58.415Z`. Registry metadata, downloaded tarball integrity, lockfile integrity and all 57 installed files matched the inspected release.

The registry consumer had a temporary [pnpm release-age exception](https://pnpm.io/settings/dependency-resolution#minimumreleaseageexclude) for only `@polygonlabs/oms-server-wallet-sdk@0.2.0`, after its downloaded archive passed integrity verification. Other dependency checks and machine/repository settings were preserved. Local reports are `.data/sdk-release/validation.json` and `.data/sdk-release/publication.json`; they are not committed.

The demo is deployed with swaps enabled, and the operator reports successful swaps. The detailed funded acceptance matrix, including recovery scenarios, still needs scenario-specific evidence. Publication verification sent no funds and made no live signing, activation or recovery calls.

## Historical deployment correction

The deployment follow-up installed the missing Trails secret and applied `0002_swaps.sql`. It also reproduced and fixed native `fetch` receiver failures in Workers, which the original injected-fetch tests did not exercise. The corrected SDK was an unpublished 0.2.0 candidate at that point; no funded acceptance was performed during that follow-up.

The corrected candidate passed clean-consumer verification at `2026-09-18T07:25:21.269Z`, with integrity `sha512-0Bk5WeVytupVa5B1FuhTLR4X6aq0K3F3YsGBFvo1H2kLByGKOQszWE2M+ByGGgEKWyMst9BUk8krry1Brai0UA==`. The published archive above supersedes this candidate after the package README refresh. Typecheck/lint, 179 Node/API tests, 13 Workers tests, SDK/UI builds, packaging and Worker dry-run passed. The four new Workers regressions preserve native receiver checks rather than replacing fetch with an arrow-function fixture.

## Original preparation report (historical)

The SDK, backend and dashboard implementation is complete on `feat/trails-swaps-complete`, based directly on merged `master` commit `41eb93f`. This report records local verification of that implementation. SDK publication, Cloudflare deployment and funded acceptance are deliberately deferred to the package owner's next session. Nothing in this preparation sent funds or signed a live recovery authorization.

## Automated and local checks

| Check                                                   | Result                                                                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| TypeScript, ESLint, SDK and dashboard production builds | Passed                                                                                                                                     |
| Node/API regression suite                               | **179 tests**, 14 files, passed                                                                                                            |
| V8 coverage                                             | **90.24% statements, 84.27% branches, 94.92% functions, 91.09% lines**; enforced thresholds passed                                         |
| Workers runtime suite                                   | **9 tests**, 3 files, passed in workerd                                                                                                    |
| Browser suite                                           | **10 tests passed** with Nix Chromium; existing wallet/history flows plus swap review, confirmation, progress, recovery and session expiry |
| Worker dry-run                                          | Passed; **2019.19 KiB**, **343.02 KiB gzip**; no deployment                                                                                |
| Real Node development server                            | Temporary SQLite database migrated through version 2; login, wallet catalog, swap configuration and logout passed; process stopped cleanly |
| Standalone SDK archive                                  | Installed outside the workspace; ESM imports, strict NodeNext types, quote/recovery codec and encryption smoke checks passed               |
| Candidate-file credential scan                          | No local application/OMS/Trails credentials found; `.env` remains ignored and unchanged                                                    |

Coverage measures SDK/shared backend code; browser and Workers suites are separate. The Node startup smoke used a temporary database and `API_PORT=28787`, preserving the development database and normal port 8787. Browser fixtures intercept API responses; they do not establish live swap success. This machine needs Nix Chromium via `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`, rather than Playwright's downloaded Linux binary.

Failure coverage includes lost activation/submission responses, uncertain debit reconciliation, a crash between child submission and parent commit, expiry, duplicate intent IDs, debit conflicts with legacy operations, feature pause/disable, chain mismatches, insufficient balances, sponsorship refusal, incorrect calldata/recipients, partial refunds, reverted recovery/deployment, and recovery review changes. Storage/runtime tests cover additive migrations, encrypted state, stale projections, projection outages, restart/eviction and alarms rearming beyond the platform retry budget.

## Inspected release candidate

- Package: `@polygonlabs/oms-server-wallet-sdk@0.2.0` (**not published**).
- Archive: `.data/sdk-release/polygonlabs-oms-server-wallet-sdk-0.2.0.tgz`.
- Report: `.data/sdk-release/validation.json`; isolated consumer verified at `2026-09-18T00:09:51.168Z`.
- Contents: 57 files, limited to compiled ESM/declarations, package metadata, README/changelog and license/attribution.
- Integrity: `sha512-5QODvdM43r1XNkH6oMM7Y6FGp4rXD05RSbqWp3V1KLNCAf2g4kfnyQ1RB6uefzkL/Is1lUBjWfvIIrbuQ8pwYw==`.

`pnpm test:package` reproduces the archive and clean-consumer validation without publication. CI runs it and uploads `sdk-release-candidate`. Preserve the commit/run identity with the downloaded archive. Revalidate if package contents change; publish the inspected archive following [SDK-RELEASE.md](SDK-RELEASE.md).

## Read-only upstream evidence

Live Trails discovery matched all **14 curated native/USDC/USDT assets** by chain, contract and decimals. All five configured RPC endpoints passed batched chain-ID and code reads. These checks made no intent activation, funding, signing or recovery calls. The earlier foundation's live quote and inert typed-signing results remain recorded in [SWAPS.md](SWAPS.md#11-implementation-prs-and-completion).

Source compatibility review uses the pinned Trails SDK/API/contract revisions in [the specification](SWAPS.md#source-references). The workflow activates with `ExecuteIntent` before funding, has no `CommitIntent`, reconciles lost results before progressing and repairs eligible late deposits using the existing hash. Route discovery handlers are empty in the pinned API, so curated discovery is followed by authoritative quote validation.

The recovery implementation contains a [documented compatibility correction](SWAPS.md#recovery-compatibility-correction-2026-09-18): a recognized utility sweep is validated and converted into exact direct refunds from the intent, bound to a new explicit review, while the original response is retained. Regression tests prove encoding/hash and workflow behavior. Acceptance against deployed contracts is still pending. Price impact is displayed directly as a percentage, matching [the API calculation](https://github.com/0xsequence/trails-api/blob/352bcb89c20a7c8111062d38a3d0cc603c65f860/lib/intentmachine/protocol/price_impact.go).

## Release gates at original preparation (historical)

The prepared archive has not been published, the demo has not been redeployed, no remote secrets or migrations were changed, and no funded swap/recovery has been attempted. New execution defaults to paused. The next session is review/merge, owner-present publication, staged deployment and the explicitly budgeted [funded acceptance matrix](SWAPS-ROLLOUT.md#funded-acceptance-record-pending), including deployed/initially undeployed-owner recovery. Offline and read-only success do not establish those live capabilities.
