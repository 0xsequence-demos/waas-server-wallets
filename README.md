# OMS server wallet dashboard

A TypeScript prototype for operating OMS wallets from a shared administrator dashboard. Targets WaaS **v1.1.0** with backend OIDC identities, automatic credential renewal, attested responses, native/ERC-20 transfers with mandatory gas sponsorship, verified plain-message signing, and durable Trails swaps with reviewed recovery.

Supports Polygon, Arbitrum, Base, BNB Chain, and Ethereum Mainnet. One immutable application identifier maps to one EVM wallet across these networks. The application controls authorization; wallet signing keys remain in WaaS.

The wallet list and detail header show the combined USD value of native assets and ERC-20 tokens across the supported networks. Balances and prices come from the indexer gateway, including subsequent pages; unavailable prices or incomplete results are marked as partial.

Wallet details have shareable URLs at `/wallets/<wallet-id>`. Browser Back/Forward and refresh preserve the selected page, and signing in from a wallet link returns to that wallet. Open wallet links in a new tab with the usual browser controls.

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

SDK **0.2.0 is prepared for publication**, with the complete swap module. Until the owner publishes it, use the inspected local archive from [the release guide](docs/SDK-RELEASE.md); npm still serves 0.1.0. After publication, install:

```sh
npm install @polygonlabs/oms-server-wallet-sdk@0.2.0
```

Follow the [Node.js / TypeScript integration walkthrough](docs/NODE-INTEGRATION.md), covering OIDC registration, credentials, wallet creation, signing, and transaction sending. The dashboard uses the same package through a workspace dependency for local development. See also the [detailed specification](docs/SPEC.md), [SDK API and integration contract](packages/server-wallet-sdk/README.md), and [SDK release procedure](docs/SDK-RELEASE.md).

Swaps and bridges are implemented at `/wallets/<id>/swap`, with persistent activity at `/wallets/<id>/swaps/<swap>`. They use a separate backend Trails key, curated assets and fresh chain reads. Node runs a persistent SQLite scheduler; Workers use per-wallet alarms. The deployed demo enables swaps for operator testing; local configuration defaults to paused. Funded acceptance remains pending. See [backend SDK swaps](docs/SWAPS-INTEGRATION.md) and the [publication/deployment handoff](docs/SWAPS-ROLLOUT.md).

## Verification

```sh
pnpm check              # typecheck, lint, Node tests, SDK/UI production builds
pnpm test:coverage      # coverage report and enforced minimums
pnpm test:workers       # actual Workers crypto, Durable Object, and D1 tests
pnpm cf:check           # bundle validation only; does not deploy
pnpm test:package       # pack + isolated SDK consumer validation; does not publish
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

Swap implementation checks and the exact prepared SDK archive are recorded in [swap validation](docs/SWAPS-VALIDATION.md). Publication, deployment and funded swap/recovery acceptance remain separate next-session steps.

## Prototype boundaries

- Shared password and server-side eight-hour admin sessions; no individual users or roles.
- Plain messages, native/ERC-20 transfers, and exact-input swaps/bridges between curated assets. No arbitrary contract-call endpoint.
- Activity shows the latest 50 ordinary operations and paginated swap/recovery history, not full on-chain history.
- Disable persists locally before attempting self-revocation. If revocation fails, the wallet stays disabled and re-enable retries revocation.
- Uncertain submissions are reconciled by transaction ID; they are never automatically submitted again. An uncertain wallet creation with no discoverable result stays blocked pending upstream reconciliation.
- Encryption-key replacement requires a data migration; there is no automatic encryption-key rotation or disaster-recovery UI.

Attestation source and fixtures adapted from the OMS Wallet TypeScript SDK retain their [Apache attribution](packages/server-wallet-sdk/NOTICE).
