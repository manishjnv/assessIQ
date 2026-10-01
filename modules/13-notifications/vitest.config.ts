import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    // env fixtures so the real @assessiq/core config loads (result-released-email.test.ts
    // runs against a real Postgres; the older tests mock @assessiq/core wholesale).
    setupFiles: ['../../vitest.setup.ts'],
    include: ['src/__tests__/**/*.test.ts'],
    testTimeout: 60_000, // containers can be slow
    hookTimeout: 60_000,
  },
});
