import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['../../vitest.setup.ts'],
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
