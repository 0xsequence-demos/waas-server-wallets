# Changelog

## 0.2.0

- Add optional `/trails`: direct v1.5 API transport, exact-input quote validation, chain/token discovery, `EvmChainReader` and `WalletSwaps`.
- Persist activation, sponsored funding, settlement, delayed-deposit repair and separately authorized source/destination recovery. Reconcile uncertain submissions using the original transaction IDs; never send a replacement deposit.
- Coordinate ordinary transfers with pending swap/recovery debits. Introduce `listOperations()` and legacy-operation import support.
- Add verified EIP-712 signing and narrow sponsored owner deployment/recovery operations. Validate Sequence v3 payloads, factory/guest deployment envelopes and hashes before authorizing calls.
- Convert the API's recognized non-delegate utility sweep to direct refunds of reviewed intent-owned balances, retaining the original envelope for audit. Record actual/partial recovery amounts.
- Export durable storage/scheduling contracts and sanitized activity views. Keep application, Workers and UI code outside the package.

The existing root wallet API and WaaS v1.1.0 attestation/authentication contract remain in place. All base-unit amounts use decimal strings. Consumers must supply encrypted durable state and per-wallet exclusive coordination. Funded service acceptance is documented separately in the repository; automated fixtures do not establish live sponsorship compatibility.

## 0.1.0

Initial standalone release: backend OIDC authentication, encrypted credentials and nonce persistence, automatic reauthentication, attested WaaS responses, wallet creation/restore, verified message signing, sponsored native/ERC-20 transfers and indexer balances.
