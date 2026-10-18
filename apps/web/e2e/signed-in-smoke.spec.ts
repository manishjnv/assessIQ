// Z-47 — signed-in smoke check for the post-deploy sweep. Mints an admin and a candidate session
// (dev minter, see local-stack.sh) and opens the main pages. Each page needs a heading, a left nav
// and zero console errors. This catches crashes that only happen after sign-in (RCA 2026-10-18).
import { test, expect, type Page } from '@playwright/test';
import * as factories from './fixtures/factories.js';

async function setCookie(page: Page, cookie: string) {
  const eq = cookie.indexOf('=');
  await page.context().addCookies([
    { name: cookie.slice(0, eq), value: cookie.slice(eq + 1), domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
  ]);
}

async function openAndCheck(page: Page, path: string, nav: string) {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(path);
  await expect(page.locator('main h1, main h2').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(nav).first()).toBeVisible();
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  expect(errors, `console errors on ${path}`).toEqual([]);
}

const ADMIN_PATHS = ['/admin', '/admin/assessments', '/admin/attempts', '/admin/question-bank', '/admin/settings'];

for (const path of ADMIN_PATHS) {
  test(`signed-in admin ${path}: heading, nav, no console errors`, async ({ page }) => {
    const s = await factories.mintAdminSession(factories.SEEDED_TENANT_ADMIN);
    await setCookie(page, s.cookie);
    await openAndCheck(page, path, 'nav, aside');
  });
}

test('signed-in candidate home: heading, nav, no console errors', async ({ page }) => {
  const s = await factories.mintCandidateSession(`smoke-${Date.now()}@test.assessiq`);
  await setCookie(page, s.cookie);
  await openAndCheck(page, '/candidate/results', 'nav, header');
});
