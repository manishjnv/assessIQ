// AssessIQ — axe-core accessibility sweep (Phase 14 gate).
//
// Tests unauthenticated/error pages which render without a real session.
// Admin and candidate pages behind auth are covered separately (see
// Phase 14 open items: auth-seeded axe pass deferred to Phase 15).
//
// Run:  PLAYWRIGHT_BASE_URL=https://assessiq.automateedge.cloud pnpm e2e --grep a11y
// Or locally (Vite dev server auto-starts):  pnpm e2e --grep a11y

import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

function makeA11yTest(path: string, heading: RegExp) {
  test(`${path} has no critical axe violations`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator("body")).not.toContainText("Cannot GET");

    // Wait for React to hydrate before scanning.
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {
      // networkidle can time-out on pages with polling; DOM is still ready.
    });

    // Heading presence is a soft signal that the right component rendered.
    await expect(page.getByRole("heading", { name: heading })).toBeVisible({ timeout: 8_000 });

    const results = await new AxeBuilder({ page })
      // wcag2a + wcag2aa covers Level A and AA.
      .withTags(["wcag2a", "wcag2aa", "best-practice"])
      // Vendor colour-contrast of design tokens is audited separately; exclude
      // here to avoid noisy failures on intentional low-contrast muted text.
      .disableRules(["color-contrast"])
      .analyze();

    expect(results.violations, formatViolations(results.violations)).toHaveLength(0);
  });
}

function formatViolations(
  violations: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"],
): string {
  if (violations.length === 0) return "no violations";
  return violations
    .map(
      (v) =>
        `[${v.impact}] ${v.id}: ${v.description}\n  nodes: ${v.nodes
          .slice(0, 3)
          .map((n) => n.html)
          .join(", ")}`,
    )
    .join("\n");
}

test.describe("A11y sweep — unauthenticated pages", () => {
  makeA11yTest("/take/expired", /expired/i);
  makeA11yTest("/take/error", /(error|something went wrong)/i);

  test("/take/INVALID_TOKEN has no critical axe violations", async ({ page }) => {
    await page.goto("/take/INVALID_TOKEN");
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await expect(page.getByRole("heading", { name: /(invalid|expired|error)/i })).toBeVisible({
      timeout: 10_000,
    });

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "best-practice"])
      .disableRules(["color-contrast"])
      .analyze();

    expect(results.violations, formatViolations(results.violations)).toHaveLength(0);
  });

  test("/* 404 page has no critical axe violations", async ({ page }) => {
    await page.goto("/this-route-does-not-exist-aiq-a11y");
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    // SPA serves index.html for all routes; React renders the 404 component.
    await expect(page.getByRole("heading", { name: /(not found|404|page)/i })).toBeVisible({
      timeout: 8_000,
    });

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "best-practice"])
      .disableRules(["color-contrast"])
      .analyze();

    expect(results.violations, formatViolations(results.violations)).toHaveLength(0);
  });
});
