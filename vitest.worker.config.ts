import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { generateKeyPair, exportJWK } from 'jose';

const pair = await generateKeyPair('ES256', { extractable: true });
export default defineConfig({
  resolve: {
    alias: {
      '@polygonlabs/oms-server-wallet-sdk/trails': new URL(
        './packages/server-wallet-sdk/src/trails/index.ts',
        import.meta.url,
      ).pathname,
      '@polygonlabs/oms-server-wallet-sdk': new URL(
        './packages/server-wallet-sdk/src/index.ts',
        import.meta.url,
      ).pathname,
    },
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          ADMIN_PASSWORD: 'worker-test-password',
          SESSION_SECRET: 'test-session-secret-'.repeat(3),
          ENCRYPTION_KEY: btoa('k'.repeat(32)),
          OIDC_PRIVATE_JWK: JSON.stringify(await exportJWK(pair.privateKey)),
          OIDC_ISSUER: 'https://issuer.example',
          OIDC_AUDIENCE: 'test',
          OMS_PUBLISHABLE_KEY: 'pk_dev_live_test_key',
          TRUSTED_PCR0S: '0'.repeat(96),
          APP_ORIGIN: 'https://issuer.example',
        },
      },
    }),
  ],
  test: { include: ['tests/worker/*.test.ts'] },
});
