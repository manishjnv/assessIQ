// Z-88 — phone smoke for the pages that stay phone-usable: /try, the invitation landing,
// candidate sign-in and the candidate result page. Runs in the `mobile` project (Pixel 5).
// It checks that each page renders a heading and does not scroll sideways. It does not start a
// real exam: real exams are desktop-only (Z-87). Mock tests may stay phone-friendly.
import { test, expect, type Page } from '@playwright/test';
import * as factories from './fixtures/factories.js';

async function setCookie(page: Page, cookie: string) {
  const eq = cookie.indexOf('=');
  await page.context().addCookies([
    { name: cookie.slice(0, eq), value: cookie.slice(eq + 1), domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
  ]);
}

// No horizontal page scroll on a phone-width screen (16 px gutter rule: no overflow past the viewport).
async function expectNoSideScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'page must not scroll sideways on a phone').toBeLessThanOrEqual(1);
}

test.describe('phone smoke: pages that stay phone-usable (Z-88)', () => {
  test('/try renders a heading and fits the phone width', async ({ page }) => {
    await page.goto('/try');
    await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 20_000 });
    await expectNoSideScroll(page);
  });

  test('candidate sign-in renders the email field and fits the phone width', async ({ page }) => {
    await page.goto('/candidate/login');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('input[type="email"]').first()).toBeVisible();
    await expectNoSideScroll(page);
  });

  test('signed-in candidate result page renders a heading and fits the phone width', async ({ page }) => {
    const candidate = await factories.mintCandidateSession(`e2e-phone-results-${Date.now()}@test.assessiq`);
    await setCookie(page, candidate.cookie);
    await page.goto('/candidate/results');
    await expect(page.locator('main h1, main h2').first()).toBeVisible({ timeout: 20_000 });
    await expectNoSideScroll(page);
  });

  // A real exam link on a phone shows "open on a laptop or desktop" and no Begin button.
  // A mock link on a phone shows the normal start screen with Begin.
  for (const mode of ['real', 'mock'] as const) {
    test.describe(`invitation landing (${mode})`, () => {
      let inv: factories.ProvisionedInvitations;

      test.beforeAll(async () => {
        test.setTimeout(240_000); // waits for the worker to activate the assessment (60 s cron)
        inv = await factories.provisionInvitations({
          label: `phone-smoke-${mode}`,
          count: 1,
          questionCount: 1,
          deliveryMode: mode,
          makeQuestions: async (sa, packId, levelId) => {
            await factories.createMcqQuestion(sa, packId, levelId, 'E2E phone smoke: pick the correct option.');
          },
        });
      });
      test.afterAll(async () => { await inv?.cleanup(); });

      test(`/take/<token> (${mode}) on a phone`, async ({ page }) => {
        test.setTimeout(120_000);
        await page.goto(inv.paths[0]!);
        if (mode === 'real') {
          await expect(page.getByText(/open this link on a laptop or desktop/i).first()).toBeVisible({ timeout: 60_000 });
          await expect(page.getByRole('button', { name: /^Begin/ })).toHaveCount(0);
        } else {
          await expect(page.getByRole('button', { name: /^Begin/ })).toBeVisible({ timeout: 60_000 });
        }
        await expectNoSideScroll(page);
      });
    });
  }
});
