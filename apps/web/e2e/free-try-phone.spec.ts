// T-54: smoke of the free no-login test (/try) on a 390 px phone, Mock and Real, plus Real mode in a browser
// without element full screen (iPhone Safari). Client-only page: no API, no login, no database.
// Run (starts the Vite dev server by itself, see playwright.config.ts):
//   cd apps/web && pnpm exec playwright test free-try-phone --project=chromium
// The config's `mobile` project only matches phone-smoke and phone-first-question, so the phone profile is set
// here with test.use (Pixel 7 profile, viewport forced to 390 x 844).
import { test, expect, devices, type Page } from '@playwright/test';

test.use({ ...devices['Pixel 7'], viewport: { width: 390, height: 844 } });

async function expectNoSideScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'page must not scroll sideways at 390 px').toBeLessThanOrEqual(0);
}

// Visible picker and intro links and buttons under 44 px high. The take page uses shared parts: see the T-54 report.
async function expectTapTargets(page: Page, selector: string): Promise<void> {
  const small = await page.evaluate((sel) => {
    return [...document.querySelectorAll<HTMLElement>(sel)]
      .map((e) => ({ t: (e.textContent ?? '').trim().slice(0, 30), h: Math.round(e.getBoundingClientRect().height) }))
      .filter((x) => x.h > 0 && x.h < 44);
  }, selector);
  expect(small, 'tap targets under 44 px').toEqual([]);
}

async function runMode(page: Page, mode: 'mock' | 'real'): Promise<void> {
  await page.goto(`/try/aptitude/easy${mode === 'real' ? '?mode=real' : ''}`);
  await expectNoSideScroll(page);
  await expectTapTargets(page, 'main a, main button');
  await page.locator('[data-test-id=try-begin]').click();

  await expect(page.locator('.aiq-attempt-q-text')).toBeVisible();
  // timer bar: the top bar shows a countdown like 07:59
  await expect(page.getByText(/^\d{1,2}:\d{2}$/).first()).toBeVisible();
  await expectNoSideScroll(page);
  const options = page.getByRole('radio');
  expect(await options.count()).toBeGreaterThanOrEqual(2);
  const box = await page.locator('label:has(input[type=radio])').first().boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await options.first().check({ force: true });

  // navigator bottom sheet opens and closes
  await page.getByRole('button', { name: /open all questions/i }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  await expectNoSideScroll(page);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  // finish summary, then submit
  await page.getByRole('button', { name: /Finish assessment/i }).first().click();
  await expect(page.getByRole('button', { name: /Submit assessment/i })).toBeVisible();
  await expectNoSideScroll(page);
  await page.getByRole('button', { name: /Submit assessment/i }).click();
  await page.getByRole('button', { name: /Submit now/i }).click();
  await expect(page.locator('[data-test-id=free-score]')).toBeVisible();
  await expectNoSideScroll(page);
}

test.describe('free /try on a 390 px phone', () => {
  test('pickers fit and have 44 px tap targets', async ({ page }) => {
    for (const path of ['/try', '/try/aptitude']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoSideScroll(page);
      await expectTapTargets(page, 'main a');
    }
  });

  test('Mock: start, timer, sheet, finish shows the result', async ({ page }) => {
    await runMode(page, 'mock');
    await expect(page.getByText(/correct \(\d+%\)/)).toBeVisible();
  });

  test('Real with full screen: starts and finishes', async ({ page }) => {
    await runMode(page, 'real');
  });

  test('Real without element full screen (iPhone Safari): student can start and sees the note', async ({ page }) => {
    await page.addInitScript(() => {
      // iOS Safari has no element full screen.
      delete (Element.prototype as { requestFullscreen?: unknown }).requestFullscreen;
      delete (Element.prototype as { webkitRequestFullscreen?: unknown }).webkitRequestFullscreen;
    });
    await page.goto('/try/aptitude/easy?mode=real');
    expect(await page.evaluate(() => typeof document.documentElement.requestFullscreen)).toBe('undefined');
    await page.locator('[data-test-id=try-begin]').click();
    await expect(page.getByText('Full screen is not available here. Keep this tab open.')).toBeVisible();
    await expect(page.locator('.aiq-attempt-q-text')).toBeVisible();
    await expect(page.getByText('Practice · Real')).toBeVisible();
    await expectNoSideScroll(page);
  });
});
