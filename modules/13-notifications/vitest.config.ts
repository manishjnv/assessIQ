import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    testTimeout: 60_000, // containers can be slow
    hookTimeout: 60_000,
  },
});
