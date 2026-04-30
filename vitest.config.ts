import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "modules/**/__tests__/**/*.test.ts",
      "packages/**/__tests__/**/*.test.ts",
    ],
    setupFiles: ["./vitest.setup.ts"],
    environment: "node",
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
