// RW-82 — axe on logged-in pages (admin shell + candidate shell). Real backend with the dev
// minter (see local-stack.sh). Fails on serious/critical violations and on `region` / `page-has-heading-one` (Z-29: measured zero on all 5 pages); other minor/moderate only warn.
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import * as factories from './fixtures/factories.js';

test.describe.configure({ mode: 'serial' }); // one provisioned attempt, one worker

let p: factories.Provisioned;

test.beforeAll(async () => {
  test.setTimeout(180_000); // waits for the worker to activate the assessment
  p = await factories.provisionAttempt({
    label: 'a11y-authed',
    questionCount: 1,
    makeQuestions: async (sa, packId, levelId) => {
      await factories.createMcqQuestion(sa, packId, levelId, 'E2E a11y question: pick the correct option.');
    },
  });
});
test.afterAll(async () => { await p?.cleanup(); });

async function setCookie(page: Page, cookie: string) {
  const eq = cookie.indexOf('=');
  await page.context().addCookies([
    { name: cookie.slice(0, eq), value: cookie.slice(eq + 1), domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
  ]);
}

async function scan(page: Page, label: string) {
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'best-practice']).analyze();
  const BLOCK_RULES = new Set(['region', 'page-has-heading-one']);
  const isBlocking = (x: (typeof violations)[number]) => x.impact === 'serious' || x.impact === 'critical' || BLOCK_RULES.has(x.id);
  const fmt = (v: (typeof violations)[number]) =>
    `[${v.impact}] ${v.id}: ${v.help}\n  ${v.nodes.slice(0, 3).map((n) => `${n.target.join(' ')} :: ${n.html.slice(0, 120)}`).join('\n  ')}`;
  for (const v of violations.filter((x) => !isBlocking(x))) {
    // eslint-disable-next-line no-console -- advisory output by design
    console.warn(`a11y-authed ${label} ${fmt(v)}`);
  }
  const blocking = violations.filter(isBlocking);
  expect(blocking, blocking.map(fmt).join('\n')).toHaveLength(0);
}

const pages: Array<{ role: 'admin' | 'candidate'; path: (id: string) => string; ready: (page: Page) => Promise<void> }> = [
  { role: 'admin', path: () => '/admin', ready: (pg) => expect(pg.locator('main h1, main h2').first()).toBeVisible({ timeout: 20_000 }) },
  { role: 'admin', path: () => '/admin/assessments', ready: (pg) => expect(pg.locator('main h1, main h2').first()).toBeVisible({ timeout: 20_000 }) },
  { role: 'admin', path: (id) => `/admin/attempts/${id}`, ready: (pg) => expect(pg.locator('main h1, main h2').first()).toBeVisible({ timeout: 20_000 }) },
  { role: 'candidate', path: () => '/candidate/results', ready: (pg) => expect(pg.locator('main h1, main h2').first()).toBeVisible({ timeout: 20_000 }) },
  { role: 'candidate', path: (id) => `/take/attempt/${id}`, ready: (pg) => expect(pg.getByText(/^Question 1 of [0-9]+$/)).toBeVisible({ timeout: 20_000 }) },
];

for (const c of pages) {
  test(`${c.role} ${c.path(':id')} has no serious/critical axe violations`, async ({ page }) => {
    await setCookie(page, c.role === 'admin' ? p.admin.cookie : p.candidate.cookie);
    await page.goto(c.path(p.attemptId));
    await c.ready(page);
    await scan(page, c.path(':id'));
  });
}
