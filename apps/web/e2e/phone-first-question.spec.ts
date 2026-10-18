// RW-79: email link -> first question in under 20 s on a phone.
// Pixel 5 + Lighthouse "slow 4G" (150 ms RTT, 1.6 Mbit/s down, 750 kbit/s up, 4x CPU slowdown),
// cold cache (fresh context per run), against a PRODUCTION build (vite preview), not the dev server.
// Path: /take/<token> -> Begin visible -> consent + Begin -> "Question 1 of" visible.
// The result-released email links to /candidate/login (magic link, email round trip). Not measured here
// (owner decision Z-15 a keeps the magic link).
// PHONE_FLOW_ADVISORY=1 logs a miss instead of failing (CI, until the 14-day window ends).
import { test, expect } from '@playwright/test';
import * as factories from './fixtures/factories.js';

const RUNS = 5;
const LIMIT_MS = 20_000;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

test.describe('phone: invitation link to first question', () => {
  let inv: factories.ProvisionedInvitations;

  test.beforeAll(async () => {
    test.setTimeout(240_000); // waits for the worker to activate the assessment (60 s cron)
    inv = await factories.provisionInvitations({
      label: 'phone-first-q',
      count: RUNS,
      questionCount: 2,
      makeQuestions: async (sa, packId, levelId) => {
        await factories.createMcqQuestion(sa, packId, levelId, 'E2E question one: pick the correct option.');
        await factories.createMcqQuestion(sa, packId, levelId, 'E2E question two: pick the correct option.');
      },
    });
  });
  test.afterAll(async () => { await inv?.cleanup(); });

  test(`median under ${LIMIT_MS / 1000} s`, async ({ browser }) => {
    test.setTimeout(300_000);
    const landing: number[] = [];
    const begin: number[] = [];
    const total: number[] = [];

    for (const path of inv.paths) {
      const context = await browser.newContext(); // inherits the Pixel 5 project settings
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 150,
        downloadThroughput: 204_800, // 1.6 Mbit/s
        uploadThroughput: 96_000, // 750 kbit/s
      });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

      page.on('response', (r) => {
        if (r.status() >= 400) console.warn(`[phone] ${r.status()} ${r.request().method()} ${r.url()}`); // eslint-disable-line no-console
      });
      const t0 = Date.now();
      await page.goto(path, { waitUntil: 'commit' });
      const beginBtn = page.getByRole('button', { name: /^Begin/ });
      await expect(beginBtn).toBeVisible({ timeout: 60_000 });
      const t1 = Date.now();
      await page.getByRole('checkbox').check();
      await beginBtn.click();
      await expect(page.getByText(/^Question 1 of [0-9]+$/)).toBeVisible({ timeout: 60_000 });
      const t2 = Date.now();

      landing.push(t1 - t0);
      begin.push(t2 - t1);
      total.push(t2 - t0);
      await context.close();
    }

    const rows = [
      ['landing (goto -> Begin visible)', landing],
      ['begin (consent+click -> Question 1)', begin],
      ['total (email link -> Question 1)', total],
    ] as const;
    // eslint-disable-next-line no-console
    console.log(
      ['step | median ms | runs', ...rows.map(([n, xs]) => `${n} | ${median([...xs])} | ${xs.join(', ')}`)].join('\n'),
    );

    const m = median(total);
    if (process.env['PHONE_FLOW_ADVISORY'] === '1' && m >= LIMIT_MS) {
      // eslint-disable-next-line no-console
      console.warn(`[RW-79 advisory] median ${m} ms is over ${LIMIT_MS} ms`);
      return;
    }
    expect(m).toBeLessThan(LIMIT_MS);
  });
});
