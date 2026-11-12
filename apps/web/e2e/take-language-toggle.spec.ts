import { test, expect, type Page } from '@playwright/test';

// EXP-9 A4 smoke: the real SPA, API mocked with page.route. Fake Hindi text only.
const questions = [
  { question_id: 'q1', position: 1, type: 'mcq', content: { question: 'Sample question', options: ['one', 'two', 'three', 'four'], i18n: { hi: { question: 'नमूना प्रश्न', options: ['एक', 'दो', 'तीन', 'चार'] } } } },
  { question_id: 'q2', position: 2, type: 'mcq', content: { question: 'English only question', options: ['a', 'b'] } },
];

async function mockApi(page: Page, fail = false): Promise<{ patches: string[]; answers: unknown[] }> {
  const seen = { patches: [] as string[], answers: [] as unknown[] };
  await page.route('**/api/**', (r) => r.fulfill({ status: 204 }));
  await page.route('**/api/me/attempts/att1', (r) =>
    r.fulfill({
      json: {
        attempt: { id: 'att1', status: 'in_progress', started_at: null, ends_at: '2099-01-01T00:00:00.000Z', language: 'en' },
        questions: questions.map((q) => ({ question_version: 1, topic: 'Demo', points: 1, answer_guidance: '', ...q })),
        answers: questions.map((q) => ({ attempt_id: 'att1', question_id: q.question_id, answer: null, flagged: false, time_spent_seconds: 0, edits_count: 0, client_revision: 0, saved_at: null })),
        remaining_seconds: 3600,
        integrity: { fullscreen: false, block_copy_paste: false },
      },
    }),
  );
  await page.route('**/api/me/attempts/att1/language', (r) => {
    seen.patches.push(r.request().postData() ?? '');
    return fail ? r.fulfill({ status: 500, json: {} }) : r.fulfill({ json: { language: 'hi' } });
  });
  await page.route('**/api/me/attempts/att1/answer', (r) => {
    seen.answers.push(r.request().postDataJSON());
    return r.fulfill({ status: 200, headers: { 'X-Client-Revision': '1' }, json: {} });
  });
  return seen;
}

test.describe('take language toggle (mocked API)', () => {
  test('switch to Hindi, answer, and see the English-only note', async ({ page }) => {
    const seen = await mockApi(page);
    await page.goto('/take/attempt/att1');
    await page.getByRole('button', { name: 'हिन्दी' }).click();
    await expect(page.getByText('नमूना प्रश्न')).toBeVisible();
    // The Hindi face must win over the stem and option font rules (a later, equal-weight rule hid this once).
    const family = (text: string): Promise<string> => page.getByText(text, { exact: true }).evaluate((el) => getComputedStyle(el).fontFamily);
    expect(await family('नमूना प्रश्न')).toContain('Noto Sans Devanagari');
    expect(await family('दो')).toContain('Noto Sans Devanagari');
    expect(seen.patches).toEqual(['{"language":"hi"}']);
    await page.getByText('दो').click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect.poll(() => seen.answers.length).toBeGreaterThan(0);
    expect((seen.answers[0] as { answer: unknown }).answer).toEqual({ selected: 1 });
    await expect(page.getByText('This question is available in English only.')).toBeVisible();
    await expect(page.getByText('English only question')).toBeVisible();
  });

  test('a failed save reverts to English with an inline error', async ({ page }) => {
    await mockApi(page, true);
    await page.goto('/take/attempt/att1');
    await page.getByRole('button', { name: 'हिन्दी' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Could not change the language' })).toBeVisible();
    await expect(page.getByText('Sample question')).toBeVisible();
  });
});
