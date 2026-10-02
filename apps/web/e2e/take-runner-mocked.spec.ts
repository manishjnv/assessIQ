import { test, expect, type Page, type Request } from '@playwright/test';

// Real SPA in headless Chromium; the HTTP API is mocked with page.route (no backend needed).
// Mocked calls: GET /api/me/attempts/att1 (view), POST .../answer (autosave), plus a 204 catch-all
// for event/flag/other calls. integrity options are OFF in the view, so FullscreenGate stays closed.

type Q = { question_id: string; position: number; type: string; content: unknown };

function view(questions: Q[]): unknown {
  return {
    attempt: { id: 'att1', status: 'in_progress', started_at: null, ends_at: '2099-01-01T00:00:00.000Z' },
    questions: questions.map((q) => ({
      question_version: 1, topic: 'Demo', points: 1, answer_guidance: '', ...q,
    })),
    answers: questions.map((q) => ({
      attempt_id: 'att1', question_id: q.question_id, answer: null, flagged: false,
      time_spent_seconds: 0, edits_count: 0, client_revision: 0, saved_at: null,
    })),
    remaining_seconds: 3600,
    integrity: { fullscreen: false, block_copy_paste: false },
  };
}

async function mockApi(page: Page, questions: Q[]): Promise<Request[]> {
  const saves: Request[] = [];
  // Registered first = lowest priority: anything else (event, flag, whoami...) gets an empty 204.
  await page.route('**/api/**', (r) => r.fulfill({ status: 204 }));
  await page.route('**/api/me/attempts/att1', (r) =>
    r.fulfill({ json: view(questions) }),
  );
  await page.route('**/api/me/attempts/att1/answer', (r) => {
    saves.push(r.request());
    return r.fulfill({ status: 200, headers: { 'X-Client-Revision': '1' }, json: {} });
  });
  return saves;
}

const saveBody = (req: Request): { question_id: string; answer: unknown } =>
  req.postDataJSON() as { question_id: string; answer: unknown };

test.describe('candidate runner (mocked API)', () => {
  test('ordering: items move with Up/Down and the saved order is sent', async ({ page }, testInfo) => {
    // Sanitized candidate content: { question, items } where items are already in the
    // attempt's shuffled display order (repository.ts:511-514, option-shuffle.ts:237).
    await mockApi(page, [{
      question_id: 'q1', position: 1, type: 'ordering',
      content: { question: 'Order the steps', items: ['Gamma step', 'Alpha step', 'Delta step', 'Beta step'] },
    }]);
    await page.goto('/take/attempt/att1');

    const items = page.getByRole('listitem').filter({ hasText: /step/ });
    await expect(items).toHaveCount(4);
    await expect(items).toHaveText([/Gamma step/, /Alpha step/, /Delta step/, /Beta step/]);
    await expect(page.getByRole('button', { name: 'Move item 1 up' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Move item 4 down' })).toBeDisabled();

    const saved = page.waitForRequest((r) => r.url().endsWith('/answer') && r.method() === 'POST');
    await page.getByRole('button', { name: 'Move item 1 down' }).click();
    await expect(items).toHaveText([/Alpha step/, /Gamma step/, /Delta step/, /Beta step/]);

    // Answer shape { order: number[] } = displayed positions in the candidate's order
    // (OrderingAnswerArea.tsx:4-7, :61); the server maps it to item indexes (option-shuffle.ts:217).
    const body = saveBody(await saved);
    expect(body.question_id).toBe('q1');
    expect(body.answer).toEqual({ order: [1, 0, 2, 3] });
    await page.screenshot({ path: testInfo.outputPath('ordering.png') });
  });

  test('numeric twice in a row: second box starts empty, Prev restores 42', async ({ page }, testInfo) => {
    await mockApi(page, [
      { question_id: 'n1', position: 1, type: 'numeric', content: { question: 'First number?' } },
      { question_id: 'n2', position: 2, type: 'numeric', content: { question: 'Second number?' } },
    ]);
    await page.goto('/take/attempt/att1');

    const box = page.getByLabel('Your answer (a number)');
    await box.fill('42');
    await expect(box).toHaveValue('42');
    await page.getByRole('button', { name: /Next/ }).click();
    await expect(page.getByText('Question 2 of 2')).toBeVisible();
    await expect(page.getByText('Second number?')).toBeVisible();
    await expect(page.getByLabel('Your answer (a number)')).toHaveValue('');

    await page.getByRole('button', { name: /Prev/ }).click();
    await expect(page.getByText('Question 1 of 2')).toBeVisible();
    await expect(page.getByLabel('Your answer (a number)')).toHaveValue('42');
    await page.screenshot({ path: testInfo.outputPath('numeric.png') });
  });

  test('scenario mcq step: radios + text step, Beta is saved as step 0 response', async ({ page }, testInfo) => {
    await mockApi(page, [{
      question_id: 's1q', position: 1, type: 'scenario',
      content: {
        title: 'Incident scenario', intro: 'Read this.',
        steps: [
          { id: 's1', type: 'mcq', prompt: 'Pick one', options: ['Alpha', 'Beta', 'Gamma'] },
          { prompt: 'Explain why' },
        ],
      },
    }]);
    await page.goto('/take/attempt/att1');

    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      await expect(page.getByRole('radio', { name })).toBeVisible();
    }
    await expect(page.getByRole('textbox', { name: 'Step 2 response' })).toBeVisible();

    const saved = page.waitForRequest((r) => r.url().endsWith('/answer') && r.method() === 'POST');
    await page.getByRole('radio', { name: 'Beta' }).check();
    await expect(page.getByRole('radio', { name: 'Beta' })).toBeChecked();

    // Answer shape { steps: [{ stepIndex, response }] }; the mcq step stores the option TEXT
    // (Attempt.tsx:600, :614-619, :682-693).
    const body = saveBody(await saved);
    expect(body.question_id).toBe('s1q');
    expect(body.answer).toEqual({ steps: [{ stepIndex: 0, response: 'Beta' }, { stepIndex: 1, response: '' }] });
    await page.screenshot({ path: testInfo.outputPath('scenario.png') });
  });
});
