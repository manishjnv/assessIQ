import { test, expect } from "@playwright/test";

// X8 (WCAG 2.4.1): the skip link is the first Tab stop and moves focus to <main>.
const PUBLIC_SCREENS = ["/admin/login", "/candidate/login", "/check", "/try", "/take/expired"];

test.describe("skip link on public screens", () => {
  for (const path of PUBLIC_SCREENS) {
    test(`${path}: first Tab shows the link, Enter focuses main`, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator("main")).toHaveCount(1, { timeout: 15_000 });
      await page.keyboard.press("Tab");
      const link = page.getByRole("link", { name: "Skip to main content" });
      await expect(link).toBeFocused();
      expect((await link.boundingBox())?.y).toBeGreaterThanOrEqual(0);
      await page.keyboard.press("Enter");
      await expect(page.locator("main")).toBeFocused();
    });
  }
});
