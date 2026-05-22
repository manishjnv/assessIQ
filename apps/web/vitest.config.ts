import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const webRoot = fileURLToPath(new URL('.', import.meta.url));

// Vitest config for apps/web — runs component unit tests in jsdom.
// The root vitest.config.ts covers modules/**/__tests__/**/*.test.ts only;
// this config picks up apps/web/src/**/*.test.{ts,tsx}.
// root is anchored to apps/web/ so Vite resolves react + workspace packages
// from the right node_modules even when invoked from the repo root.
export default defineConfig({
  root: webRoot,
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['../../vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
