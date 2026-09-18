# Backend swaps with SDK 0.2.0

`@polygonlabs/oms-server-wallet-sdk/trails` adds exact-input swaps and bridges, durable sponsored funding, settlement tracking, and separately authorized recovery. The prepared release is **0.2.0**; it has not been published yet. Until publication, install the inspected local archive described in [SDK release](SDK-RELEASE.md). After publication, pin `@polygonlabs/oms-server-wallet-sdk@0.2.0`.

First create a `ServerWallet` using the [Node integration guide](NODE-INTEGRATION.md). Keep its credential executor, encrypted state store, OIDC provider, audience, origin and attestation policy. The swap module has no dependency on this dashboard, Cloudflare, Hono, D1 or React.

## Construct the workflow

```ts
import { SerialExecutor } from '@polygonlabs/oms-server-wallet-sdk';
import {
  EvmChainReader,
  TrailsClient,
  WalletSwaps,
  type SwapStore,
} from '@polygonlabs/oms-server-wallet-sdk/trails';

// Supply a durable implementation of SwapStore (contract below).
declare const swapStore: SwapStore;
// `wallet` is the ServerWallet constructed in the Node integration guide.
const workflowExecutor = new SerialExecutor(); // distinct from wallet's credential executor
const swaps = new WalletSwaps({
  wallet,
  store: swapStore,
  executor: workflowExecutor,
  enabled: true,
  environment: JSON.stringify(['https://trails-api.sequence.app', 'my-trails-project']),
  trails: new TrailsClient({
    apiKey: process.env.TRAILS_API_KEY!,
    origin: process.env.APP_ORIGIN!,
  }),
  chains: new EvmChainReader({
    137: process.env.POLYGON_RPC_URL!,
    8453: process.env.BASE_RPC_URL!,
  }),
  assets: [
    {
      chainId: 137,
      asset: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
      decimals: 6,
      symbol: 'USDC',
    },
    {
      chainId: 8453,
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      decimals: 6,
      symbol: 'USDC',
    },
  ],
});
```

Use a separate Trails API key. Set `environment` to a stable endpoint/project identifier, never a secret or key hash. Key rotation within the same project preserves this identifier. Changing it prevents old work from replaying against another project. Keep the original service configuration available until pending work is reconciled.

Asset policy belongs to your backend. Intersect a curated contract registry with `getChains()` and `getTokenList()` and verify decimals; do not let a caller add contracts or choose recipients. The current API's `GetExactInputRoutes` is an empty stub, so use a validated `QuoteIntent` to establish route availability. Native input uses `asset: 'native'`. Chain IDs, assets and amounts are checked again in the SDK.

`EvmChainReader` uses configured HTTPS JSON-RPC endpoints, checks `eth_chainId` on every batch, bounds responses, rejects redirects, and uses deadlines. Supply an endpoint for every enabled origin, destination and recovery chain. The OMS indexer supplies portfolio display values; current RPC balances authorize spending.

## Review, confirm and resume

```ts
const quote = await swaps.quoteSwap(crypto.randomUUID(), {
  originChainId: 137,
  originAsset: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
  destinationChainId: 8453,
  destinationAsset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  amount: '10000000', // 10 USDC, as an exact base-unit decimal string
  slippageBps: 50,
});
// Present quote.input/expected/minimum output, fees, route and expiry to your operator.
// Only after their confirmation:
await swaps.confirmSwap(quote.id, quote.quote.revision);
// A durable scheduler continues the work independently of the request/browser:
await swaps.tick();
const current = await swaps.getSwap(quote.id);
```

Quote, confirmation, recovery and detail methods return a sanitized `SwapView`; list returns an array and `tick` returns after its bounded batch. The reviewed revision is a base64url SHA-256 digest, not an authentication token. Reusing a quote ID with changed input fails. A new review uses a new ID. Repeated confirmation is idempotent. Distinct local IDs cannot fund the same tracked upstream intent.

Confirmation persists authorization and returns promptly. `tick()` performs a bounded batch and persists the next action/time. Funding is prepared through WaaS with mandatory sponsorship. Trails `ExecuteIntent` activates the route **before** the deposit; there is no `CommitIntent` call. The SDK re-reads activation before funding. Funding is sent once, under a stable child operation ID, and an uncertain result is reconciled using the original WaaS transaction ID. It is never replaced with another deposit, even after expiry or restart.

Settlement requires a successful funding receipt and Trails' matching destination, token and minimum output. ERC-20 funding also requires the exact transfer event. A transaction hash alone is insufficient. Eligible late-deposit repair uses `RetryIntent` with the verified existing hash and fresh status checks; it does not send funds again. Automatic refunds expose the actual reported asset, amount and network. Slow or failed providers remain observable with bounded backoff.

The host must use `swaps.prepareTransfer()` / `swaps.executeTransfer()` for ordinary transfers from this same wallet. Route credential rotation, enable/disable and ordinary signing through `swaps.walletCommand(() => wallet.method(...))`. Otherwise a separate caller can bypass the debit coordinator. Supply `legacyOperationIds` from existing storage when upgrading an integration whose operations predate `ServerWallet.listOperations()`.

Do not expose IDs starting with `swp_` through ordinary signing/transfer/status APIs; that namespace belongs to internal child operations. Do not expose `executeOperation()` or `prepareRecoveryTransaction()` as arbitrary HTTP calls. The latter accepts only a validated, in-process recovery capability, not a caller-supplied JSON transaction.

## Persistence and scheduling contract

Implement `SwapStore` with these methods:

| Method                          | Requirement                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `get(id)`                       | Return the private authoritative record in this wallet's namespace, or null.                                                               |
| `findIntent(intentId)`          | Return the local ID already tracking this intent, or null; enforce uniqueness in storage.                                                  |
| `save(record)`                  | Atomically persist the full record, version, pending action and `nextAt` before resolving.                                                 |
| `list({active, offset, limit})` | Return bounded records ordered by creation time; `active: true` includes every record with a pending action, including attention/recovery. |

Encrypt private records. They contain prepared transactions, canonical authorizations and signatures and must never be returned to browsers. Only expose `SwapView` / `swapView(record)`. Bind encryption to wallet identity and store key using `EncryptedStore`, or an equivalent authenticated scheme. Persist keys independently of ephemeral processes.

`save` must arrange a durable wake-up **before** committing an action that can reach an external service. If scheduling fails, fail the save and do not submit. A wake-up without a committed record is harmless; a committed submission without a wake-up is not. Persist scheduling/outbox metadata together with the record and use a shared exclusive workflow executor across every instance operating that wallet. A single-process Node `SerialExecutor` does not coordinate separate processes.

On Workers, use one SQLite Durable Object per wallet, one alarm for its earliest due action, bounded batches, and explicit rearming after outages; platform retries are finite. On Node, discover due records from persistent storage at startup and on a timer; the timer must not be the only copy of outstanding work. Await active batches on shutdown. Never keep `blockConcurrencyWhile` open during upstream calls.

Keep catalog/UI projections separate. A projection write failure retains a dirty outbox and must not roll back or repeat a wallet submission. Use monotonically increasing versions so a late projection cannot overwrite newer state. The dashboard's [SQL adapter](../apps/server/swaps-store.ts), [Node runner](../apps/server/node-runner.ts), and [Worker coordinator](../apps/server/worker.ts) are complete examples of this contract; adapt their database interfaces to your backend. The SDK itself imports none of them.

## Separately reviewed recovery

```ts
const reviewed = await swaps.prepareRecovery(swapId, crypto.randomUUID(), 'destination');
const recovery = reviewed.recoveries.at(-1)!;
// Show actual assets/amounts/network and requiresOwnerDeployment before authorization.
await swaps.confirmRecovery(swapId, recovery.id, recovery.revision);
// Continue the existing durable scheduler. Read status through getSwap().
```

Prepare from `origin` or `destination` using the recorded intent addresses. Recovery is available after a terminal route outcome or a prolonged stall with no recent progress, and never races locally uncertain funding or another active recovery. It can return an intermediate asset rather than the requested output. The review expires after five minutes; changed balances require another review.

The SDK checks the Sequence v3 envelope, typed data, digest, recipient, chain, call flags and sweep/transfer targets. It retains the original API envelope. A recognized non-delegate utility sweep is converted into a separately stored, exact direct-refund authorization before review/signing, because the utility sweeps its own balances rather than the intent’s; see the [source-backed compatibility correction](SWAPS.md#recovery-compatibility-correction-2026-09-18). Direct refund envelopes stay unchanged. If the owner wallet is undeployed on that chain, the review discloses a sponsored zero-value self-call for deployment. The workflow waits for code before signing, checks the signature with WaaS, and rejects an EIP-6492 wrapper in this recovery path. It then validates Trails' returned transaction, including the separate factory/guest deployment batch when the **intent wallet** needs deployment. Arbitrary delegates, approvals, unrelated calls and native funding of a recovery transaction are rejected.

Recoveries have stable deployment/signing/submission IDs and survive restart. `received` records confirmed amounts; `partial` retains evidence when recovery returns less or leaves residual funds and permits a fresh review. ERC-20 received amounts come from transfer logs to the managed wallet; native recovery uses verified owner balance changes. Uncertain submissions keep the chain reserved until resolved. A feature pause (`enabled: false`) stops new swaps/funding but allows tracking and separately confirmed recovery; disabling the wallet also blocks recovery signing and automatic reauthentication.

## Deployment acceptance

Offline tests cover protocol validation, failures, storage, browser flows and both runtimes. Funded acceptance still must prove the configured WaaS/Trails deployments support sponsored execution and deployed/initially undeployed-owner recovery. See the explicit [rollout and acceptance checklist](SWAPS-ROLLOUT.md). The library does not claim that mock success establishes live sponsorship or recovery compatibility.
