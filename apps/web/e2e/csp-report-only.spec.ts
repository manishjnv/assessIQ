// ADVISORY, not for CI. Measures which violations the live Content-Security-Policy-Report-Only header
// (read from infra/caddy/assessiq.caddy at run time) would cause. The local preview has no Caddy, so
// this spec adds the header to every document response itself. It skips unless CSP_REPORT=1, so the
// default CI run (`playwright test`) ignores it.
//   CSP_REPORT=1 CSP_MARKETING_URL=http://localhost:4321 PLAYWRIGHT_BASE_URL=http://localhost:5173 \
//     pnpm --filter @assessiq/web exec playwright test csp-report-only --project=chromium --workers=1
// Output: csp-report/csp-report-only.json (apps/web) and a markdown table on stdout.
import { test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import * as factories from './fixtures/factories.js';

test.skip(!process.env.CSP_REPORT, 'advisory: set CSP_REPORT=1 to run');

const CADDY = resolve(import.meta.dirname, '../../../infra/caddy/assessiq.caddy');
const m = readFileSync(CADDY, 'utf8').match(/Content-Security-Policy-Report-Only\s+"([^"]+)"/);
if (!m) throw new Error('Content-Security-Policy-Report-Only not found in assessiq.caddy');
// CSP_VARIANT=strict drops 'unsafe-inline' to show which inline code the current pages need hashes or nonces for.
// CSP_VARIANT=enforce injects the proposed ENFORCING policy (csp-policies.json, one string per app) as a real
// Content-Security-Policy header, so the browser blocks and the run proves the pages still work.
const VARIANT = process.env.CSP_VARIANT ?? '';
const STRICT = VARIANT === 'strict';
const ENFORCE = VARIANT === 'enforce';
const POLICIES = JSON.parse(readFileSync(resolve(import.meta.dirname, 'csp-policies.json'), 'utf8')) as { marketing: string; spa: string };
const policyFor = (app: 'marketing' | 'spa') => (ENFORCE ? POLICIES[app] : STRICT ? m[1]!.replace(/ 'unsafe-inline'/g, '') : m[1]!);
const POLICY = ENFORCE ? JSON.stringify(POLICIES) : policyFor('spa');
test.describe.configure({ mode: 'serial' }); // one worker shares `results`; run with --workers=1

const SPA = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173';
const MKT = process.env.CSP_MARKETING_URL ?? '';

interface Row { page: string; effective: string; blocked: string; count: number }
interface Result { page: string; url: string; status: 'measured' | 'NOT MEASURED'; reason?: string; headerSeen: boolean; violations: unknown[]; console: string[] }
const results: Result[] = [];

async function setCookie(page: Page, cookie: string) {
  const eq = cookie.indexOf('=');
  await page.context().addCookies([
    { name: cookie.slice(0, eq), value: cookie.slice(eq + 1), domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
  ]);
}

type Target = { name: string; base: string; path: string; auth?: 'admin' | 'candidate'; attempt?: boolean };
const targets: Target[] = [
  { name: 'marketing home', base: MKT, path: '/' },
  { name: 'marketing /pricing', base: MKT, path: '/pricing' },
  { name: 'marketing /contact (Turnstile)', base: MKT, path: '/contact' },
  { name: 'marketing /search (Pagefind)', base: MKT, path: '/search?q=test' },
  { name: 'marketing /tools/cost-of-a-bad-hire', base: MKT, path: '/tools/cost-of-a-bad-hire' },
  { name: 'SPA /try', base: SPA, path: '/try' },
  { name: 'SPA sign-in', base: SPA, path: '/admin/login' },
  { name: 'SPA admin dashboard', base: SPA, path: '/admin', auth: 'admin' },
  { name: 'SPA admin assessments', base: SPA, path: '/admin/assessments', auth: 'admin' },
  { name: 'SPA candidate home', base: SPA, path: '/candidate/results', auth: 'candidate' },
  { name: 'SPA take shell (/take/expired)', base: SPA, path: '/take/expired' },
  { name: 'SPA take attempt (seeded)', base: SPA, path: '/take/attempt/', attempt: true }, // enforce mode only: seeding waits up to ~90 s for the worker
];
const isMkt = (t: Target) => t.base === MKT && !!MKT;
let seeded: factories.Provisioned | undefined;
let seedError = '';
test.beforeAll(async () => {
  if (!ENFORCE) return;
  test.setTimeout(180_000);
  try {
    seeded = await factories.provisionAttempt({
      label: 'csp', questionCount: 1,
      makeQuestions: async (sa, packId, levelId) => { await factories.createMcqQuestion(sa, packId, levelId, 'CSP sweep question: pick the correct option.'); },
    });
  } catch (e) { seedError = String(e instanceof Error ? e.message : e).slice(0, 160); }
});
test.afterAll(async () => { await seeded?.cleanup().catch(() => {}); });

for (const t of targets) {
  test(`csp-ro ${t.name}`, async ({ page }) => {
    const r: Result = { page: t.name, url: t.base + t.path, status: 'measured', headerSeen: false, violations: [], console: [] };
    results.push(r);
    if (t.attempt) {
      if (!ENFORCE) { r.status = 'NOT MEASURED'; r.reason = 'attempt page is measured in enforce mode only'; return; }
      if (!seeded) { r.status = 'NOT MEASURED'; r.reason = `seeding failed: ${seedError}`; return; }
      r.url = t.base + t.path + seeded.attemptId;
    }
    if (!t.base) { r.status = 'NOT MEASURED'; r.reason = 'CSP_MARKETING_URL not set (no local marketing server)'; return; }
    try {
      if (t.attempt) await setCookie(page, seeded!.candidate.cookie);
      if (t.auth) {
        const s = t.auth === 'admin'
          ? await factories.mintAdminSession(factories.SEEDED_TENANT_ADMIN)
          : await factories.mintCandidateSession(`csp-${Date.now()}@test.assessiq`);
        await setCookie(page, s.cookie);
      }
      await page.route('**/*', async (route) => {
        if (route.request().resourceType() !== 'document') return route.continue();
        const resp = await route.fetch();
        r.headerSeen = true;
        await route.fulfill({ response: resp, headers: { ...resp.headers(), [ENFORCE ? 'content-security-policy' : 'content-security-policy-report-only']: policyFor(isMkt(t) ? 'marketing' : 'spa') } });
      });
      await page.addInitScript(() => {
        const w = window as unknown as { __csp: unknown[] };
        w.__csp = [];
        document.addEventListener('securitypolicyviolation', (e) => {
          w.__csp.push({
            documentURI: e.documentURI, violatedDirective: e.violatedDirective, effectiveDirective: e.effectiveDirective,
            blockedURI: e.blockedURI, sourceFile: e.sourceFile, lineNumber: e.lineNumber,
            sample: (e.sample || '').slice(0, 60), disposition: e.disposition,
          });
        });
      });
      page.on('console', (c) => { if (/content security policy/i.test(c.text())) r.console.push(c.text().slice(0, 300)); });
      await page.goto(r.url);
      if (t.attempt) await page.getByText(/^Question 1 of [0-9]+$/).waitFor({ timeout: 20_000 }); // fails the row (NOT MEASURED) if the runner did not render under the policy
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(1000);
      r.violations = await page.evaluate(() => (window as unknown as { __csp: unknown[] }).__csp);
    } catch (e) {
      r.status = 'NOT MEASURED';
      r.reason = String(e instanceof Error ? e.message : e).split('\n')[0]!.slice(0, 200);
    }
  });
}

test.afterAll(() => {
  mkdirSync('csp-report', { recursive: true });
  writeFileSync(`csp-report/csp-report-only${ENFORCE ? '-enforce' : STRICT ? '-strict' : ''}.json`, JSON.stringify({ policy: POLICY, results }, null, 2));
  const agg = new Map<string, Row>();
  const lines = ['| page | effective directive | blocked source | count |', '|---|---|---|---|'];
  for (const r of results) {
    if (r.status !== 'measured') { lines.push(`| ${r.page} | NOT MEASURED | ${r.reason} | - |`); continue; }
    if (!r.violations.length) { lines.push(`| ${r.page} | (none) | - | 0 |`); continue; }
    for (const v of r.violations as Array<{ effectiveDirective: string; blockedURI: string }>) {
      let b = v.blockedURI;
      try { const u = new URL(b); b = u.origin; } catch { /* inline, eval, data */ }
      const k = `${r.page}|${v.effectiveDirective}|${b}`;
      const row = agg.get(k) ?? { page: r.page, effective: v.effectiveDirective, blocked: b, count: 0 };
      row.count++; agg.set(k, row);
    }
  }
  for (const x of agg.values()) lines.push(`| ${x.page} | ${x.effective} | ${x.blocked} | ${x.count} |`);
  process.stdout.write('\n' + lines.join('\n') + '\n');
});
