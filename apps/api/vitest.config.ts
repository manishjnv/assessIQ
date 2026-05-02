import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['../../vitest.setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
