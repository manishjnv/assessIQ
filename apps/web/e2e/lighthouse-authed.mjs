/* eslint-disable no-console -- CLI script prints its score table */
// RW-82 — Lighthouse on logged-in pages. Run with tsx (imports the TS e2e factories):
//   PLAYWRIGHT_BASE_URL=http://localhost:4173 E2E_API_BASE_URL=http://localhost:3000 pnpm --filter @assessiq/web lhci:authed
// Provisions an attempt, mints admin + candidate sessions, then runs `lhci collect` + `lhci assert`
// per role with the session cookie sent as an extra header. Prints a score table; exits 1 on assert failure.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as factories from './fixtures/factories.ts';

const base = (process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:4173').replace(/\/$/, '');
const cfg = JSON.parse(readFileSync(new URL('../lighthouserc.authed.json', import.meta.url), 'utf8'));
if (process.env.LHCI_RUNS) cfg.ci.collect.numberOfRuns = Number(process.env.LHCI_RUNS);

const p = await factories.provisionAttempt({
  label: 'lhci-authed',
  questionCount: 1,
  makeQuestions: async (sa, packId, levelId) => {
    await factories.createMcqQuestion(sa, packId, levelId, 'E2E lighthouse question: pick the correct option.');
  },
});

const roles = [
  { role: 'admin', cookie: p.admin.cookie, paths: ['/admin', '/admin/assessments', `/admin/attempts/${p.attemptId}`] },
  { role: 'candidate', cookie: p.candidate.cookie, paths: ['/candidate/results', `/take/attempt/${p.attemptId}`] },
];

const dir = mkdtempSync(join(tmpdir(), 'lhci-authed-'));
const rows = [];
let failed = false;
const lhci = (args) => spawnSync('pnpm', ['exec', 'lhci', ...args], { stdio: 'inherit', shell: process.platform === 'win32' }).status ?? 1;

for (const r of roles) {
  const out = '.lighthouseci'; // lhci collect always writes here (cwd)
  rmSync(out, { recursive: true, force: true });
  const rc = structuredClone(cfg);
  rc.ci.collect.url = r.paths.map((x) => base + x);
  rc.ci.collect.settings.extraHeaders = JSON.stringify({ Cookie: r.cookie });
  const file = join(dir, `${r.role}.json`);
  writeFileSync(file, JSON.stringify(rc));
  if (lhci(['collect', `--config=${file}`]) !== 0) failed = true;
  if (lhci(['assert', `--config=${file}`]) !== 0) failed = true;
  // median-ish: average the runs per URL
  const byUrl = new Map();
  for (const f of readdirSync(out).filter((n) => /^lhr-.*\.json$/.test(n))) {
    const l = JSON.parse(readFileSync(join(out, f), 'utf8'));
    const arr = byUrl.get(l.requestedUrl) ?? [];
    arr.push(l);
    byUrl.set(l.requestedUrl, arr);
  }
  for (const [url, ls] of byUrl) {
    const avg = (k) => (ls.reduce((a, l) => a + (l.categories[k]?.score ?? 0), 0) / ls.length).toFixed(2);
    rows.push({ page: url.replace(base, ''), perf: avg('performance'), a11y: avg('accessibility'), bp: avg('best-practices'), seo: avg('seo'), final: new URL(ls[0].finalDisplayedUrl ?? url).pathname });
  }
}

console.log('\npage | performance | accessibility | best-practices | seo | landed on');
for (const x of rows) console.log(`${x.page.replace(p.attemptId, ':id')} | ${x.perf} | ${x.a11y} | ${x.bp} | ${x.seo} | ${x.final.replace(p.attemptId, ':id')}`);
await p.cleanup();
process.exit(failed ? 1 : 0);
