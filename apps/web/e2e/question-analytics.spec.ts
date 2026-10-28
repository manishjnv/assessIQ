// X6b smoke: the question analytics page shows the table, the "Possibly bad question" chip and the
// review link for a flagged row. Needs the local stack (local-stack.sh) for the admin session;
// the analytics call is mocked.
import { test, expect } from '@playwright/test';
import * as factories from './fixtures/factories.js';

const ASSESSMENT = '11111111-1111-4111-8111-111111111111';
const PACK = '22222222-2222-4222-8222-222222222222';

test('question analytics: table, flag chip and review link', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const s = await factories.mintAdminSession(factories.SEEDED_TENANT_ADMIN);
  const eq = s.cookie.indexOf('=');
  await page.context().addCookies([
    { name: s.cookie.slice(0, eq), value: s.cookie.slice(eq + 1), domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
  ]);
  const row = (n: number, correct: number, bad: boolean) => ({
    question_id: `00000000-0000-4000-8000-00000000000${n}`, pack_id: PACK, position: n, type: 'mcq',
    stem_preview: `Stem ${n}`, attempts: 25, correct_count: correct, share_correct: correct / 25, avg_time_seconds: 11.2,
    distractors: [{ option_index: 0, count: correct }, { option_index: 1, count: 25 - correct }],
    possibly_bad: bad, flag_reason: bad ? 'Only 12% answered correctly.' : null,
  });
  await page.route(`**/api/admin/assessments/${ASSESSMENT}/question-analytics`, (r) =>
    r.fulfill({ json: { items: [row(1, 3, true), row(2, 12, false)] } }));
  await page.goto(`/admin/assessments/${ASSESSMENT}/questions`);
  await expect(page.getByRole('heading', { name: /Question analytics/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Stem 1')).toBeVisible();
  await expect(page.getByText('Possibly bad question')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Open review for question 1' })).toHaveAttribute('href', `/admin/question-bank/${PACK}/review`);
  await expect(page.getByText('12%').first()).toBeVisible();
  expect(errors).toEqual([]);
});
