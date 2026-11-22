import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// In development /api is proxied to the gateway so the refresh cookie stays same-origin.
// Point it elsewhere (e.g. the mock API on :8090) with API_TARGET.
const target = process.env.API_TARGET ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, proxy: { '/api': { target, changeOrigin: false } } },
  preview: { port: 4174, proxy: { '/api': { target } } },
  test: { environment: 'jsdom', globals: true, setupFiles: ['../shared/src/test-setup.ts'], css: false },
});
