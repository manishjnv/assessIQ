import { defineConfig } from "vitest/config";

// jsdom environment for React component tests. The root vitest.config.ts
// uses 'node' which can't render JSX. testTimeout matches the workspace
// pattern from modules with testcontainer suites — components don't need
// it but it costs nothing.
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["../../vitest.setup.ts", "./src/__tests__/setup.ts"],
    include: ["src/__tests__/**/*.test.ts", "src/__tests__/**/*.test.tsx"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
