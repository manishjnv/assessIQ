// Playwright E2E configuration for AssessIQ candidate take-flow.
//
// LOCAL DEV — when PLAYWRIGHT_BASE_URL is unset, this config spins up the
// Vite dev server automatically (port 5173) before running tests.
//
// AGAINST VPS — set the env var to target the deployed SPA, e.g.:
//   PLAYWRIGHT_BASE_URL=https://assessiq.automateedge.cloud pnpm e2e
//
// NOTE on skipped tests: the magic-link backend (POST /api/take/start) is a
// Session 4b deliverable that returns 404 today. Any happy-path test that
// requires a real candidate session (aiq_sess cookie + attempt row) is marked
// `test.skip` with a `// TODO(session-4b)` annotation. The error-page smoke
// tests in take-error-pages.spec.ts run unconditionally.

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",

  fullyParallel: true,

  forbidOnly: !!process.env.CI,

  retries: process.env.CI ? 2 : 0,

  workers: process.env.CI ? 1 : undefined,

  reporter: [["html", { open: "never" }], ["list"]],

  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: "pnpm dev",
        port: 5173,
        timeout: 120_000,
        reuseExistingServer: !process.env.CI,
      },

  projects: [
    // Default project — runs all specs EXCEPT visual.spec.ts.
    {
      name: "chromium",
      testIgnore: /visual\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },

    // Visual-regression project — ONLY runs visual.spec.ts.
    // Snapshots must be generated / compared inside the Linux Docker image
    // (mcr.microsoft.com/playwright:v1.59.1-jammy) for byte-identical renders.
    // CI workflow: .github/workflows/visual-regression.yml
    // Local regeneration: pnpm --filter @assessiq/web visual:update  (inside Docker)
    {
      name: "visual",
      testMatch: /visual\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
});
