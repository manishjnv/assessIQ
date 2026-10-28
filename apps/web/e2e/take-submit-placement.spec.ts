import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import * as factories from './fixtures/factories.js';
import { openAttempt } from './fixtures/take-ui.js';

// Z-7 Move (owner 2026-10-28): Finish assessment is in the top bar; the footer has only Prev and Next.
// The summary's Submit opens the confirm alertdialog. Local stack: apps/web/e2e/local-stack.sh.
test.describe('take page: Submit placement and confirm popup', () => {
  let p: factories.Provisioned;

  test.beforeAll(async () => {
    test.setTimeout(180_000); // waits for the worker to activate the assessment (60 s cron)
    p = await factories.provisionAttempt({
      label: 'take-submit-placement',
      questionCount: 2,
      makeQuestions: async (sa, packId, levelId) => {
        await factories.createMcqQuestion(sa, packId, levelId, 'E2E question one: pick the correct option.');
        await factories.createMcqQuestion(sa, packId, levelId, 'E2E question two: pick the correct option.');
      },
    });
  });
  test.afterAll(async () => { await p?.cleanup(); });

  test('top-bar finish, footer order, popup text, axe clean', async ({ page, context }) => {
    await openAttempt(page, context, p.candidate.cookie, p.attemptId);

    const finish = page.getByRole('button', { name: 'Finish assessment' });
    const prev = page.getByRole('button', { name: 'Prev', exact: true });
    const next = page.getByRole('button', { name: 'Next', exact: true });
    await expect(finish).toBeVisible();
    await expect(page.getByRole('button', { name: 'Submit', exact: true })).toHaveCount(0);
    const [pr, n] = await Promise.all([prev.boundingBox(), next.boundingBox()]);
    expect(pr!.x).toBeLessThan(n!.x);
    expect(pr!.height).toBeGreaterThanOrEqual(40);

    const bar = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(bar.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);

    await finish.click();
    await page.getByRole('button', { name: 'Submit assessment' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Submit your assessment?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      'This sends your answers to your organisation and ends your test. You cannot change them after this. You have 2 unanswered questions.',
    );
    const modal = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(modal.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);

    await expect(dialog.getByRole('button', { name: 'Submit now' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Keep reviewing' }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: /Back to questions/ }).click();
    await page.keyboard.press('n');
    await expect(page.getByText('Question 2 of 2')).toBeVisible();
  });
});
