import { test, expect } from '@playwright/test';
import * as factories from './fixtures/factories.js';
import { openAttempt } from './fixtures/take-ui.js';

// A 1-minute assessment: the runner submits by itself when the timer reaches zero.
// Real backend (apps/web/e2e/local-stack.sh); the worker's 30 s sweep is the server-side backstop.
test.describe('candidate auto-submits when the timer hits zero', () => {
  let p: factories.Provisioned;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    p = await factories.provisionAttempt({
      label: 'take-timer',
      durationMinutes: 1,
      questionCount: 1,
      makeQuestions: (sa, packId, levelId) => factories.createMcqQuestion(sa, packId, levelId, 'E2E timer question.'),
    });
  });
  test.afterAll(async () => { await p?.cleanup(); });

  test('runner redirects to the submitted page and the server marks the attempt submitted', async ({ page, context }) => {
    test.setTimeout(150_000);
    await openAttempt(page, context, p.candidate.cookie, p.attemptId);
    await page.getByText('Option B (correct answer)').click();

    // up to 60 s of timer left, plus the autosave flush and the submit round trip
    await expect(page).toHaveURL(new RegExp(`/take/attempt/${p.attemptId}/submitted`), { timeout: 120_000 });

    const detail = await factories.getAdminAttempt(p.admin.cookie, p.attemptId);
    expect(['submitted', 'graded', 'auto_submitted']).toContain(detail.attempt.status);
  });
});
