# First Cloudflare deployment and OMS dev registration

The application deploys as one Worker with static assets, D1, and one SQLite Durable Object per wallet. Cloudflare hosts the backend-only OIDC issuer at the same hostname. No separate Node service is required in deployment. The local Node server remains available for NixOS development.

## Current deployment

- Account: **Sequence Demos**, `b6c780e2a453a8593576535e3e81a7cd`.
- Dashboard/issuer: **https://oms-server-wallet-dashboard.0xsequence.workers.dev**.
- D1: `oms-server-wallet-dashboard`, ID `a2f575c6-6c3e-4317-9a2c-9271c50746c9`; initial migration applied.
- The four generated application secrets are deployed. Sign in with `ADMIN_PASSWORD` from the local `.env`.
- The OMS dev publishable key and trusted PCR0 policy are synced from the operator's `.env`. The key is stored as a Worker secret; PCR0 values are pinned in `wrangler.jsonc`.
- `APP_ORIGIN` is `https://oms-server-wallet-dashboard.0xsequence.workers.dev`. Both WaaS and indexer gateway requests send this exact `Origin` header, without a trailing slash. Local development retains its localhost origin.
- OIDC audience: `api.dev.polygon-dev.technology`; provider registration verified by live authentication.
- Approved dev PCR0: 96 hexadecimal zeros. Full Nitro certificate, signature, freshness, nonce, and request/response binding verification remains enabled. Production routing rejects the debug measurement.
- Deployment version: `62b4bc1a-c5ed-4de7-8ebd-385d2f5de305`.

Verified over public HTTPS on 2026-09-16: static assets, discovery/JWKS, JWT verification against the published key, admin login/logout, secure session cookies, CSRF rejection, D1 catalog reads, and the wallet setup guard. These checks made no WaaS calls or wallet transactions.

Verified on 2026-09-17: attested public Status, OIDC authentication, wallet creation/restore, balances and verified message signatures on every selected chain, rotation, disable/re-enable, durable state across deployments, standalone SDK recovery from revocation, and hosted browser signing. Polygon transfer preparation returned `sponsored: true`; no transaction was submitted. The selected sandbox dev service reports `dev-20260911-6491d235`. See [the acceptance record](LIVE-ACCEPTANCE.md).

Use [these registration values](oms-dev-registration.json) when registering the provider in OMS dev. This file records provider settings; it is not a payload for an assumed OMS management endpoint.

The setup steps below document how to reproduce the deployment. The repository's `wrangler.jsonc` now points to the account and database above; use distinct resource names and IDs when deploying another copy.

## 1. Choose the account and stable issuer hostname

Choose the Cloudflare account and either `https://oms-server-wallet-dashboard.<subdomain>.workers.dev` or a custom domain. Use the stable deployment hostname, not an ephemeral version preview URL. The issuer is the origin without a trailing slash; changing it changes OIDC identity and the local wallet namespace.

```sh
pnpm exec wrangler login
pnpm exec wrangler whoami
```

If more than one account is available, set `account_id` in `wrangler.jsonc` to the intended account. For a custom domain, configure an appropriate Workers custom-domain route and use that origin in both variables below.

## 2. Create D1 and finish the nonsecret configuration

```sh
pnpm exec wrangler d1 create oms-server-wallet-dashboard
```

Replace the all-zero `database_id` placeholder in `wrangler.jsonc` with the returned ID. Set:

| Variable                      | Value                                                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OIDC_ISSUER`                 | The public HTTPS origin chosen above.                                                                                                                     |
| `APP_ORIGIN`                  | The exact same origin for the deployed dashboard, without a trailing slash.                                                                               |
| `OIDC_AUDIENCE`               | `api.dev.polygon-dev.technology` for this registered dev provider.                                                                                        |
| `TRUSTED_PCR0S`               | Comma-separated, independently approved PCR0 measurements for **the selected OMS dev deployment**. May remain empty for the issuer-only first deployment. |
| `OIDC_ADDITIONAL_PUBLIC_JWKS` | Empty initially; optional public keys for staged issuer rotation.                                                                                         |

Keep the Durable Object binding and migration tag. Generated binding types track this configuration:

```sh
pnpm cf:types
pnpm check
pnpm cf:check
pnpm exec wrangler d1 migrations apply DB --remote
pnpm deploy
```

This publishes the site and provisions the Durable Object namespace. Until secrets are set, the API reports configuration errors and cannot authenticate administrators or operate wallets. The remote migration is explicit; local Node migrations run automatically on first startup. See [D1 migration documentation](https://developers.cloudflare.com/d1/reference/migrations/).

## 3. Set Worker secrets

Run `pnpm setup` if `.env` does not exist. It generates the first four secrets below. Enter values through Wrangler's prompts; enter the JSON object for `OIDC_PRIVATE_JWK` without the `.env` shell quotes. Do not paste secret values into the conversation or source files.

```sh
pnpm exec wrangler secret put ADMIN_PASSWORD
pnpm exec wrangler secret put SESSION_SECRET
pnpm exec wrangler secret put ENCRYPTION_KEY
pnpm exec wrangler secret put OIDC_PRIVATE_JWK
pnpm exec wrangler secret put OMS_PUBLISHABLE_KEY
```

The last value is the OMS **dev** publishable key. It selects the gateway hostname and project scope for both WaaS and the indexer. No RPC provider API key is needed. Secret updates deploy a new Worker version; see [Cloudflare secrets documentation](https://developers.cloudflare.com/workers/configuration/secrets/).

Retain the encryption key with the database state: changing it does not re-encrypt existing records. Changing `ADMIN_PASSWORD` or `SESSION_SECRET` invalidates existing dashboard sessions automatically.

## 4. Verify issuer endpoints, then register in OMS dev

Open these public endpoints on the deployed origin:

```text
GET /.well-known/openid-configuration
GET /oidc/jwks
```

Discovery must report the exact issuer and `<issuer>/oidc/jwks`. JWKS must contain a public P-256 key, `alg: ES256`, and a thumbprint-derived `kid`; it must not contain `d`. There is deliberately no public subject-to-token endpoint. JWTs are minted internally with a five-minute lifetime and a unique `jti`.

Register/whitelist this custom provider with the target OMS dev project using the issuer, discovery/JWKS URL, and exact audience. Registration must allow the backend's chosen subject identifiers. Use the OMS operator's current registration workflow; this repository does not invent a provider-management endpoint. Also enable gas sponsorship for the five selected chain IDs: **137, 42161, 8453, 56, 1**. An OMS dev environment does not imply testnet chains: these are the requested mainnets.

Obtain the approved PCR0 policy from the deployment owner for each environment. For this dev deployment, the owner confirmed debug mode and explicitly approved the all-zero measurement on 2026-09-17. The [WaaS v1.1.0 release](https://github.com/0xsequence/waas/releases/tag/v1.1.0) publishes release measurements, but those do not identify which image dev currently runs. All certificate, signature, freshness, nonce, and response-binding checks remain active with any approved measurement.

Set `TRUSTED_PCR0S` if deferred, run `pnpm cf:types`, and deploy the updated configuration. The dashboard's setup notice should clear once configuration is complete; only a real auth attempt can establish that OMS registration and trust settings are correct.

## 5. Live acceptance run

Registration and live wallet lifecycle checks are complete; funded execution remains pending. Run `pnpm test:live` to repeat the lifecycle against the dedicated acceptance identity. See [the acceptance record](LIVE-ACCEPTANCE.md) for optional sponsored preparation, funded execution, standalone SDK, and browser commands.

1. Sign in, create a wallet, and record its application identifier and address. Reuse the identifier and verify the same wallet is returned.
2. Verify native/ERC-20 balances and errors across the five networks. Empty balances and indexer errors must remain distinguishable.
3. Sign a distinctive plain message and check that the dashboard returns a verified signature.
4. Rotate the credential and confirm the address stays the same. Disable the wallet, verify that operations stop, then re-enable it.
5. Prepare a small transfer. Confirm that the quote is sponsored before explicitly confirming the send. Check transaction status and the explorer receipt. Test unsponsored-project rejection separately without submitting.
6. Restart/redeploy the application and repeat restore/sign. Verify the persisted wallet and identity survive. Exercise automatic expiry recovery with a dedicated SDK test identity if a shorter live lifetime is desired.

Do not reset an uncertain operation and repeat the send. The activity API reconciles it using its existing transaction ID. If an uncertain creation never appears in discovery, investigate that remote request before clearing state manually.

## Operations

- **Local live testing:** copy the same signing JWK/issuer/audience into `.env`, set the dev OMS key and approved PCRs, and keep the local `APP_ORIGIN`. Re-run `pnpm dev` after `.env` changes. The public endpoint must publish that JWK. Separate application databases create separate credentials; use different identifiers for local and deployed tests.
- **Issuer signing-key rotation:** prepublish the new public JWK in `OIDC_ADDITIONAL_PUBLIC_JWKS` (`{"keys":[...]}`), wait for the upstream JWKS cache lifetime, switch `OIDC_PRIVATE_JWK`, then retain the old public JWK in the additional set until all old tokens and upstream caches have expired. Discovery/JWKS responses use a five-minute HTTP cache; confirm the upstream cache duration before removal. Never put private JWKs in the additional set.
- **Wallet credentials:** the SDK automatically renews near expiry and retries once after verified unknown, expired, or revoked/unauthorized credential responses. Persistent authorization failures propagate. Dashboard rotation self-revokes the old credential. Disable prevents automatic renewal and persists even if remote revocation fails.
- **Backups:** preserve D1 catalog data, Durable Object state, the issuer key, and encryption key. This prototype does not include an automated cross-store backup or restore workflow.
- **Audit:** the database records actions and sanitized outcome codes. Worker logs include route/code and, for unexpected runtime failures, the error type and stack frames without the error message. Tokens, credentials, request bodies, and upstream error bodies are excluded.
- **Upgrade:** confirm protocol changes and approved PCRs before upgrading WaaS. The compatibility date is pinned to `2026-09-07`, the newest supported date of the installed test runtime; update it alongside the Workers dependencies and runtime checks.
