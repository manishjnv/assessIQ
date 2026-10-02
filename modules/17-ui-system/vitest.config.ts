import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // axe runs on large DOM trees take >5s in jsdom; vitest 4 enforces the default timeout
    testTimeout: 30_000,
  },
});
