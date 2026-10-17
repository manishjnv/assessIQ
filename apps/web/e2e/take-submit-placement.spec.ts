import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import * as factories from './fixtures/factories.js';
import { openAttempt } from './fixtures/take-ui.js';

// Z-7: Submit sits at the far left of the action bar, away from Prev and Next; it opens the
// confirm popup. Local stack: apps/web/e2e/local-stack.sh.
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

  test('button order, popup text, axe clean', async ({ page, context }) => {
    await openAttempt(page, context, p.candidate.cookie, p.attemptId);

    const submit = page.getByRole('button', { name: 'Submit', exact: true });
    const prev = page.getByRole('button', { name: 'Prev', exact: true });
    const next = page.getByRole('button', { name: 'Next', exact: true });
    await expect(submit).toBeVisible();
    const [s, pr, n] = await Promise.all([submit.boundingBox(), prev.boundingBox(), next.boundingBox()]);
    expect(s!.x + s!.width).toBeLessThan(pr!.x);
    expect(pr!.x).toBeLessThan(n!.x);
    expect(pr!.height).toBeGreaterThanOrEqual(40);

    const bar = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(bar.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);

    await submit.click();
    const dialog = page.getByRole('dialog', { name: 'Submit your test?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      'This sends your answers to your organisation and ends your test. You cannot change them after this. You have 2 unanswered questions.',
    );
    const modal = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(modal.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);

    await dialog.getByRole('button', { name: 'Review answers' }).click();
    await expect(dialog).toBeHidden();
    await page.keyboard.press('n');
    await expect(page.getByText('Question 2 of 2')).toBeVisible();
  });
});
