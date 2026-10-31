import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import * as factories from './fixtures/factories.js';

// EXP-10 part 1 smoke: pictures and maths on the take page, and the "Images and maths" panel of the create-question form.
// Take page: API mocked, no backend. Editor panel: needs the local stack (apps/web/e2e/local-stack.sh) for the admin
// session; the image routes are mocked. Fails on sideways scroll and on serious or critical axe findings.

const ONE_PX_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const IMG1 = '0190a0a0-0000-7000-8000-0000000000c1';
const IMG2 = '0190a0a0-0000-7000-8000-0000000000c2';
const IMG3 = '0190a0a0-0000-7000-8000-0000000000c3';
const WIDTHS = [1440, 390] as const;

// One super admin session is minted per editor test; two at once end each other's session, so this file runs in order.
test.describe.configure({ mode: 'serial' });

function view(): unknown {
  const q1 = {
    question_id: 'q1', position: 1, type: 'mcq', question_version: 1, topic: 'Networking', points: 1, answer_guidance: 'Choose one answer.',
    content: {
      question: 'Find \\(\\frac{a}{b} + x^2\\) for the circuit shown, then compare with \\[\\sum_{i=1}^{n} i\\] in the second figure.',
      math: true,
      options: ['\\(x^2\\)', 'Option b: a router with a very long label that has to wrap on a phone screen without any sideways scroll at all', 'plain text option'],
      stem_assets: [IMG1, IMG2],
      option_assets: [null, IMG3, null],
    },
    assets: [
      { id: IMG1, alt_text: 'Circuit with two switches in series', width: 800, height: 500 },
      { id: IMG2, alt_text: 'Second figure with a wide chart', width: 2400, height: 600 },
      { id: IMG3, alt_text: 'Option b: a router', width: 640, height: 480 },
    ],
  };
  const q2 = { question_id: 'q2', position: 2, type: 'mcq', question_version: 1, topic: 'Networking', points: 1, answer_guidance: 'Choose one answer.', content: { question: 'A plain second question?', options: ['yes', 'no'] } };
  return {
    attempt: { id: 'att1', status: 'in_progress', started_at: null, ends_at: '2099-01-01T00:00:00.000Z', user_id: 'u1', assessment_id: 'a1' },
    questions: [q1, q2],
    answers: [q1, q2].map((x) => ({ attempt_id: 'att1', question_id: x.question_id, answer: null, flagged: false, time_spent_seconds: 0, edits_count: 0, client_revision: 0, saved_at: null })),
    remaining_seconds: 3600,
    integrity: { fullscreen: false, block_copy_paste: false },
    company_name: 'Acme College', company_logo_url: null, candidate_name: 'Asha', assessment_name: 'Networking mock',
  };
}

const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
async function seriousAxe(page: Page): Promise<string[]> {
  const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
}
async function overflowers(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    return [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > w + 1).slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).slice(0, 40)}`);
  });
}

for (const width of WIDTHS) {
  test(`take page with pictures and maths at ${width}: pictures and formulas drawn, no sideways scroll, axe clean`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/api/**', (r) => r.fulfill({ status: 204 }));
    await page.route('**/api/me/attempts/att1', (r) => r.fulfill({ json: view() }));
    await page.route('**/api/me/attempts/att1/answer', (r) => r.fulfill({ status: 200, headers: { 'X-Client-Revision': '1' }, json: {} }));
    await page.route('**/api/me/attempts/att1/assets/*', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: ONE_PX_PNG }));
    await page.goto('/take/attempt/att1');
    await expect(page.getByAltText('Circuit with two switches in series')).toBeVisible();
    await expect(page.getByAltText('Second figure with a wide chart')).toBeVisible();
    await expect(page.getByAltText('Option b: a router')).toBeVisible();
    await expect(page.locator('.katex').first()).toBeVisible({ timeout: 15_000 });
    // the stem pictures open full size in a new tab
    await expect(page.getByRole('link', { name: /Open image in a new tab: Circuit/ })).toHaveAttribute('target', '_blank');
    // the images load from the attempt route only
    const srcs = await page.locator('img[src*="/assets/"]').evaluateAll((els) => els.map((e) => (e as HTMLImageElement).getAttribute('src')));
    expect(srcs.length).toBe(3);
    expect(srcs.every((s) => s !== null && s.startsWith('/api/me/attempts/att1/assets/'))).toBe(true);
    await page.getByRole('radio', { name: /plain text option/ }).check({ force: true });
    expect(await noHScroll(page), `sideways scroll: ${(await overflowers(page)).join(', ')}`).toBe(true);
    expect(await seriousAxe(page)).toEqual([]);
  });

  test(`take page at ${width}: a picture that fails to load shows its alt text and the question stays answerable`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/api/**', (r) => r.fulfill({ status: 204 }));
    await page.route('**/api/me/attempts/att1', (r) => r.fulfill({ json: view() }));
    await page.route('**/api/me/attempts/att1/answer', (r) => r.fulfill({ status: 200, headers: { 'X-Client-Revision': '1' }, json: {} }));
    await page.route('**/api/me/attempts/att1/assets/*', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: '{"code":"ASSET_NOT_FOUND"}' }));
    await page.goto('/take/attempt/att1');
    await expect(page.getByTestId('question-image-fallback').first()).toContainText('Image did not load');
    await expect(page.getByTestId('question-image-fallback').first()).toContainText('Circuit with two switches in series');
    await page.getByRole('radio', { name: /plain text option/ }).check({ force: true });
    await expect(page.getByRole('radio', { name: /plain text option/ })).toBeChecked();
    expect(await noHScroll(page), `sideways scroll: ${(await overflowers(page)).join(', ')}`).toBe(true);
    expect(await seriousAxe(page)).toEqual([]);
  });

  test(`create-question form at ${width}: Images and maths panel uploads a picture, shows it, no sideways scroll, axe clean`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const s = await factories.mintSuperAdminSession(); // authoring is super-admin only
    const eq = s.cookie.indexOf('=');
    await page.context().addCookies([
      { name: s.cookie.slice(0, eq), value: s.cookie.slice(eq + 1), domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
    ]);
    const meta = { id: IMG1, pack_id: '0190a0a0-0000-7000-8000-000000000999', sha256: 'a'.repeat(64), mime: 'image/png', byte_size: 70, width: 800, height: 500, alt_text: 'Circuit with two switches in series', created_at: '2026-10-29T10:00:00.000Z' };
    await page.route('**/api/admin/question-assets', (r) => r.fulfill({ status: 201, json: { ...meta, deduped: false } }));
    await page.route(`**/api/admin/question-assets/${IMG1}/meta`, (r) => r.fulfill({ json: meta }));
    await page.route(`**/api/admin/question-assets/${IMG1}`, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: ONE_PX_PNG }));
    await page.goto('/admin/question-bank/questions/new?pack_id=0190a0a0-0000-7000-8000-000000000999&level_id=0190a0a0-0000-7000-8000-000000000998');
    await expect(page.getByTestId('rich-panel')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('contains-maths').check();
    await expect(page.locator('#q-content')).toHaveValue(/"math": true/);
    await page.locator('#rc-file').setInputFiles({ name: 'figure.png', mimeType: 'image/png', buffer: ONE_PX_PNG });
    await page.locator('#rc-alt').fill('Circuit with two switches in series');
    await page.getByRole('button', { name: 'Upload image' }).click();
    await expect(page.getByTestId('attached-images').getByAltText('Circuit with two switches in series')).toBeVisible();
    await expect(page.locator('#q-content')).toHaveValue(new RegExp(IMG1));
    expect(await noHScroll(page), `sideways scroll: ${(await overflowers(page)).join(', ')}`).toBe(true);
    expect(await seriousAxe(page)).toEqual([]);
  });
}
