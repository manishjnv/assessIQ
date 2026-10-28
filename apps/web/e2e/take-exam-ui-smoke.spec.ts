import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Z-167 / Z-168 smoke: new exam-engine look on the take page. API mocked, no backend.
// Checks: mid-tone default, settings popover (theme, XL text), keys A and F, Clear response,
// passage pane, and no horizontal scroll at 1440 and 390 with a long stem and a long passage.

const LONG = 'Which of the following statements about distributed consensus under network partitions is correct? '.repeat(4);
const PASSAGE = 'The committee reviewed the incident timeline in detail and recorded each decision point. '.repeat(40);

const LOGO = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#2563b8"/></svg>');

function view(): unknown {
  const q = (id: string, position: number, type: string, content: unknown, passage?: unknown) => ({
    question_id: id, position, type, content, question_version: 1, topic: 'Demo', points: 1, answer_guidance: 'Choose one answer.',
    ...(passage !== undefined ? { passage } : {}),
  });
  const qs = [
    q('q1', 1, 'mcq', { question: LONG, options: ['Alpha option', 'Beta option with a rather long text that wraps on small screens', 'Gamma', 'Delta'] },
      { id: 'p1', title: 'Passage', body: PASSAGE }),
    q('q2', 2, 'subjective', { question: 'Explain your reasoning.' }),
  ];
  return {
    attempt: { id: 'att1', status: 'in_progress', started_at: null, ends_at: '2099-01-01T00:00:00.000Z', user_id: 'u1', assessment_id: 'a1' },
    questions: qs,
    answers: qs.map((x) => ({ attempt_id: 'att1', question_id: x.question_id, answer: null, flagged: false, time_spent_seconds: 0, edits_count: 0, client_revision: 0, saved_at: null })),
    remaining_seconds: 3600,
    integrity: { fullscreen: false, block_copy_paste: false },
    company_name: 'Acme College of Engineering and Applied Sciences',
    company_logo_url: LOGO,
    candidate_name: 'Asha Venkatasubramanian Iyer-Chandrasekharan',
    assessment_name: 'Aptitude Mock Test 3: Quantitative, Logical and Verbal Reasoning (Full Length)',
  };
}

async function setup(page: Page): Promise<void> {
  await page.route('**/api/**', (r) => r.fulfill({ status: 204 }));
  await page.route('**/api/me/attempts/att1', (r) => r.fulfill({ json: view() }));
  await page.route('**/api/me/attempts/att1/answer', (r) => r.fulfill({ status: 200, headers: { 'X-Client-Revision': '1' }, json: {} }));
  await page.goto('/take/attempt/att1');
  await expect(page.getByText('Alpha option')).toBeVisible();
}

const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('desktop 1440: mid-tone default, keys, clear, theme and XL', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setup(page);
  await expect(page.locator('.aiq-take-root').first()).toHaveAttribute('data-take-theme', 'mid');
  await page.keyboard.press('b');
  await expect(page.getByRole('radio', { name: /Beta option/ })).toBeChecked();
  await page.keyboard.press('f');
  await expect(page.locator('.aiq-take-flag')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Clear response' }).click();
  await expect(page.getByRole('radio', { name: /Beta option/ })).not.toBeChecked();
  await page.getByRole('button', { name: 'Display settings' }).click();
  await page.getByRole('button', { name: 'Dark' }).click();
  await page.getByRole('button', { name: 'XL' }).click();
  await expect(page.locator('.aiq-take-root').first()).toHaveAttribute('data-take-theme', 'dark');
  expect(await noHScroll(page)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('desktop-dark-xl.png') });
});

test('mobile 390: XL text, long stem and passage, no horizontal scroll', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.getByRole('button', { name: 'Display settings' }).click();
  await page.getByRole('button', { name: 'XL' }).click();
  await page.keyboard.press('Escape');
  expect(await noHScroll(page)).toBe(true);
  // The page itself never scrolls; only the stage does.
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mobile-xl.png') });
});

for (const width of [1440, 1024, 768, 390]) {
  test(`top bar at ${width}: long name and title, no horizontal scroll, axe clean`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await setup(page);
    expect(await noHScroll(page)).toBe(true);
    const org = page.locator('.aiq-take-org-mark');
    const cand = page.getByTestId('take-candidate-meta');
    const asm = page.getByTestId('take-assessment-meta');
    // Handoff rules: avatar always; assessment and org from 901 px; candidate text from 641 px.
    await expect(cand.locator('.aiq-take-avatar')).toBeVisible();
    if (width > 900) { await expect(org).toBeVisible(); await expect(asm).toBeVisible(); } else { await expect(org).toBeHidden(); await expect(asm).toBeHidden(); }
    await expect(cand.locator('.aiq-take-meta')).toBeVisible({ visible: width > 640 });
    await page.screenshot({ path: testInfo.outputPath(`topbar-${width}.png`) });
    const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'best-practice']).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  });
}
