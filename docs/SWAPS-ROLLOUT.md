# Swap release and deployment handoff

Updated on 2026-09-18. SDK **0.2.0** is published on npm as `latest`, and its registry archive and independent consumer checks passed. See the [publication record](SWAPS-VALIDATION.md#published-sdk-020). PRs target `master` directly.

Deployment update: PRs #6, #7 and #8 are merged, the Trails secret and swap migration are installed, and the demo is deployed with `SWAPS_ENABLED=true`. The operator reports successful swaps. Local configuration still defaults to paused. Detailed scenario-specific evidence, including recovery acceptance, remains pending in the matrix below.

## Reviewable changes

- Standalone `/trails` workflow: durable quote/confirmation, activation before funding, sponsored native/ERC-20 funding, settlement and late-deposit repair.
- Source/destination recovery, intermediate assets, sponsored owner deployment, verified typed-data signing, factory/guest envelope validation, idempotent submission and actual received amounts.
- Encrypted per-wallet journal, shared debit coordination, persistent Node runner, Workers alarms, versioned catalog projection outbox and additive migrations.
- Dashboard swap/recovery reviews, progress, explorer links, paginated activity, precise amounts and history/deep links. Indexed USD portfolio totals exclude estimated swap proceeds.

## Remaining acceptance and future deployments

1. Record intent IDs, operation IDs, transaction hashes and results for the scenarios below using an agreed funded wallet and spend cap. The operator's successful swap report does not establish every recovery or restart scenario.
2. Verify the published SDK's live execution/recovery workflow in a separate backend with the same service configuration. Its registry installation, imports, types and offline codec/storage checks already pass.
3. For future deployments, check the merged commit's CI, preserve the catalog/journal and existing secrets, and apply only outstanding additive migrations. Keep account `b6c780e2a453a8593576535e3e81a7cd`, issuer/audience, debug PCR0 and origin `https://oms-server-wallet-dashboard.0xsequence.workers.dev` consistent. Never paste secret values into source or PRs. Leave background reconciliation running when pausing new swaps.

Deployment reference for future changes; the npm release does not require redeploying the current demo:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:coverage
pnpm test:workers
pnpm cf:check
# Remote changes below are deliberately not part of preparation or CI:
pnpm exec wrangler d1 migrations apply oms-server-wallet-dashboard --remote
# Stage/preserve secrets using Wrangler's documented secret/version flow.
pnpm deploy
```

`pnpm deploy` consumes this workspace's SDK build. Publishing npm by itself does not deploy the demo; merging code by itself does neither. The standalone release artifact and the Worker bundle are two distinct delivery steps.

## Configuration

| Setting             | Behavior                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRAILS_API_KEY`    | Backend secret, separate from OMS. Never sent to the browser.                                                                                                                                                                         |
| `TRAILS_API_URL`    | Defaults to `https://trails-api.sequence.app`; HTTPS origin only.                                                                                                                                                                     |
| `TRAILS_PROJECT_ID` | Stable project label (`oms-dashboard` by default). Change only after draining/reconciling old work; retain the value on key rotation in the same project.                                                                             |
| `SWAPS_ENABLED`     | Application default `false`; this demo's Wrangler config sets `true` for operator testing. Setting `false` pauses new quotes, confirmation, activation and funding while tracking and separately confirmed recovery remain available. |
| `EVM_RPC_URLS`      | Optional JSON map of chain ID to backend HTTPS RPC URL. Use a secret if URLs contain provider credentials.                                                                                                                            |

Default RPCs are PublicNode Ethereum/Polygon, official Arbitrum One/Base mainnet endpoints, and BNB's public endpoint. Their batch `eth_chainId` + code reads passed on all five chains on 2026-09-18. Replace them with dedicated endpoints if public rate limits impede processing. All 14 curated native/USDC/USDT contracts and decimals matched live Trails discovery on that date; BNB's 18-decimal assets are explicitly labeled Binance-Peg.

Read-only checks used no funding, signatures, activation or recovery authorization. `GetExactInputRoutes` is an empty TODO in the pinned API source; available assets are intersected with chain/token discovery and an actual validated quote decides route availability.

## Funded acceptance record (pending)

Agree the wallet identity, per-scenario exact input and cumulative maximum before execution. Do not create another swap as a retry for an uncertain deposit. Reuse its existing ID and status/reconcile route.

The operator reports working swaps, but no route-specific hashes or recovery results are recorded here yet. Pending rows refer to this evidence, not to an unimplemented feature.

| Scenario                                             | Required proof                                                                                                              | Result  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------- |
| Same-chain native → token                            | Sponsored funding, single deposit, actual output ≥ reviewed minimum                                                         | Pending |
| Polygon USDC → Base USDC                             | Activation before deposit; source/destination hashes; matching owner/minimum                                                | Pending |
| Same-asset bridge and another funded network         | Route availability and correct chain-specific receipts                                                                      | Pending |
| ERC-20 input with zero native gas balance            | WaaS sponsorship covers the wallet transaction                                                                              | Pending |
| Source recovery                                      | Fresh failed/stalled state, separately reviewed assets, deployed-owner signature, actual returned funds                     | Pending |
| Destination recovery with initially undeployed owner | Sponsored owner self-call, confirmed code, accepted signature, validated intent deployment if needed, actual returned funds | Pending |
| Disconnect/restart                                   | Browser closure and Worker eviction do not stop settlement or duplicate funding                                             | Pending |
| Feature pause / wallet disable                       | Existing funded work is observed; no unauthorized new debit or reauth while disabled                                        | Pending |
| Published SDK consumer                               | ESM import/types and the same quote/execution/recovery workflow outside this repo                                           | Registry imports/types and offline checks passed; live workflow evidence pending |

Use a controlled recoverable intent or upstream-supported test scenario for recovery. Do not manufacture a failure with unrelated mainnet calls. If WaaS cannot sponsor the owner deployment or Trails rejects the verified deployed-wallet signature, retain exact sanitized evidence and keep execution paused; do not truncate signatures or fall back to unsponsored calls.

## Operations and rollback

The authoritative record is encrypted in the per-wallet coordinator (Workers) or SQLite (Node). Dashboard summaries are projections with a dirty outbox. A catalog outage is repaired without resubmitting transactions. Unknown WaaS submissions retain the original transaction ID and chain reservation, including after expiry or disable/re-enable. No timed retry creates another deposit.

Do not run Node twice against the same local database or operate one identity independently from both Node and Workers. Preserve encryption keys and durable storage. Changing OMS scope or Trails endpoint/project while work is active blocks reconciliation; restore the original configuration to finish it. `SWAPS_ENABLED=false` is the normal pause mechanism. A code rollback must retain the journal schema, alarm/runner and ability to observe/recover already funded swaps.

Recovery may return different assets/networks, and partial recovery is reported using actual receipt evidence. Recheck remaining intent balances for another review; do not erase the previous record. Account for delayed indexer updates when comparing dashboard USD totals. The prototype exposes the latest 50 ordinary operations and paginated swap history, not a complete blockchain ledger.

Sources: [Cloudflare alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/), [Wrangler secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [Circle USDC contracts](https://developers.circle.com/stablecoins/usdc-contract-addresses), [PublicNode](https://www.publicnode.com/), [Arbitrum chain information](https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info), [BNB RPC endpoints](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/), and [pinned Trails sources](SWAPS.md#source-references).
