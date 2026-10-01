import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "modules/**/__tests__/**/*.test.ts",
      "packages/**/__tests__/**/*.test.ts",
    ],
    setupFiles: ["./vitest.setup.ts"],
    environment: "node",
    // DB tests each start a postgres testcontainer; with many files in parallel the
    // start (+ full migration chain) routinely exceeds the 10 s default hook timeout.
    hookTimeout: 180_000,
    testTimeout: 60_000,
    maxWorkers: 2,
    minWorkers: 1,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: [
        "modules/**/src/**/*.ts",
        "packages/**/src/**/*.ts",
      ],
      exclude: [
        "**/__tests__/**",
        "**/*.d.ts",
      ],
    },
  },
});
