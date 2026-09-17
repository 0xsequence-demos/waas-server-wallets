# Publishing the OMS server wallet SDK

The public npm package is `@polygonlabs/oms-server-wallet-sdk`. Its source is in `packages/server-wallet-sdk`; the dashboard remains a private application and uses the SDK through a workspace dependency. The initial SDK version is `0.1.0`.

Use Node 24+, the repository's pinned pnpm version, and an npm account authorized to publish under `@polygonlabs`. If npm requires interactive authentication or two-factor verification, complete its browser/OTP flow locally; do not place credentials in source control or release notes.

## Prepare and inspect a release

Update the SDK version in `packages/server-wallet-sdk/package.json` and the pinned installation examples in both READMEs and `docs/NODE-INTEGRATION.md`. Preserve the upstream attribution in `NOTICE` and `LICENSE-APACHE-2.0`.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:workers
pnpm cf:check
mkdir -p /tmp/oms-sdk-release
npm pack ./packages/server-wallet-sdk --pack-destination /tmp/oms-sdk-release
```

The `prepack` hook builds the package. Inspect the resulting archive; it should contain compiled JavaScript, TypeScript declarations, `package.json`, the SDK README, and the license/notice files. Application configuration, `.env`, databases, tests, and the dashboard must not be included.

For version `0.1.0`:

```sh
tar -tzf /tmp/oms-sdk-release/polygonlabs-oms-server-wallet-sdk-0.1.0.tgz
npm publish /tmp/oms-sdk-release/polygonlabs-oms-server-wallet-sdk-0.1.0.tgz --dry-run --access public --registry=https://registry.npmjs.org/
```

Install the archive into a clean temporary Node project and verify an ESM import and TypeScript compilation. This checks the artifact consumers will receive, without workspace source aliases.

## Publish and verify

Check the logged-in account and existing registry versions first:

```sh
npm whoami --registry=https://registry.npmjs.org/
npm view @polygonlabs/oms-server-wallet-sdk versions --json --registry=https://registry.npmjs.org/
```

An npm 404 is expected for a first publication when the package does not yet exist; it can also mean the account cannot access a private package. Confirm the intended organization and package before proceeding. Once published, the same package name and version cannot be reused; see [npm's publishing documentation](https://docs.npmjs.com/cli/v11/commands/npm-publish/).

Publish the exact archive that passed inspection and the consumer check:

```sh
npm publish /tmp/oms-sdk-release/polygonlabs-oms-server-wallet-sdk-0.1.0.tgz --access public --tag latest --registry=https://registry.npmjs.org/
npm view @polygonlabs/oms-server-wallet-sdk@0.1.0 version dist.integrity dist.tarball --json --registry=https://registry.npmjs.org/
```

Finally, install `@polygonlabs/oms-server-wallet-sdk@0.1.0` by name in a clean project and repeat the import/type check. Compare the registry's integrity value with the inspected archive. Record publication success only after verifying the registry result; a successful dry run does not publish a package.
