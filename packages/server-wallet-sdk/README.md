# @polygonlabs/oms-server-wallet-sdk

Standalone ESM TypeScript SDK targeting WaaS v1.1.0, with OIDC authentication, encrypted credential persistence, attested responses, verified message signing, and sponsored native/ERC-20 transfers. Requires Web Crypto and Fetch (Node 24+ or Workers with `nodejs_compat`). It has no dashboard, Hono, D1, or embedded wallet SDK dependency.

## Installation

```sh
npm install @polygonlabs/oms-server-wallet-sdk@0.2.0
```

For a step-by-step guide to integrating this package into your own Node.js / TypeScript backend, see the [OIDC, wallet creation, signing, and transaction walkthrough](https://github.com/0xsequence-demos/waas-server-wallets/blob/master/docs/NODE-INTEGRATION.md).

## Integration

```ts
import {
  ServerWallet,
  WaasTransport,
  EncryptedStore,
  SerialExecutor,
  IndexerClient,
  parseAmount,
  environmentFromKey,
  type StateStore,
} from '@polygonlabs/oms-server-wallet-sdk';

// Implement durable reads/writes in a namespace dedicated to this identity.
declare const persistence: StateStore;
declare const publishableKey: string;
declare const approvedPcr0s: string[];
declare const encryptionKeyBase64: string; // 32 random bytes, base64 encoded
declare const applicationOrigin: string; // Origin allowed for the OMS publishable key
declare const issuer: string;
declare const audience: string;
declare const subject: string;
declare function issueIdToken(): Promise<{ token: string; expiresAt: number }>;

// Reuse exactly one executor per identity in a single process/DO instance.
const executor = new SerialExecutor();
const environment = environmentFromKey(publishableKey);
const namespace = JSON.stringify([
  environment.origin,
  environment.projectId,
  issuer,
  audience,
  subject,
]);
// Server requests use the project's allowed Origin, just like the walkthrough.
const omsFetch: typeof fetch = (input, init) => {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  headers.set('Origin', new URL(applicationOrigin).origin);
  return fetch(input, { ...init, headers });
};
const wallet = new ServerWallet({
  subject,
  issuer,
  audience,
  tokenProvider: issueIdToken,
  transport: new WaasTransport(publishableKey, approvedPcr0s, omsFetch),
  store: new EncryptedStore(persistence, encryptionKeyBase64, namespace),
  executor,
});

const snapshot = await wallet.createOrRestore();
const balances = await new IndexerClient(publishableKey, omsFetch).getBalances(
  snapshot.wallet!.address,
);
const signed = await wallet.signMessage(crypto.randomUUID(), 137, 'Hello OMS');

const operationId = crypto.randomUUID(); // persist and reuse on retries
const prepared = await wallet.prepareTransfer(operationId, {
  chainId: 137,
  to: '0x2222222222222222222222222222222222222222',
  asset: 'native', // or an ERC-20 contract address
  amount: parseAmount('0.001', 18), // decimal string in base units
});
// Obtain application/operator confirmation of the prepared payload first.
if (prepared.status === 'quoted') await wallet.executeTransfer(operationId);
const status = await wallet.getOperation(operationId);
```

The token provider supplies an ES256 OIDC ID token accepted by the project's configured issuer/audience. `expiresAt` is Unix time in **seconds**. The SDK generates its own P-256 credential, commits the JWT hash, completes authentication, discovers/binds the same wallet, and renews credentials automatically. Default credential lifetime is six hours; expiry recovery starts within sixty seconds of expiration.

Verified unknown, expired, or revoked/unauthorized credential responses trigger one reauthentication attempt. Persistent authorization failures propagate without a retry loop. `WalletSnapshot.credentialId` is the WaaS SHA-256 credential identifier; the request signature uses the corresponding raw public key internally.

## Storage and concurrency contract

`StateStore.read(key)` returns a string or null; `write(key, value)` must finish durable persistence before resolving. The store namespace and encryption context must be stable, unique to the project/environment/issuer/audience/subject, and shared by every instance for that identity. Never share a namespace between identities. Credential keys must use encrypted persistence, as in the example.

`ExclusiveExecutor.run(task)` holds exclusive ownership for the **entire async task**, including remote I/O. All SDK instances using the same state must share that ownership. `SerialExecutor` is sufficient only within one Node process or a single per-wallet Durable Object. Clustered Node backends need a coordinator with equivalent exclusive ownership across processes, including crash recovery; allocating nonces alone is insufficient. The dashboard's Worker adapter supplies one Durable Object per wallet.

Each RPC nonce is durably advanced before dispatch. All WaaS responses must pass Nitro root/certificate/COSE/PCR0/freshness/nonce/body-binding checks. There is no attestation bypass. Transport uses bounded responses, 20-second request timeouts, and refuses redirects. An all-zero debug PCR0 can be explicitly configured for a nonproduction environment; production keys reject it.

## Operations and recovery

| Method                                  | Behavior                                                            |
| --------------------------------------- | ------------------------------------------------------------------- |
| `inspect()`                             | Public snapshot; does not authenticate or return private material.  |
| `createOrRestore()`                     | Recover one wallet for the configured identity; reauth when needed. |
| `rotate()`                              | Self-revoke the current credential, then authenticate a fresh one.  |
| `setDisabled(boolean)`                  | Disable before revocation; block auth until explicitly re-enabled.  |
| `signMessage(id, chainId, message)`     | Sign plain text and verify with WaaS wallet-aware verification.     |
| `signTypedData(id, chainId, typedData)` | Validate EIP-712 domain/data, sign, and verify with WaaS.           |
| `prepareTransfer(id, transfer)`         | Validate a native/ERC-20 transfer; require sponsored quote.         |
| `executeTransfer(id)`                   | Submit the stored quote once; reconcile repeated calls.             |
| `getOperation(id)`                      | Return persisted result; poll pending/uncertain transfer status.    |

Idempotency IDs must contain 8–100 letters, digits, underscores, or hyphens. Changed input under the same ID raises `IDEMPOTENCY_CONFLICT`. Reusing an ID never prepares another transfer. A new quote after expiry requires a new ID and operator review.

`unknown` is a meaningful state, including a lost execution response. Keep polling `getOperation`; never generate another send merely because the first response was lost. `CREATION_UNCERTAIN` prevents blind replacement-wallet creation. Disabled wallets cannot reauthenticate even to poll a status; previously submitted transfers may still complete upstream.

`WalletError` exposes a safe code, message, and HTTP-oriented status. `UpstreamError` also exposes the numeric WaaS error code and RPC method. Raw tokens, private keys, and upstream response bodies are excluded. Validation failures, unsigned gateway failures, and attestation failures must be surfaced instead of weakening verification.

`IndexerClient.getBalances(address, page?)` returns base-unit strings, metadata, a fetch timestamp, per-chain errors, and `nextPage`. Keep errors separate from zero balances and follow pagination. Unknown token decimals stay unknown.

## Trails swaps and recovery

The optional `@polygonlabs/oms-server-wallet-sdk/trails` entry point, added in **0.2.0**, provides `WalletSwaps`, `TrailsClient`, `EvmChainReader`, quote/recovery validation and persistent execution contracts. See the [standalone backend swaps guide](https://github.com/0xsequence-demos/waas-server-wallets/blob/master/docs/SWAPS-INTEGRATION.md) for complete orchestration and host storage/scheduling requirements.

```ts
import {
  TrailsClient,
  buildSwapRequest,
  validateSwapQuote,
} from '@polygonlabs/oms-server-wallet-sdk/trails';

const trails = new TrailsClient({
  apiKey: trailsApiKey, // Separate from the OMS publishable key; backend only.
  origin: applicationOrigin, // Exact origin, without a trailing slash.
});
const { TrailsContracts } = await trails.readiness();
const assets = [
  { chainId: 137, asset: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6 },
  { chainId: 8453, asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
]; // Host-approved asset policy, not input supplied by a dashboard request.
const request = buildSwapRequest(
  snapshot.wallet!.address,
  {
    originChainId: 137,
    originAsset: assets[0].asset,
    destinationChainId: 8453,
    destinationAsset: assets[1].asset,
    amount: '10000000', // Base units; never pass a floating-point token amount.
  },
  assets,
);
const { intent } = await trails.quoteIntent(request);
const reviewed = await validateSwapQuote(intent, request, TrailsContracts);
// Persist and review the snapshot/digest before any funding workflow.
// This quote-only example does not activate or fund the swap.
// Use WalletSwaps for durable execution, reconciliation and recovery.
```

`TrailsClient` supports `readiness`, `getChains`, `getTokenList`, `getExactInputRoutes`, `quoteIntent`, `executeIntent`, `getIntent` and `prepareIntentRecovery`. Calls are bounded, reject redirects and unsafe integer JSON, support caller cancellation, and never automatically retry. `TrailsError` contains the method, HTTP status and numeric upstream code without upstream bodies or keys. There is no `CommitIntent` call. Readiness requires the **wire value `v1.5`**; `v1_5` is only an upstream enum identifier.

Quote validation binds the owner/recipient, chains, assets, budget, slippage, expiry, contracts and deposit precondition. It reconstructs native/ERC-20 funding calldata locally and returns an independent snapshot plus a base64url SHA-256 digest. Keep the snapshot and digest in authoritative storage; the digest is not an authentication token. The host must review any changed quote and require WaaS sponsorship when it eventually prepares the funding transfer.

`validateRecoveryPayload(prepared, intent, owner, balances)` decodes Sequence v3 calls, binds the recorded intent address/chain, restricts native/ERC-20 transfers and TrailsUtils sweeps to the owner and reviewed assets, and checks the EIP-712 hash. Supply fresh, host-observed `{asset, amount}` balances **on that intent chain**, never balances supplied by a browser. The returned `typedData` can be passed to `wallet.signTypedData`; that generic primitive validates the domain and encoding, while the caller remains responsible for the authorization's meaning. Do not expose arbitrary typed-data signing as a dashboard endpoint.

`WalletSwaps` implements durable activation, sponsored funding, settlement, delayed-deposit repair and separately confirmed source/destination recovery. Route ordinary transfers through the same coordinator; persist encrypted private records and durable wake-ups before external mutations. Recovery includes sponsored owner deployment when needed, verified typed-data signing and validation of the returned intent execution/deployment envelope. See [rollout and acceptance](https://github.com/0xsequence-demos/waas-server-wallets/blob/master/docs/SWAPS-ROLLOUT.md) for the live scenarios verified so far and recovery checks still pending.

For explicit live discovery checks, set the ignored local `TRAILS_API_KEY` and run `pnpm test:trails`. Setting `TRAILS_TEST_WALLET` additionally requests Polygon USDC → Base USDC and Polygon POL → USDC quotes without funding or executing them. Ordinary tests use synthetic fixtures and make no network calls.

Version `0.2.0` adds swap/recovery capabilities; the API is not yet declared stable. Pin the version and review changes before upgrading. Licensed under [Apache-2.0](https://github.com/0xsequence-demos/waas-server-wallets/blob/master/packages/server-wallet-sdk/LICENSE-APACHE-2.0); see [NOTICE](https://github.com/0xsequence-demos/waas-server-wallets/blob/master/packages/server-wallet-sdk/NOTICE) for verifier provenance. Both files are included in the npm package.

For local SDK development in the repository, run `pnpm --filter @polygonlabs/oms-server-wallet-sdk build`. Packaging runs the build automatically through `prepack`.
