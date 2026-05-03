import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['../../vitest.setup.ts'],
    testTimeout: 120_000, // testcontainer startup
    hookTimeout: 120_000,
  },
});
