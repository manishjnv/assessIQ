import { test, expect } from '@playwright/test';

// CT-2 smoke: /admin/create-test in headless Chromium, the HTTP API is mocked with page.route (no backend).
// Fills the whole-set path, presses "Save as draft", asserts the POST body and the "Draft saved" result.

test('Create a test: whole set, Save as draft sends the body and shows Draft saved', async ({ page }) => {
  let posted: unknown = null;
  // Registered first = lowest priority: any other call gets an empty 204.
  await page.route((url) => url.pathname.startsWith('/api/'), (r) => r.fulfill({ status: 204 }));
  await page.route('**/api/auth/whoami', (r) =>
    r.fulfill({
      json: {
        user: { id: 'u-admin', email: 'admin@test.assessiq', name: 'Test Admin', role: 'admin' },
        tenant: { id: 't-smoke', slug: 'smoke', name: 'Smoke Org' },
        mfaStatus: 'verified',
        totpEnrolled: true,
      },
    }),
  );
  await page.route('**/api/billing/usage', (r) => r.fulfill({ json: { credits: { unlimited: true } } }));
  await page.route('**/api/billing/available-sets', (r) =>
    r.fulfill({ json: { sets: [{ source_pack_id: 'p1', name: 'Aptitude', domain: 'apt', source_version: 1, question_count: 500, level_count: 2, level_minutes: [45, 60], cloned: true, cloned_pack_id: 'c1', update_available: false }] } }));
  await page.route('**/api/admin/blueprints', (r) => r.fulfill({ json: { items: [] } }));
  await page.route('**/api/admin/camera/settings', (r) =>
    r.fulfill({ json: { isSchool: false, cameraEnforced: true, cameraEnabled: true, photosEnabled: true, noticeConfirmedVersion: null, requiredNoticeVersion: 'v1', storage: { usedBytes: 0, maxBytes: 1, warn: false } } }));
  await page.route('**/api/admin/sets/p1/import', (r) => r.fulfill({ json: { cloned_pack_id: 'c1', slug: 'apt', reused: true, question_count: 500 } }));
  await page.route('**/api/admin/packs/c1', (r) => r.fulfill({ json: { levels: [{ id: 'lv1', position: 1 }, { id: 'lv2', position: 2 }] } }));
  await page.route('**/api/admin/tests', (r) => {
    posted = r.request().postDataJSON();
    return r.fulfill({ status: 201, json: { assessment: { id: 'as1' }, warnings: [] } });
  });

  await page.goto('/admin/create-test');
  await page.getByLabel('Question set').selectOption('p1');
  await page.getByLabel(/Number of questions/).fill('40');
  await page.getByRole('radio', { name: 'Mock', exact: true }).click();
  await page.getByRole('button', { name: 'Save as draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible();
  expect(posted).toMatchObject({
    pack_id: 'c1', level_id: 'lv1', cover: { kind: 'whole', question_count: 40 }, delivery_mode: 'mock',
    settings: { integrity: { fullscreen: false, block_copy_paste: false } },
  });
  await expect(page.getByRole('link', { name: /Open assessment/ })).toHaveAttribute('href', '/admin/assessments/as1');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow, 'page scrolls sideways').toBe(false);
});
