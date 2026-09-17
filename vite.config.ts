import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'apps/dashboard',
  plugins: [react()],
  server: {
    port: 5187,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/.well-known': 'http://127.0.0.1:8787',
      '/oidc': 'http://127.0.0.1:8787',
    },
  },
  build: { outDir: '../../dist/dashboard', emptyOutDir: true },
});
