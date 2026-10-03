import { test, expect } from '@playwright/test';
import * as factories from './fixtures/factories.js';
import { openAttempt, submitViaUi } from './fixtures/take-ui.js';

// Candidate take flow on the real backend: answer MCQs in the runner, submit, and the
// deterministic score lands (no AI). Local stack: apps/web/e2e/local-stack.sh.
// The candidate session comes from the dev minter; the magic-link entry itself is covered by
// take-error-pages (bad token) and the API tests (POST /take/start needs the emailed raw token).
test.describe('candidate happy path: open attempt → answer → submit', () => {
  test.describe.configure({ mode: 'serial' });
  let p: factories.Provisioned;

  test.beforeAll(async () => {
    test.setTimeout(180_000); // waits for the worker to activate the assessment (60 s cron)
    p = await factories.provisionAttempt({
      label: 'take-happy',
      questionCount: 2,
      makeQuestions: async (sa, packId, levelId) => {
        await factories.createMcqQuestion(sa, packId, levelId, 'E2E question one: pick the correct option.');
        await factories.createMcqQuestion(sa, packId, levelId, 'E2E question two: pick the correct option.');
      },
    });
  });
  test.afterAll(async () => { await p?.cleanup(); });

  test('answer both MCQs, submit, score is stored', async ({ page, context }) => {
    await openAttempt(page, context, p.candidate.cookie, p.attemptId);

    // Autosave is debounced (5 s) and Submit does not flush it (finding, see report), so wait for
    // each save the way a real candidate's pause would.
    const saved = () => page.waitForResponse((r) => r.url().includes('/answer') && r.request().method() === 'POST', { timeout: 15_000 });
    await Promise.all([saved(), page.getByText('Option B (correct answer)').click()]);
    await page.getByRole('button', { name: /Next/ }).click();
    await expect(page.getByText('Question 2 of 2')).toBeVisible();
    await Promise.all([saved(), page.getByText('Option B (correct answer)').click()]);

    await submitViaUi(page, p.attemptId);

    // MCQ-only attempt: graded in the submit transaction, both answers right = full marks.
    const detail = (await factories.getAdminAttempt(p.admin.cookie, p.attemptId)) as unknown as {
      attempt: { status: string };
      gradings: Array<{ score_earned: number; score_max: number }>;
    };
    expect(detail.attempt.status).toBe('graded');
    expect(detail.gradings.reduce((a, g) => a + Number(g.score_earned), 0)).toBe(10);
  });
});
