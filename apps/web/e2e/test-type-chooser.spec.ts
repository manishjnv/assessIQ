// Z-143 smoke: the three test type cards on Create a test at 1280 / 820 / 375 px.
// Picks each card, checks aria-checked, the column count and that the page does not scroll sideways.
// Needs the local stack (local-stack.sh) for the admin session; the camera settings call is mocked.
import { test, expect, type Page } from '@playwright/test';
import * as factories from './fixtures/factories.js';

const WIDTHS: Array<[number, number]> = [[1280, 3], [820, 2], [375, 1]];

async function openStartTest(page: Page) {
  const s = await factories.mintAdminSession(factories.SEEDED_TENANT_ADMIN);
  const eq = s.cookie.indexOf('=');
  await page.context().addCookies([
    { name: s.cookie.slice(0, eq), value: s.cookie.slice(eq + 1), domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
  ]);
  await page.route('**/api/admin/camera/settings', (r) =>
    r.fulfill({ json: { isSchool: false, cameraEnforced: true, cameraEnabled: true, photosEnabled: true, noticeConfirmedVersion: null, requiredNoticeVersion: 'v1', storage: { usedBytes: 0, maxBytes: 1, warn: false } } }));
  await page.goto('/admin/create-test');
  await expect(page.getByRole('radiogroup', { name: 'Test type' })).toBeVisible({ timeout: 20_000 });
}

for (const [width, cols] of WIDTHS) {
  test(`test type cards at ${width}px: ${cols} column(s), each card selectable, no sideways scroll`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openStartTest(page);

    const radios = page.getByRole('radio', { name: /^(Mock|Real|Real \+ camera)$/ });
    await expect(radios).toHaveCount(3);
    await expect(page.getByRole('radio', { name: 'Real', exact: true })).toHaveAttribute('aria-checked', 'true');

    const lefts = await page.locator('[data-testid^="test-type-card-"]').evaluateAll((els) =>
      new Set(els.map((e) => Math.round(e.getBoundingClientRect().left))).size);
    expect(lefts).toBe(cols);

    for (const name of ['Mock', 'Real + camera', 'Real']) {
      await page.getByRole('radio', { name, exact: true }).click();
      await expect(page.getByRole('radio', { name, exact: true })).toHaveAttribute('aria-checked', 'true');
    }
    // Keyboard: arrow moves the choice.
    await page.getByRole('radio', { name: 'Real', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'Real + camera', exact: true })).toHaveAttribute('aria-checked', 'true');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow, 'page scrolls sideways').toBe(false);
    expect(errors).toEqual([]);
  });
}
