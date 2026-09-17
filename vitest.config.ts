import { defineConfig } from 'vitest/config';
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
  test: {
    include: ['tests/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/server-wallet-sdk/src/**/*.ts', 'apps/server/**/*.ts'],
      exclude: ['apps/server/node.ts', 'apps/server/worker.ts'],
      thresholds: { statements: 80, branches: 70, functions: 80, lines: 80 },
    },
  },
});
