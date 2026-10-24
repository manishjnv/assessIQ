import { test, expect } from "@playwright/test";

// Z-154: /check is public. No token, no session, no Begin button; the result list stays on the page.
test.describe("/check public device check", () => {
  test("opens without a session and shows the result list", async ({ page }) => {
    const response = await page.goto("/check");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Test your device" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("region", { name: "Readiness check" })).toBeVisible();
    await expect(page.getByText("Screen size")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /begin/i })).toHaveCount(0);
  });
});
