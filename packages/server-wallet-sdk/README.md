# @oms/server-wallet-sdk

Internal standalone ESM TypeScript SDK targeting WaaS v1.1.0. Currently private; it can be extracted without the dashboard, Hono, D1, or the embedded wallet SDK. Build with `pnpm --filter @oms/server-wallet-sdk build`. Requires Web Crypto and Fetch (Node 24+ or Workers with `nodejs_compat`).

## Integration

```ts
import {
  ServerWallet,
  WaasTransport,
  EncryptedStore,
  SerialExecutor,
  IndexerClient,
  parseAmount,
  type StateStore,
} from '@oms/server-wallet-sdk';

// Implement durable reads/writes in a namespace dedicated to this identity.
declare const persistence: StateStore;
declare const publishableKey: string;
declare const approvedPcr0s: string[];
declare const encryptionKeyBase64: string; // 32 random bytes, base64 encoded
declare const issuer: string;
declare const audience: string;
declare const subject: string;
declare function issueIdToken(): Promise<{ token: string; expiresAt: number }>;

// Reuse exactly one executor per identity in a single process/DO instance.
const executor = new SerialExecutor();
const wallet = new ServerWallet({
  subject,
  issuer,
  audience,
  tokenProvider: issueIdToken,
  transport: new WaasTransport(publishableKey, approvedPcr0s),
  store: new EncryptedStore(persistence, encryptionKeyBase64, `project:${issuer}:${subject}`),
  executor,
});

const snapshot = await wallet.createOrRestore();
const balances = await new IndexerClient(publishableKey).getBalances(snapshot.wallet!.address);
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

| Method                              | Behavior                                                            |
| ----------------------------------- | ------------------------------------------------------------------- |
| `inspect()`                         | Public snapshot; does not authenticate or return private material.  |
| `createOrRestore()`                 | Recover one wallet for the configured identity; reauth when needed. |
| `rotate()`                          | Self-revoke the current credential, then authenticate a fresh one.  |
| `setDisabled(boolean)`              | Disable before revocation; block auth until explicitly re-enabled.  |
| `signMessage(id, chainId, message)` | Sign plain text and verify with WaaS wallet-aware verification.     |
| `prepareTransfer(id, transfer)`     | Validate a native/ERC-20 transfer; require sponsored quote.         |
| `executeTransfer(id)`               | Submit the stored quote once; reconcile repeated calls.             |
| `getOperation(id)`                  | Return persisted result; poll pending/uncertain transfer status.    |

Idempotency IDs must contain 8–100 letters, digits, underscores, or hyphens. Changed input under the same ID raises `IDEMPOTENCY_CONFLICT`. Reusing an ID never prepares another transfer. A new quote after expiry requires a new ID and operator review.

`unknown` is a meaningful state, including a lost execution response. Keep polling `getOperation`; never generate another send merely because the first response was lost. `CREATION_UNCERTAIN` prevents blind replacement-wallet creation. Disabled wallets cannot reauthenticate even to poll a status; previously submitted transfers may still complete upstream.

`WalletError` exposes a safe code, message, and HTTP-oriented status. `UpstreamError` also exposes the numeric WaaS error code and RPC method. Raw tokens, private keys, and upstream response bodies are excluded. Validation failures, unsigned gateway failures, and attestation failures must be surfaced instead of weakening verification.

`IndexerClient.getBalances(address, page?)` returns base-unit strings, metadata, a fetch timestamp, per-chain errors, and `nextPage`. Keep errors separate from zero balances and follow pagination. Unknown token decimals stay unknown.

See [NOTICE](NOTICE) for the Apache-licensed verifier provenance. Neither the package nor its API is published or declared stable yet.
