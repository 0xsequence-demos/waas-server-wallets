# OMS dev acceptance — 2026-09-17

Deployment: [OMS server wallet dashboard](https://oms-server-wallet-dashboard.0xsequence.workers.dev), Cloudflare version `62b4bc1a-c5ed-4de7-8ebd-385d2f5de305` in account `b6c780e2a453a8593576535e3e81a7cd`.

The configured publishable key selects `https://sandbox-api.dev.polygon-dev.technology`. The backend sends `Origin: https://oms-server-wallet-dashboard.0xsequence.workers.dev` on both WaaS and indexer requests. OIDC JWT audience is `api.dev.polygon-dev.technology`. Dev's operator-approved PCR0 is 96 hexadecimal zeros. Attestation verification remains mandatory; the all-zero measurement is rejected for production environments.

The verified public `POST /v1/WaasPublic/Status` response reports version `dev-20260911-6491d235` and environment `dev`. The project targets the v1.1.0 protocol; the deployed service identifies itself with that dev build string.

## Verified against live services

| Check                                                            | Result                                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Public issuer discovery/JWKS and administrator login             | Passed                                                                      |
| Attested OIDC commit/authentication with the registered audience | Passed                                                                      |
| Wallet creation and repeat identifier reuse                      | Same wallet returned                                                        |
| Restore after Worker deployment                                  | Same wallet and persisted credentials                                       |
| Native balances on Polygon, Arbitrum, Base, BNB, Ethereum        | Five successful responses, no indexer errors; all zero                      |
| Plain-message signing and verification on all five chains        | Passed                                                                      |
| Repeating the same signing operation ID                          | Same stored signature returned                                              |
| Credential rotation                                              | Credential changes; address preserved                                       |
| Disable and re-enable                                            | Signing blocked while disabled; access restored to the same wallet          |
| Independent Node SDK after remote credential revocation          | Automatic authentication, wallet binding, and verified signing succeed      |
| Hosted browser with Nix Chromium                                 | Login, wallet detail, real signing and verified result pass; no page errors |
| Polygon 1-wei native self-transfer preparation                   | `sponsored: true`, valid quote received                                     |

Dashboard identity: `acceptance-2026-09-17`.

Wallet: `0xD54A9952C7eA8c16B6fcC9A572B0B47F81127481` (EVM smart wallet).

The separate standalone-SDK identity is `acceptance-sdk-2026-09-17`, address `0x6dF0cC7E3669732021A87aDE490Ff3f024888fb0`. Its final credential was revoked and its local SDK state disabled after the check.

Regression validation: 46 Node/API tests, 5 Workers runtime tests, and 2 fixture browser tests pass. Type checking, linting, SDK/UI builds, and Worker bundle validation pass. Measured Node-suite line coverage is 90.63% overall and 90.58% for the SDK.

**Not yet verified live:** funded transfer submission/confirmation, ERC-20 balances/transfers, and transfer execution on the other four chains. No transaction has been submitted. Automatic expiry recovery is covered by regression tests; live recovery was exercised using remote revocation rather than waiting six hours for expiry.

## Repeat the checks

The scripts read `.env` without printing secrets. They use dedicated acceptance identities, produce real signatures, and rotate/revoke test credentials. The default API script never sends funds.

```sh
pnpm check
pnpm test:coverage
pnpm test:workers
pnpm test:live

# Prepare a sponsored 1-wei Polygon self-transfer without executing it.
LIVE_PREPARE_SELF_TRANSFER=1 pnpm test:live

# Test the compiled standalone SDK, including automatic recovery from revocation.
node --import tsx --env-file=.env scripts/live-sdk-acceptance.ts

# Supply a Nix Chromium executable on NixOS.
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$(command -v chromium)" \
  node --import tsx --env-file=.env scripts/live-browser-acceptance.ts
```

The API report is written to `.data/live-acceptance.json`, encrypted standalone SDK state to `.data/live-sdk-encrypted.json`, and the browser screenshot to `test-results/live-dashboard.png`. These are ignored by Git. The browser script expects the API acceptance wallet to exist.

For the remaining funded test, fund the dashboard acceptance address with a tiny amount of POL on Polygon mainnet. Explicit execution opt-in prepares and sends exactly 1 wei to that same address, requires `sponsored: true`, and polls the existing operation without resubmitting an uncertain execution:

```sh
LIVE_PREPARE_SELF_TRANSFER=1 LIVE_EXECUTE_SELF_TRANSFER=1 pnpm test:live
```

If execution is uncertain, retain the operation ID from the report/activity and reconcile it. Do not repeat the command as a substitute for reconciliation; each run creates a new operation ID.

## Compatibility corrections found during live testing

- Separate the request-header public key from the RPC credential ID: WaaS hashes the key type and compressed P-256 key with SHA-256. The returned hash is checked against the local key, and revocation uses that hash. [WaaS key definition](https://github.com/0xsequence/waas/blob/6491d235805bb1df05b8e765918dfc75fe36208a/proto/key.go).
- Use fetch `redirect: 'manual'` and reject redirect responses. Workers does not implement `redirect: 'error'`; the Workers regression test constructs the actual request options.
- Supply `networkFamily: 'evm'` when verifying a signature by wallet address. [WaaS verification tests](https://github.com/0xsequence/waas/blob/6491d235805bb1df05b8e765918dfc75fe36208a/tests/verify_signature_test.go).
- Recover once from attested revoked-credential responses (`7207`) as well as unknown/expired keys. These are rejected by credential middleware before operation execution. Disabled wallets remain disabled. [WaaS credential middleware](https://github.com/0xsequence/waas/blob/6491d235805bb1df05b8e765918dfc75fe36208a/rpc/credential/middleware.go).
