import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Inherit env fixtures from root (DATABASE_URL/REDIS_URL/ASSESSIQ_MASTER_KEY/etc.).
    setupFiles: ['../../vitest.setup.ts'],
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
