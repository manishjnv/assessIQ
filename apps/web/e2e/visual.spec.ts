// AssessIQ — Playwright visual regression baseline (Phase 14 / P14).
//
// IMPORTANT — snapshot platform contract
// ----------------------------------------
// Snapshot PNGs are generated and compared inside the official Playwright
// Docker image (mcr.microsoft.com/playwright:v1.59.1-jammy) so that font
// hinting, sub-pixel antialiasing, and GPU-compositing are byte-identical
// across every CI run.  Committing PNGs rendered on a Windows/macOS developer
// machine will ALWAYS cause false failures on Linux CI.
//
// Workflow:
//   1. Generate baselines on CI (or in Docker locally — see docs/11-observability.md § 32).
//   2. Commit the PNGs produced by the Docker run.
//   3. PRs compare against those committed PNGs inside the same Docker image.
//
// Run (CI / Docker):
//   pnpm --filter @assessiq/web visual:run
//
// Regenerate baselines (inside Docker image only):
//   pnpm --filter @assessiq/web visual:update
//
// This spec is ONLY wired to the `visual` Playwright project.  It will not run
// during the default `pnpm e2e` invocation (which targets the `chromium`
// project) and will not appear unless `--project=visual` is passed.

import { test, expect } from "@playwright/test";

// Guard: skip entirely on non-Linux platforms so a developer on Windows/macOS
// doesn't accidentally generate local PNGs that later break CI.
// The `visual` project filter in playwright.config.ts is the primary guard;
// this skip is a belt-and-suspenders fallback.
test.beforeEach(async ({}, testInfo) => {
  if (process.platform !== "linux") {
    testInfo.skip(
      true,
      "Visual snapshots must be generated/compared inside the Linux Docker image " +
        "(mcr.microsoft.com/playwright:v1.59.1-jammy). " +
        "Run `pnpm --filter @assessiq/web visual:update` inside Docker to create baselines.",
    );
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Navigate to `path`, wait for network idle + a visible heading, then snapshot. */
async function visualTest(
  page: import("@playwright/test").Page,
  path: string,
  headingPattern: RegExp,
  snapshotName: string,
) {
  await page.goto(path);

  // Same network-idle pattern as a11y.spec.ts — tolerates pages with polling.
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

  // Heading visibility confirms the right component rendered before we snapshot.
  await expect(page.getByRole("heading", { name: headingPattern })).toBeVisible({
    timeout: 8_000,
  });

  // maxDiffPixels: 200 absorbs minor per-run font kerning / sub-pixel drift.
  // Tune upward if CI is flaky; tune downward once baselines are proven stable.
  await expect(page).toHaveScreenshot(snapshotName, {
    fullPage: true,
    maxDiffPixels: 200,
  });
}

// ---------------------------------------------------------------------------
// Tests — one per unauthenticated route (mirrors the Lighthouse CI / axe set)
// ---------------------------------------------------------------------------

test.describe("Visual regression — unauthenticated pages", () => {
  test("/admin/login matches baseline", async ({ page }) => {
    await visualTest(page, "/admin/login", /(sign in|log in|admin|login)/i, "admin-login.png");
  });

  test("/candidate/login matches baseline", async ({ page }) => {
    await visualTest(
      page,
      "/candidate/login",
      /(sign in|log in|candidate|login|enter|magic)/i,
      "candidate-login.png",
    );
  });

  test("/take/expired matches baseline", async ({ page }) => {
    await visualTest(page, "/take/expired", /expired/i, "take-expired.png");
  });

  test("/take/error matches baseline", async ({ page }) => {
    await visualTest(
      page,
      "/take/error",
      /(error|something went wrong)/i,
      "take-error.png",
    );
  });

  test("/* 404 page matches baseline", async ({ page }) => {
    await visualTest(
      page,
      "/this-route-does-not-exist-aiq-visual",
      /(not found|404|page)/i,
      "404.png",
    );
  });
});
