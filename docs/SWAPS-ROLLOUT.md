# Swap release and deployment handoff

Prepared on 2026-09-18. SDK **0.2.0** and the complete dashboard integration are ready for review. This work does not publish npm, deploy a Worker, upload secrets or submit a funded live transaction. PRs target `master` directly; there is no dependency on an old feature branch.

Deployment update: PRs #6 and #7 are merged, the Trails secret and swap migration are installed, and the operator requested enabling the demo on 2026-09-18. `wrangler.jsonc` now sets `SWAPS_ENABLED=true` for this deployed demo. Local configuration still defaults to paused. Enablement does not establish funded acceptance or publish the SDK; the acceptance matrix below remains pending.

## Reviewable changes

- Standalone `/trails` workflow: durable quote/confirmation, activation before funding, sponsored native/ERC-20 funding, settlement and late-deposit repair.
- Source/destination recovery, intermediate assets, sponsored owner deployment, verified typed-data signing, factory/guest envelope validation, idempotent submission and actual received amounts.
- Encrypted per-wallet journal, shared debit coordination, persistent Node runner, Workers alarms, versioned catalog projection outbox and additive migrations.
- Dashboard swap/recovery reviews, progress, explorer links, paginated activity, precise amounts and history/deep links. Indexed USD portfolio totals exclude estimated swap proceeds.

## Next session: publish, deploy, accept

1. Review and merge the implementation PR directly into `master`. Check the recorded CI result against that commit.
2. With the package owner present, publish the inspected **0.2.0** archive following [SDK-RELEASE.md](SDK-RELEASE.md). Verify the registry integrity and install the published package into a clean consumer. No publication automation is installed.
3. Apply the additive catalog migration to the existing Cloudflare D1 database. Node installs ordered migrations automatically on startup. Durable Objects add their journal table automatically and preserve the existing `state` table.
4. Stage the separate `TRAILS_API_KEY` secret. Preserve existing secrets, account `b6c780e2a453a8593576535e3e81a7cd`, issuer/audience and debug PCR0 configuration. The local `.env` value is already present; do not paste it into a command argument, source file or PR. Wrangler secret commands can create/deploy versions; perform them during the explicitly authorized deployment session, not during release preparation.
5. Deploy the built Worker with `SWAPS_ENABLED=false`. Check authentication, existing wallets/transfers/signing, `/api/swaps/config` and journal/projection behavior. The origin remains `https://oms-server-wallet-dashboard.0xsequence.workers.dev` for OMS/Trails requests.
6. Enable swaps only for the controlled acceptance window with the shared administrator, use the agreed funded wallet and exact spend cap, and run the scenarios below. Keep broad use paused until recovery compatibility passes. Record each intent/operation/hash and result.
7. Enable the demo after acceptance and verify the published SDK independently with the same service configuration. Leave background reconciliation running when pausing new swaps.

Commands for the **next deployment session**, after approval and review:

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
| Published SDK consumer                               | ESM import/types and the same quote/execution/recovery workflow outside this repo                                           | Pending |

Use a controlled recoverable intent or upstream-supported test scenario for recovery. Do not manufacture a failure with unrelated mainnet calls. If WaaS cannot sponsor the owner deployment or Trails rejects the verified deployed-wallet signature, retain exact sanitized evidence and keep execution paused; do not truncate signatures or fall back to unsponsored calls.

## Operations and rollback

The authoritative record is encrypted in the per-wallet coordinator (Workers) or SQLite (Node). Dashboard summaries are projections with a dirty outbox. A catalog outage is repaired without resubmitting transactions. Unknown WaaS submissions retain the original transaction ID and chain reservation, including after expiry or disable/re-enable. No timed retry creates another deposit.

Do not run Node twice against the same local database or operate one identity independently from both Node and Workers. Preserve encryption keys and durable storage. Changing OMS scope or Trails endpoint/project while work is active blocks reconciliation; restore the original configuration to finish it. `SWAPS_ENABLED=false` is the normal pause mechanism. A code rollback must retain the journal schema, alarm/runner and ability to observe/recover already funded swaps.

Recovery may return different assets/networks, and partial recovery is reported using actual receipt evidence. Recheck remaining intent balances for another review; do not erase the previous record. Account for delayed indexer updates when comparing dashboard USD totals. The prototype exposes the latest 50 ordinary operations and paginated swap history, not a complete blockchain ledger.

Sources: [Cloudflare alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/), [Wrangler secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [Circle USDC contracts](https://developers.circle.com/stablecoins/usdc-contract-addresses), [PublicNode](https://www.publicnode.com/), [Arbitrum chain information](https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info), [BNB RPC endpoints](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/), and [pinned Trails sources](SWAPS.md#source-references).
