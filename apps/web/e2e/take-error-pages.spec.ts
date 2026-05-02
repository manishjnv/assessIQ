import { test, expect } from "@playwright/test";

test.describe("/take error states (Session 4a smoke)", () => {
  test("/take/INVALID_TOKEN renders the branded error page, not 500/blank", async ({ page }) => {
    const response = await page.goto("/take/INVALID_TOKEN");
    // SPA must serve 200 (Vite serves index.html for all unknown routes); the
    // error page renders client-side after takeStart() rejects.
    expect(response?.status()).toBe(200);
    // Wait for the React app to render the error UI.
    await expect(page.getByRole("heading", { name: /(invalid|expired|error)/i })).toBeVisible({ timeout: 10_000 });
    // No raw "Cannot GET" or unhandled error.
    await expect(page.locator("body")).not.toContainText("Cannot GET");
    await expect(page.locator("body")).not.toContainText("undefined is not");
  });

  test("/take/expired renders the expired page", async ({ page }) => {
    await page.goto("/take/expired");
    await expect(page.getByRole("heading", { name: /expired/i })).toBeVisible();
  });

  test("/take/error renders the error page", async ({ page }) => {
    await page.goto("/take/error");
    await expect(page.getByRole("heading", { name: /(error|something went wrong)/i })).toBeVisible();
  });
});
