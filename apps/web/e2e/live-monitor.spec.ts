// X6a smoke: the live monitor page at 1280 and 375 px. Counts show, one in-progress row shows,
// the page does not scroll sideways. The live-monitor call is mocked.
// Needs the local stack (local-stack.sh) for the admin session.
import { test, expect } from '@playwright/test';
import * as factories from './fixtures/factories.js';

const ASSESSMENT = '00000000-0000-4000-8000-0000000000a1';

for (const width of [1280, 375]) {
  test(`live monitor at ${width}px: counts, one row, no sideways scroll`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const s = await factories.mintAdminSession(factories.SEEDED_TENANT_ADMIN);
    const eq = s.cookie.indexOf('=');
    await page.context().addCookies([
      { name: s.cookie.slice(0, eq), value: s.cookie.slice(eq + 1), domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
    ]);
    const now = Date.now();
    await page.route(`**/api/admin/assessments/${ASSESSMENT}/live-monitor`, (r) =>
      r.fulfill({
        json: {
          counts: { invited: 12, not_started: 5, in_progress: 1, submitted: 6 },
          in_progress: [{
            attempt_id: 'a1', user_id: 'u1', name: 'Asha Rao', email: 'asha@example.test',
            started_at: new Date(now - 20 * 60_000).toISOString(), last_seen_at: new Date(now - 30_000).toISOString(),
          }],
          server_time: new Date(now).toISOString(),
        },
      }));
    await page.goto(`/admin/assessments/${ASSESSMENT}/live`);
    await expect(page.getByRole('heading', { name: 'Live monitor.' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('group', { name: 'Candidate counts' })).toContainText('12');
    await expect(page.getByText('Asha Rao')).toBeVisible();
    await expect(page.getByText('30s ago')).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow, 'page scrolls sideways').toBe(false);
    expect(errors).toEqual([]);
  });
}
