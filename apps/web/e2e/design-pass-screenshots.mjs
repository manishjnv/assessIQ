/* eslint-disable no-console -- CLI script */
// RW-81 design pass. Run with tsx from apps/web:
//   tsx e2e/design-pass-screenshots.mjs seed | shoot before|after | cleanup
// Needs the local stack (API :3000 with ENABLE_E2E_TEST_MINTER) and `vite preview --port 4175`
// (E2E_API_PROXY=http://127.0.0.1:3000) serving a production build. State lives in docs/testing/screenshots/S15/state.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import * as f from './fixtures/factories.ts';

const mode = process.argv[2];
const outDir = fileURLToPath(new URL('../../../docs/testing/screenshots/S15/', import.meta.url));
const outPath = (p) => outDir + p;
const stateFile = outPath('state.json');
mkdirSync(outDir, { recursive: true });
const BASE = 'http://localhost:4175';
// The shared local API restarts now and then: retry any factory call.
const retry = async (fn) => {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) { if (i >= 12) throw e; await new Promise((r) => setTimeout(r, 4000)); }
  }
};

if (mode === 'seed') {
  const ts = Date.now();
  const sa = await f.mintSuperAdminSession();
  const admin = await f.mintAdminSession(f.SEEDED_TENANT_ADMIN);
  const packs = [];
  const names = [
    'Security Operations Centre Tier-1 Analyst Foundations and Incident Triage Fundamentals',
    'Cloud Infrastructure Hardening and Identity Governance for Regulated Financial Services',
  ];
  for (const [i, name] of names.entries()) {
    const pack = await f.createPack(sa.cookie, `${name} ${ts}`);
    const level = await f.addLevel(sa.cookie, pack.id, 'L1', 1, 30);
    for (let q = 1; q <= 5; q++) {
      await f.createMcqQuestion(sa.cookie, pack.id, level.id, `Design pass question ${q} (pack ${i + 1}): which control best reduces the blast radius of a compromised service account?`);
    }
    await f.createSubjectiveQuestion(sa.cookie, pack.id, level.id, `Design pass written question (pack ${i + 1}): explain how you would triage a phishing alert.`);
    await f.publishPack(sa.cookie, pack.id);
    packs.push(pack.id);
  }
  const asm = await f.createAssessmentFromSet(admin.cookie, {
    name: `Design pass cohort assessment with a deliberately long display name ${ts}`,
    sourcePackId: packs[0],
    questionCount: 4,
  });
  await f.publishAssessment(admin.cookie, asm.id);
  const cands = [];
  for (let i = 0; i < 6; i++) {
    const email = `dp-candidate-${ts}-${i}@test.assessiq`;
    const c = await f.mintCandidateSession(email);
    await f.inviteCandidate(admin.cookie, asm.id, c.userId);
    cands.push({ email, userId: c.userId });
  }
  const attempts = [];
  for (let i = 0; i < 3; i++) {
    const c = await f.mintCandidateSession(cands[i].email);
    const a = await f.startAttempt(c.cookie, asm.id);
    const view = await f.getAttemptView(c.cookie, a.id);
    const qs = i === 2 ? view.questions.slice(0, 1) : view.questions;
    for (const q of qs) {
      await f.answerQuestion(c.cookie, a.id, q.question_id, q.type === 'mcq' ? { selected: 1 } : { text: 'Validate the sender domain, detonate the URL, and check mail logs.' });
    }
    if (i < 2) await f.submitAttempt(c.cookie, a.id);
    attempts.push({ id: a.id, email: cands[i].email, userId: cands[i].userId, submitted: i < 2 });
  }
  writeFileSync(stateFile, JSON.stringify({ ts, packs, assessmentId: asm.id, cands, attempts }, null, 1));
  console.log('seeded', stateFile);
} else if (mode === 'cleanup') {
  const s = JSON.parse(readFileSync(stateFile, 'utf8'));
  const sa = await f.mintSuperAdminSession();
  const admin = await f.mintAdminSession(f.SEEDED_TENANT_ADMIN);
  for (const [i, p] of s.packs.entries()) {
    await f.cleanupTestData({ adminCookie: admin.cookie, superCookie: sa.cookie, packId: p, ...(i === 0 ? { assessmentId: s.assessmentId } : {}) });
  }
  console.log('cleaned');
} else if (mode === 'shoot') {
  const phase = process.argv[3];
  const s = JSON.parse(readFileSync(stateFile, 'utf8'));
  const sub = s.attempts[0].id;
  const prog = s.attempts[2].id;
  const pub = ['/', '/admin/login', '/admin/select-identity', '/admin/login/email', '/admin/invite/accept', '/candidate/login', '/candidate/login/verify', '/take/expired', '/take/error', '/take/not-a-real-token', '/try', '/try/certificate', '/no-such-page'];
  const adm = ['/admin', '/admin/users', '/admin/tenant-settings', '/admin/attempts', `/admin/attempts/${sub}`, '/admin/grading-jobs', `/admin/reports/cohort/${s.assessmentId}`, `/admin/reports/individual/${s.attempts[0].userId}`, '/admin/settings', '/admin/guide', '/admin/question-bank', `/admin/question-bank/${s.packs[0]}`, '/admin/start-test', '/admin/assessments', `/admin/assessments/${s.assessmentId}`, '/admin/reports', '/admin/certificates', '/admin/activity', '/admin/audit-log', '/admin/integrations/webhooks', '/admin/integrations/embed', '/admin/account-security', '/admin/mfa'];
  const sup = ['/admin', '/admin/question-bank', `/admin/question-bank/${s.packs[0]}`, '/admin/settings/help-content', '/admin/generation-attempts', '/admin/generate-wizard', '/admin/question-import', '/admin/platform', '/admin/platform/evaluations'];
  const cnd = ['/candidate/results', '/candidate/progress', '/candidate/certificates', '/candidate/activity', `/take/attempt/${sub}/submitted`];
  // A thunk per role: /admin/mfa invalidates the session, so every viewport pass mints a fresh cookie.
  const jobs = [
    ['public', null, pub],
    ['admin', () => retry(() => f.mintAdminSession(f.SEEDED_TENANT_ADMIN)), adm],
    ['super', () => retry(() => f.mintSuperAdminSession()), sup],
    ['candidate', () => retry(() => f.mintCandidateSession(s.attempts[0].email)), cnd],
    ['candidate2', () => retry(() => f.mintCandidateSession(s.attempts[2].email)), [`/take/attempt/${prog}`]],
  ];
  const dir = outPath(`${phase}/`);
  mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch();
  const overflow = existsSync(outPath('overflow.json')) ? JSON.parse(readFileSync(outPath('overflow.json'), 'utf8')) : {};
  overflow[phase] = {};
  const idRe = new RegExp([sub, prog, s.assessmentId, s.packs[0], s.attempts[0].userId].join('|'), 'g');
  for (const [role, cookie, routes] of jobs) {
    for (const [w, h] of [[1440, 900], [390, 844]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      if (cookie) await ctx.addCookies([{ name: 'aiq_sess', value: (await cookie()).cookie.split('=')[1], url: BASE }]);
      const page = await ctx.newPage();
      for (const r of routes) {
        const slug = (r === '/' ? 'root' : r.replace(/^\//, '').replace(idRe, 'ID').replace(/[^A-Za-z0-9]+/g, '-')).slice(0, 70);
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await page.goto(BASE + r, { waitUntil: 'networkidle', timeout: 20000 });
          } catch { /* take pages poll; continue */ }
          // A redirect to a login page on a protected route is a flaky session: re-mint and retry.
          if (!cookie || !/\/login/.test(new URL(page.url()).pathname)) break;
          await ctx.addCookies([{ name: 'aiq_sess', value: (await cookie()).cookie.split('=')[1], url: BASE }]);
        }
        await page.waitForTimeout(700);
        const ov = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
        overflow[phase][`${role}-${slug}-${w}`] = { ov, landed: new URL(page.url()).pathname.replace(idRe, 'ID') };
        await page.screenshot({ path: `${dir}${role}-${slug}-${w}.png`, fullPage: true });
      }
      await ctx.close();
    }
  }
  await browser.close();
  writeFileSync(outPath('overflow.json'), JSON.stringify(overflow, null, 1));
  const bad = Object.entries(overflow[phase]).filter(([, v]) => v.ov).map(([k]) => k);
  console.log(phase, 'shots', Object.keys(overflow[phase]).length, 'overflow', bad);
}
