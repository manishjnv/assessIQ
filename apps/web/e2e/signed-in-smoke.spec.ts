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

// Z-23: every admin URL that existed before the 7-group nav must still render. Detail routes
// (/:id) need seeded ids and are covered by admin-workflow.spec.ts.
const ADMIN_PATHS = [
  '/admin', '/admin/start-test', '/admin/assessments', '/admin/attempts', '/admin/grading-jobs',
  '/admin/certificates', '/admin/question-bank', '/admin/reports', '/admin/activity', '/admin/users',
  '/admin/audit-log', '/admin/integrations/webhooks', '/admin/integrations/embed', '/admin/settings',
  '/admin/settings?tab=results', '/admin/settings?tab=privacy', '/admin/settings?tab=plan',
  '/admin/settings/billing', '/admin/tenant-settings', '/admin/guide', '/admin/account-security',
];
const NAV_LABELS = ['Home', 'Assessments', 'Question bank', 'Reports', 'People', 'Integrations', 'Settings'];

for (const path of ADMIN_PATHS) {
  test(`signed-in admin ${path}: heading, nav, no console errors`, async ({ page }) => {
    const s = await factories.mintAdminSession(factories.SEEDED_TENANT_ADMIN);
    await setCookie(page, s.cookie);
    await openAndCheck(page, path, 'nav, aside');
    for (const label of NAV_LABELS) await expect(page.locator('aside, nav').getByRole('link', { name: label, exact: true }).first()).toBeVisible();
  });
}

test('signed-in candidate home: heading, nav, no console errors', async ({ page }) => {
  const s = await factories.mintCandidateSession(`smoke-${Date.now()}@test.assessiq`);
  await setCookie(page, s.cookie);
  await openAndCheck(page, '/candidate/results', 'nav, header');
});
