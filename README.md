# OMS server wallet dashboard

A TypeScript prototype for operating OMS wallets from a shared administrator dashboard. Targets WaaS **v1.1.0** with backend OIDC identities, automatic credential renewal, attested responses, native/ERC-20 transfers with mandatory gas sponsorship, and verified plain-message signing.

Supports Polygon, Arbitrum, Base, BNB Chain, and Ethereum Mainnet. One immutable application identifier maps to one EVM wallet across these networks. The application controls authorization; wallet signing keys remain in WaaS.

The wallet list and detail header show the combined USD value of native assets and ERC-20 tokens across the supported networks. Balances and prices come from the indexer gateway, including subsequent pages; unavailable prices or incomplete results are marked as partial.

## Run locally

Requires Node 24+ and pnpm 11.8.0. No `wrangler dev` or Cloudflare emulator is involved in local development.

```sh
pnpm install --frozen-lockfile
pnpm setup
pnpm dev
```

Open **http://127.0.0.1:5187**. Sign in with `ADMIN_PASSWORD` from the generated, git-ignored `.env`. Setup preserves an existing `.env`; it does not print secrets. The dashboard starts before OMS is configured and identifies the missing settings. Local persistence is `.data/dashboard.sqlite`; the API binds to `127.0.0.1:8787`. These are a single Node process and persistent SQLite, not an in-memory demo.

Live wallet actions require an OMS publishable key, trusted enclave measurements, and a public HTTPS issuer registered in OMS. Follow [deployment and registration](docs/DEPLOYMENT.md). Local execution can use the deployed issuer URL if its signing key and audience match the local configuration. Keep `APP_ORIGIN=http://127.0.0.1:5187` locally. Local and deployed catalogs are separate; avoid operating the same identity from both simultaneously.

## Layout

| Path                         | Purpose                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `apps/dashboard`             | React/Vite dashboard, login, wallets, balances, transfers, signing, activity.  |
| `apps/server`                | Shared Hono API, backend OIDC issuer, admin sessions, Node/Worker adapters.    |
| `packages/server-wallet-sdk` | Standalone SDK with no application/framework or embedded SDK dependency.       |
| `migrations`                 | SQLite/D1 registry, operations, audit, and admin-session schema.               |
| `tests`                      | SDK/protocol/crypto/API tests, browser fixtures, actual Workers runtime tests. |

On Cloudflare, one Worker serves assets, API, discovery, and JWKS. D1 stores the catalog, sessions, audit events, and operation summaries. A SQLite Durable Object per wallet owns encrypted credentials, nonces, and authoritative operation state and serializes calls. Node uses the same SDK and API with SQLite and per-wallet in-process executors. Do not run multiple Node processes against the same local database.

See the [detailed specification](docs/SPEC.md) and [SDK API and integration contract](packages/server-wallet-sdk/README.md).

## Verification

```sh
pnpm check              # typecheck, lint, Node tests, SDK/UI production builds
pnpm test:coverage      # coverage report and enforced minimums
pnpm test:workers       # actual Workers crypto, Durable Object, and D1 tests
pnpm cf:check           # bundle validation only; does not deploy
pnpm test:browser       # isolated Vite server on 5187; stop pnpm dev first
pnpm test:live          # explicit live dev acceptance; creates a dedicated wallet, sends no transactions
```

Browser tests require Chromium. On standard Linux CI, use `pnpm exec playwright install --with-deps chromium`. On NixOS, use an installed Nix Chromium:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$(command -v chromium)" pnpm test:browser
```

The Node and browser suites do not require workerd. The separate Workers suite does. CI runs both suites and validates the deployment bundle. Browser tests intercept API responses; they never simulate a live transaction in the application itself. The Nitro fixture is a real signed document with a fixed historical test clock.

**Live dev acceptance verified on 2026-09-17:** [the deployed dashboard](https://oms-server-wallet-dashboard.0xsequence.workers.dev) authenticates with audience `api.dev.polygon-dev.technology` and the operator-approved all-zero debug PCR0. Wallet creation/restore, balances and verified message signatures on all five chains, rotation, disable/re-enable, persistence across deployments, and real browser signing pass. The independent Node SDK also recovers automatically after remote credential revocation.

A Polygon self-transfer quote was verified as sponsored. **Funded transfer execution remains untested.** See [live acceptance results and repeatable commands](docs/LIVE-ACCEPTANCE.md).

## Prototype boundaries

- Shared password and server-side eight-hour admin sessions; no individual users or roles.
- Plain messages and native/ERC-20 transfers only. Token choices come from indexed assets with known decimals.
- Activity shows the latest 50 operations initiated here, not full on-chain history.
- Disable persists locally before attempting self-revocation. If revocation fails, the wallet stays disabled and re-enable retries revocation.
- Uncertain submissions are reconciled by transaction ID; they are never automatically submitted again. An uncertain wallet creation with no discoverable result stays blocked pending upstream reconciliation.
- Encryption-key replacement requires a data migration; there is no automatic encryption-key rotation or disaster-recovery UI.

Attestation source and fixtures adapted from the OMS Wallet TypeScript SDK retain their [Apache attribution](packages/server-wallet-sdk/NOTICE).
