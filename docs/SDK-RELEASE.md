# Publishing the OMS server wallet SDK

The public package is [`@polygonlabs/oms-server-wallet-sdk`](https://www.npmjs.com/package/@polygonlabs/oms-server-wallet-sdk), with **0.2.0** published as `latest` on 2026-09-18. Registry integrity and an independent npm-installed consumer were verified; see the [release record](SWAPS-VALIDATION.md#published-sdk-020). Publication requires the package owner's authorization. The repository has no automatic publication or deployment workflow. Merging a PR does not publish npm or deploy the demo.

SDK 0.2.0 adds the `/trails` entry point, verified typed-data signing, a durable swap/recovery workflow, chain readers and restricted recovery/owner-deployment operations. The root wallet API remains compatible with 0.1.0. See [the changelog](../packages/server-wallet-sdk/CHANGELOG.md), [backend swaps](SWAPS-INTEGRATION.md) and [deployment handoff](SWAPS-ROLLOUT.md).

Use Node 24+, pnpm 11.8.0 and an npm account authorized under `@polygonlabs`. Complete browser/OTP authentication locally; never put credentials in source, PRs or release reports.

## Prepare without publishing

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:coverage
pnpm test:workers
pnpm cf:check
pnpm test:browser
pnpm test:package
```

`test:package` compiles and packs the SDK into `.data/sdk-release/`, checks the archive's file allowlist, and installs it into an isolated temporary consumer with install scripts disabled. It verifies ESM imports, TypeScript declarations, quote/recovery codecs and encryption and writes `validation.json` with the SHA-512 integrity. CI also uploads this directory as `sdk-release-candidate`; it never publishes it.

Inspect `polygonlabs-oms-server-wallet-sdk-0.2.0.tgz`: only compiled ESM/declarations, package metadata, README/changelog and license/attribution files should be present. There must be no `.env`, application code, tests, databases or credentials. Preserve `NOTICE` and `LICENSE-APACHE-2.0`.

Install the archive into a clean temporary Node project with no workspace aliases. Verify ESM imports of the root and `/trails`, TypeScript compilation, quote validation and a recovery-codec smoke check. Record the archive's SHA-512 integrity and the commit that produced it. A checked local archive is not a published version.

The release and historical preparation reports are in [SWAPS-VALIDATION.md](SWAPS-VALIDATION.md). For a future release, choose a new unpublished version, repack and repeat consumer validation; publish the exact inspected archive. Existing 0.2.0 cannot be published again.

## Publish only with the owner present

The following record the manual 0.2.0 publication procedure. For the next release, update the version and archive path first; do not rerun publication for 0.2.0. These commands are not part of CI:

```sh
npm whoami --registry=https://registry.npmjs.org/
npm view @polygonlabs/oms-server-wallet-sdk versions --json --registry=https://registry.npmjs.org/
npm publish .data/sdk-release/polygonlabs-oms-server-wallet-sdk-0.2.0.tgz --access public --tag latest --registry=https://registry.npmjs.org/
npm view @polygonlabs/oms-server-wallet-sdk@0.2.0 version dist.integrity dist.tarball --json --registry=https://registry.npmjs.org/
```

Stop if 0.2.0 already exists; do not overwrite or silently choose another version. Published name/version pairs cannot be reused. See [npm publishing](https://docs.npmjs.com/cli/v11/commands/npm-publish/).

Compare registry integrity with the reviewed archive, then install the published version by name in another clean consumer and repeat the import/type checks. Record publication only after the registry verifies it. The deployed demo already uses the workspace SDK with swaps enabled; npm publication does not require another deployment. Track further deployments and live acceptance in [SWAPS-ROLLOUT.md](SWAPS-ROLLOUT.md).
