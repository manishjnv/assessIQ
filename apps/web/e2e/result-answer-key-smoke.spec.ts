import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import * as factories from './fixtures/factories.js';

// Z-173 sweep: the result page with the answer key open, and the Settings "Answer key." section,
// at 1440 and 390. Fails on sideways scroll and on serious or critical axe findings.
// The result page mocks the whole API (no backend). Settings needs the local stack
// (apps/web/e2e/local-stack.sh) for the admin session; the settings call is mocked.

const WIDTHS = [1440, 390] as const;
const LONG = 'Which of the following statements about distributed consensus under network partitions is correct for a replicated log? '.repeat(3);

const RESULT = {
  status: 'released',
  total_earned: 7.5,
  total_max: 12,
  percent: 62.5,
  passed: true,
  assessment_name: 'Aptitude Mock Test 3: Quantitative, Logical and Verbal Reasoning (Full Length)',
  released_at: '2026-10-29T10:00:00.000Z',
  pass_mark_pct: 60,
  delivery_mode: 'mock',
  certificate: null,
  retake: { assessment_id: 'a1', attempt_number: 2, attempts_allowed: 3, can_retake: true },
  feedback_level: 'with_expected_answer',
  tenant_name: 'Acme College of Engineering and Applied Sciences',
  company_logo_url: null,
  company_accent: null,
  company_slug: 'acme',
  sections: [
    { index: 0, name: 'Quantitative Reasoning and Data Interpretation', earned: 4, max: 6 },
    { index: 1, name: 'Verbal Reasoning', earned: 3.5, max: 6 },
  ],
};

const FEEDBACK = {
  level: 'with_expected_answer',
  items: [
    { question_id: 'q1', position: 1, type: 'mcq', prompt: LONG, your_answer: 'Beta option with a rather long text that wraps on small screens', outcome: 'correct', score_earned: 1, score_max: 1, expected_answer: 'Beta option with a rather long text that wraps on small screens', explanation: 'A majority quorum keeps the log consistent when a partition heals.', study: { unit: null, subject: null, topic: 'Distributed systems' } },
    { question_id: 'q2', position: 2, type: 'mcq', prompt: 'Pick the odd one out.', your_answer: 'Gamma', outcome: 'incorrect', score_earned: 0, score_max: 1, expected_answer: 'Delta', explanation: null, study: { unit: 'Unit 3', subject: 'Reasoning', topic: 'Odd one out' } },
    // Licensed question (FUT-2): right or wrong and the own answer only.
    { question_id: 'q3', position: 3, type: 'mcq', prompt: 'Licensed library question.', your_answer: 'One', outcome: 'incorrect', score_earned: 0, score_max: 1, expected_answer: null, explanation: null, study: { unit: null, subject: null, topic: 'Library' } },
  ],
};

const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

async function seriousAxe(page: Page): Promise<string[]> {
  const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
}

async function overflowers(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    return [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > w + 1)
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).slice(0, 40)}`);
  });
}

for (const width of WIDTHS) {
  test(`result page with the answer key open at ${width}: no sideways scroll, axe clean`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/api/**', (r) => r.fulfill({ status: 204 }));
    await page.route('**/api/me/attempts/att1/result', (r) => r.fulfill({ json: RESULT }));
    await page.route('**/api/me/attempts/att1/feedback', (r) => r.fulfill({ json: FEEDBACK }));
    await page.goto('/take/attempt/att1/submitted', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('result-meter')).toBeVisible();
    await expect(page.getByTestId('result-stats')).toContainText('Attempt');
    await page.getByRole('button', { name: 'Review your answers' }).click();
    await expect(page.getByText('Licensed library question.')).toBeVisible();
    await expect(page.getByText('Q3')).toBeVisible();
    expect(await noHScroll(page), `sideways scroll: ${(await overflowers(page)).join(', ')}`).toBe(true);
    expect(await seriousAxe(page)).toEqual([]);
  });

  test(`settings Answer key section at ${width}: no sideways scroll, axe clean, checkbox reachable`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const s = await factories.mintAdminSession(factories.SEEDED_TENANT_ADMIN);
    const eq = s.cookie.indexOf('=');
    await page.context().addCookies([
      { name: s.cookie.slice(0, eq), value: s.cookie.slice(eq + 1), domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
    ]);
    await page.route('**/api/admin/tenant-settings', (r) =>
      r.fulfill({ json: { retention_days: 365, attempt_retention_days: null, updated_at: '2026-10-29T10:00:00.000Z', result_release_mode: 'auto', certificate_show_distinction: false, candidate_answer_key: false, accent: null, logo: null } }));
    await page.goto('/admin/settings?tab=results');
    const box = page.getByRole('checkbox', { name: /Let candidates review their answers after a Mock test/ });
    await expect(box).toBeVisible({ timeout: 20_000 });
    await box.focus();
    await box.check();
    await expect(page.getByRole('button', { name: 'Save answer key setting' })).toBeEnabled();
    expect(await noHScroll(page), `sideways scroll: ${(await overflowers(page)).join(', ')}`).toBe(true);
    expect(await seriousAxe(page)).toEqual([]);
  });
}
