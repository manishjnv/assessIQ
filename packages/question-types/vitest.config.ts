import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"], setupFiles: ["../../vitest.setup.ts"] }, // setup supplies env for the parity test (imports module code)
});
