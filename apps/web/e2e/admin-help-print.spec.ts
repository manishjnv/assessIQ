// Z-21 + Z-6 on the real backend (apps/web/e2e/local-stack.sh):
//   - admin help drawer: trigger and Ctrl+/ open it, both tabs render, Escape closes it
//   - print review: page.pdf() of an attempt with 12 questions has more than one page
//     (the AdminShell used to clip print output to the visible 100vh area).
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import * as factories from './fixtures/factories.js';

const QUESTIONS = 12;

async function signInAdmin(context: BrowserContext, cookie: string): Promise<void> {
  const eq = cookie.indexOf('=');
  await context.clearCookies();
  await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' }]);
}

async function openAdminAttempt(page: Page, p: factories.Provisioned): Promise<void> {
  await page.goto(`/admin/attempts/${p.attemptId}`);
  await expect(page.locator('body')).not.toContainText('Not found.');
}

test.describe('admin help drawer and print review', () => {
  test.describe.configure({ mode: 'serial' });
  let p: factories.Provisioned;

  test.beforeAll(async () => {
    test.setTimeout(180_000); // waits for the worker to activate the assessment (60 s cron)
    p = await factories.provisionAttempt({
      label: 'help-print',
      questionCount: QUESTIONS,
      makeQuestions: async (sa, packId, levelId) => {
        for (let i = 1; i <= QUESTIONS; i += 1) {
          await factories.createMcqQuestion(sa, packId, levelId, `Print review question ${i}: pick the correct option.`);
        }
      },
    });
    await factories.submitAttempt(p.candidate.cookie, p.attemptId);
  });
  test.afterAll(async () => { await p?.cleanup(); });

  test('help drawer opens from the trigger and Ctrl+/, shows both tabs, closes on Escape', async ({ page, context }) => {
    await signInAdmin(context, p.admin.cookie);
    await page.goto('/admin');
    const trigger = page.getByRole('button', { name: 'Open help' });
    await expect(trigger).toBeVisible();

    await trigger.click();
    const drawer = page.getByRole('dialog', { name: 'Help' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('tab', { name: 'This page' })).toBeVisible();
    await drawer.getByRole('tab', { name: 'Guide' }).click();
    await expect(drawer.getByRole('tab', { name: 'Guide', selected: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();

    await page.locator('main').click();
    await page.keyboard.press('Control+/');
    await expect(drawer).toBeVisible();
  });

  test('my account card replaces the Help guide and Account security nav items', async ({ page, context }) => {
    await signInAdmin(context, p.admin.cookie);
    await page.goto('/admin');
    const card = page.getByRole('group', { name: 'My account' });
    await expect(card).toContainText('Two-factor sign-in');
    await expect(card.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Help guide' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Account security' })).toHaveCount(0);
  });

  test('print review: PDF of a 12-question attempt has more than one page', async ({ page, context }) => {
    await signInAdmin(context, p.admin.cookie);
    await openAdminAttempt(page, p);
    await page.emulateMedia({ media: 'print' });
    const pdf = await page.pdf({ format: 'A4' });
    // Count page objects; `/Type /Pages` (the tree root) is excluded by the trailing-s guard.
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
    expect(pages, 'print output must not be clipped to the viewport').toBeGreaterThan(1);
  });
});
