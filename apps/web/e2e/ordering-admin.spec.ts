// N12 admin side: `ordering` and `structured_case` on the real backend (apps/web/e2e/local-stack.sh).
//   super admin authors pack + level + question  ->  tenant admin publishes an assessment from the set
//   -> candidate takes it in the runner (Up/Down buttons / radios + checkboxes), submits
//   -> deterministic score is right (no AI)  ->  admin attempt view shows the answer against the key.
// Each describe provisions its own pack/assessment, so the two run in parallel.
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import * as factories from './fixtures/factories.js';
import { arrangeOrdering, openAttempt, submitViaUi } from './fixtures/take-ui.js';

type Score = { total_earned: number; total_max: number; auto_pct: number };

async function adminAttemptScore(p: factories.Provisioned): Promise<{ status: string; score: Score }> {
  const d = (await factories.getAdminAttempt(p.admin.cookie, p.attemptId)) as unknown as { attempt: { status: string }; score: Score };
  return { status: d.attempt.status, score: d.score };
}

/** Open the tenant admin's attempt page in the browser. */
async function openAdminAttempt(page: Page, context: BrowserContext, p: factories.Provisioned): Promise<void> {
  const eq = p.admin.cookie.indexOf('=');
  await context.clearCookies();
  await context.addCookies([{ name: p.admin.cookie.slice(0, eq), value: p.admin.cookie.slice(eq + 1), domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' }]);
  await page.goto(`/admin/attempts/${p.attemptId}`);
  await expect(page.locator('body')).not.toContainText('Not found.');
}

const ITEMS = ['Detect the alert', 'Triage the host', 'Contain the threat', 'Recover the service'];

test.describe('ordering: author → publish → take → score → admin view', () => {
  test.describe.configure({ mode: 'serial' });
  let p: factories.Provisioned;

  test.beforeAll(async () => {
    test.setTimeout(180_000); // waits for the worker to activate the assessment (60 s cron)
    p = await factories.provisionAttempt({
      label: 'ordering',
      questionCount: 1,
      makeQuestions: (sa, packId, levelId) => factories.createOrderingQuestion(sa, packId, levelId, 'Put the incident steps in order.', ITEMS),
    });
  });
  test.afterAll(async () => { await p?.cleanup(); });

  test('candidate sees a shuffled list, orders it with Up/Down and submits', async ({ page, context }) => {
    // the served order is never the authored (= correct) order
    const served = p.view.questions[0]!.content['items'] as string[];
    expect([...served].sort()).toEqual([...ITEMS].sort());
    expect(served).not.toEqual(ITEMS);
    expect(p.view.questions[0]!.content['correct_order']).toBeUndefined();

    await openAttempt(page, context, p.candidate.cookie, p.attemptId);
    await arrangeOrdering(page, ITEMS);
    // wait for the debounced autosave before submitting
    await page.waitForResponse((r) => r.url().includes('/answer') && r.request().method() === 'POST', { timeout: 15_000 }).catch(() => undefined);
    await submitViaUi(page, p.attemptId);
  });

  test('deterministic score is full marks', async () => {
    const { status, score } = await adminAttemptScore(p);
    expect(status).toBe('graded');
    expect(score).toMatchObject({ total_earned: 4, total_max: 4, auto_pct: 100 });
  });

  test('admin attempt view shows the candidate order against the key', async ({ page, context }) => {
    await openAdminAttempt(page, context, p);
    await expect(page.getByText('Candidate order')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Correct order').first()).toBeVisible();
    for (const item of ITEMS) await expect(page.getByText(item, { exact: false }).first()).toBeVisible();
    await expect(page.getByText('✓').first()).toBeVisible();
    await expect(page.getByText('✗')).toHaveCount(0);
  });
});

const STEPS: factories.CaseStep[] = [
  { id: 's1', prompt: 'What is the first response action?', select: 'one', options: ['Isolate the host', 'Reboot the server', 'Ignore the alert'], correct: [0] },
  { id: 's2', prompt: 'Which actions help the investigation?', select: 'many', options: ['Collect a memory image', 'Delete the logs', 'Block the source address'], correct: [0, 2] },
];

test.describe('structured_case: author → publish → take → score → admin view', () => {
  test.describe.configure({ mode: 'serial' });
  let p: factories.Provisioned;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    p = await factories.provisionAttempt({
      label: 'structured',
      questionCount: 1,
      makeQuestions: (sa, packId, levelId) => factories.createStructuredCaseQuestion(sa, packId, levelId, 'E2E structured case', STEPS),
    });
  });
  test.afterAll(async () => { await p?.cleanup(); });

  test('candidate answers every step (radio + checkboxes) and submits', async ({ page, context }) => {
    // the key never reaches the candidate
    const served = JSON.stringify(p.view.questions[0]!.content);
    expect(served).not.toContain('"correct"');

    await openAttempt(page, context, p.candidate.cookie, p.attemptId);
    await page.getByText('Isolate the host').click();
    await page.getByText('Collect a memory image').click();
    await page.getByText('Block the source address').click();
    await page.waitForResponse((r) => r.url().includes('/answer') && r.request().method() === 'POST', { timeout: 15_000 });
    await submitViaUi(page, p.attemptId);
  });

  test('deterministic score is full marks', async () => {
    const { status, score } = await adminAttemptScore(p);
    expect(status).toBe('graded');
    expect(score).toMatchObject({ total_earned: 4, total_max: 4, auto_pct: 100 });
  });

  test('admin attempt view shows the picks against the key', async ({ page, context }) => {
    await openAdminAttempt(page, context, p);
    await expect(page.getByText('Isolate the host').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('✓ (selected)').first()).toBeVisible();
    await expect(page.getByText('✗ (selected)')).toHaveCount(0);
  });
});
