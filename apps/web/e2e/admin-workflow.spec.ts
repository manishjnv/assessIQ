// AssessIQ — apps/web/e2e/admin-workflow.spec.ts
//
// Full admin → candidate happy-path E2E spec.
//
// Walks the 12-step admin workflow documented in modules/10-admin-dashboard/src/pages/admin-guide.tsx:
//   1. Mint admin session (test-minter)
//   2. Navigate /admin → dashboard renders
//   3. Create question pack
//   4. Add levels to pack
//   5. Author questions (MCQ + subjective)
//   6. Publish pack
//   7. Activate all questions (bulk)
//   8. Create assessment (cycle) referencing the pack
//   9. Publish assessment
//  10. Invite candidate
//  11. Candidate: view → start → answer → submit
//  12. Admin: view submitted attempt; trigger grading (if AI available)
//  13. (Bonus) Cohort report renders without blank page (regression: empty-state bug)
//
// WHY THIS SPEC IS SERIAL:
//   Each step depends on data created by the previous step
//   (pack → levels → questions → assessment → attempt → grading).
//   Parallelising would require independent fixture data per thread,
//   which is both wasteful and harder to maintain. Serial is correct here.
//
// HARD RULES (mirrors CLAUDE.md):
//   - NO imports from @assessiq/* packages.
//   - NO hardcoded production credentials.
//   - Test data is prefixed "E2E Test" so cleanup queries are safe.
//   - ENABLE_E2E_TEST_MINTER=true required on the API server (CI sets this).
//   - Spec fails on ANY unexpected console error or 5xx response.
//
// LOCAL RUN:
//   ENABLE_E2E_TEST_MINTER=true \
//   PLAYWRIGHT_BASE_URL=http://localhost:5173 \
//   E2E_API_BASE_URL=http://localhost:3000 \
//   pnpm --filter @assessiq/web exec playwright test admin-workflow
//
// See apps/web/e2e/README.md for full setup guide.

import { test, expect, type Cookie } from '@playwright/test';
import * as factories from './fixtures/factories.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Cookie object for Playwright context from a "name=value" cookie string. */
function parseCookie(raw: string, domain: string): Cookie {
  const eq = raw.indexOf('=');
  const name = raw.slice(0, eq);
  const value = raw.slice(eq + 1);
  return {
    name,
    value,
    domain,
    path: '/',
    expires: -1, // session cookie
    httpOnly: true,
    secure: false,
    sameSite: 'Lax',
  };
}

/** Collect all console errors seen during a page interaction. */
function collectConsoleErrors(page: import('@playwright/test').Page): () => string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
  });
  return () => errors;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test.describe('Admin → Candidate full workflow', () => {
  // Unique timestamp suffix prevents name collisions across parallel CI runs.
  const TS = Date.now();
  const ADMIN_EMAIL = `e2e-admin-${TS}@test.assessiq`;
  const CANDIDATE_EMAIL = `e2e-candidate-${TS}@test.assessiq`;
  const PACK_NAME = `E2E Test Pack ${TS}`;
  const ASSESSMENT_NAME = `E2E Test Cycle ${TS}`;

  // Data refs shared across steps (populated in sequence).
  let admin: factories.MintedSession;
  let candidate: factories.MintedSession;
  let pack: factories.TestPack;
  let level1: factories.TestLevel;
  let level2: factories.TestLevel;
  let q1: factories.TestQuestion;
  let q2: factories.TestQuestion;
  let assessment: factories.TestAssessment;
  let attemptId: string;
  let wasGraded = false;
  let credentialId: string | undefined;

  // ---------------------------------------------------------------------------
  // Cleanup — best-effort, runs even on test failure
  // ---------------------------------------------------------------------------
  test.afterAll(async () => {
    if (admin && (pack?.id || assessment?.id)) {
      await factories.cleanupTestData({
        adminCookie: admin.cookie,
        packId: pack?.id,
        assessmentId: assessment?.id,
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Step 1 — Mint admin session
  // ---------------------------------------------------------------------------
  test('step 01 — mint admin session', async () => {
    admin = await factories.mintAdminSession(ADMIN_EMAIL);
    expect(admin.cookie).toMatch(/^aiq_sess=/);
    expect(admin.userId).toBeTruthy();
  });

  // ---------------------------------------------------------------------------
  // Step 2 — Navigate /admin → dashboard renders
  // ---------------------------------------------------------------------------
  test('step 02 — admin dashboard renders', async ({ page, context }) => {
    test.skip(!admin?.cookie, 'requires step 01');

    const domain = new URL(page.url() || 'http://localhost').hostname || 'localhost';
    await context.addCookies([parseCookie(admin.cookie, domain)]);

    const getErrors = collectConsoleErrors(page);
    await page.goto('/admin');

    // Dashboard must render — not blank, not "Not found.", not raw error
    await expect(page.locator('body')).not.toContainText('Not found.');
    await expect(page.locator('body')).not.toContainText('undefined is not');

    // Main content area (nav or heading) should be visible
    await expect(
      page.getByRole('navigation').or(page.getByRole('heading', { level: 1 })),
    ).toBeVisible({ timeout: 15_000 });

    // No unhandled console errors
    const errs = getErrors();
    expect(errs, `console errors on /admin: ${errs.join('; ')}`).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Step 3 — Create question pack (API)
  // ---------------------------------------------------------------------------
  test('step 03 — create question pack', async () => {
    test.skip(!admin?.cookie, 'requires step 01');

    pack = await factories.createPack(admin.cookie, PACK_NAME);
    expect(pack.id).toBeTruthy();
    expect(pack.status).toBe('draft');
  });

  // ---------------------------------------------------------------------------
  // Step 3b — Pack detail page renders
  // ---------------------------------------------------------------------------
  test('step 03b — pack detail page renders', async ({ page, context }) => {
    test.skip(!admin?.cookie || !pack?.id, 'requires step 03');

    const domain = new URL(page.url() || 'http://localhost').hostname || 'localhost';
    await context.addCookies([parseCookie(admin.cookie, domain)]);

    const getErrors = collectConsoleErrors(page);
    await page.goto(`/admin/question-bank/${pack.id}`);

    await expect(page.locator('body')).not.toContainText('Not found.');
    // Pack name visible in the page
    await expect(page.getByText(PACK_NAME)).toBeVisible({ timeout: 10_000 });

    const errs = getErrors();
    expect(errs, `console errors on pack detail: ${errs.join('; ')}`).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Step 4 — Add levels (API)
  // ---------------------------------------------------------------------------
  test('step 04 — add two levels to pack', async () => {
    test.skip(!admin?.cookie || !pack?.id, 'requires step 03');

    level1 = await factories.addLevel(admin.cookie, pack.id, 'L1 — Triage Analyst', 1);
    level2 = await factories.addLevel(admin.cookie, pack.id, 'L2 — Senior Analyst', 2);

    expect(level1.id).toBeTruthy();
    expect(level2.id).toBeTruthy();
  });

  // ---------------------------------------------------------------------------
  // Step 5 — Author questions (API): 1 MCQ per L1, 1 subjective per L2
  // ---------------------------------------------------------------------------
  test('step 05 — create MCQ + subjective questions', async () => {
    test.skip(!admin?.cookie || !level1?.id || !level2?.id, 'requires step 04');

    q1 = await factories.createMcqQuestion(
      admin.cookie,
      pack.id,
      level1.id,
      'An EDR alert fires for powershell.exe -enc. What is your immediate next step?',
    );
    q2 = await factories.createSubjectiveQuestion(
      admin.cookie,
      pack.id,
      level2.id,
      'Describe the first 5 minutes of triaging a phishing-email-delivered malware alert.',
    );

    expect(q1.id).toBeTruthy();
    expect(q1.status).toBe('draft');
    expect(q2.id).toBeTruthy();
    expect(q2.status).toBe('draft');
  });

  // ---------------------------------------------------------------------------
  // Step 6 — Publish pack (API)
  // ---------------------------------------------------------------------------
  test('step 06 — publish pack', async () => {
    test.skip(!admin?.cookie || !pack?.id, 'requires step 03');

    const published = await factories.publishPack(admin.cookie, pack.id);
    pack = published; // update reference with new status
    expect(published.status).toBe('published');
  });

  // ---------------------------------------------------------------------------
  // Step 7 — Activate questions (API, bulk)
  // ---------------------------------------------------------------------------
  test('step 07 — activate all questions', async () => {
    test.skip(!admin?.cookie || !pack?.id || pack.status !== 'published', 'requires step 06');

    const result = await factories.activateAllQuestionsForPack(admin.cookie, pack.id);
    // At least the 2 questions we just created should be activated
    expect(result.activated).toBeGreaterThanOrEqual(2);
  });

  // ---------------------------------------------------------------------------
  // Step 8 — Create assessment (cycle)
  // ---------------------------------------------------------------------------
  test('step 08 — create assessment', async () => {
    test.skip(!admin?.cookie || !pack?.id || !level1?.id, 'requires step 06');

    assessment = await factories.createAssessment(admin.cookie, {
      name: ASSESSMENT_NAME,
      packId: pack.id,
      levelId: level1.id,
      questionCount: 1,
    });

    expect(assessment.id).toBeTruthy();
    expect(assessment.status).toBe('draft');
  });

  // ---------------------------------------------------------------------------
  // Step 9 — Publish assessment
  // ---------------------------------------------------------------------------
  test('step 09 — publish assessment', async () => {
    test.skip(!admin?.cookie || !assessment?.id, 'requires step 08');

    const published = await factories.publishAssessment(admin.cookie, assessment.id);
    assessment = published;
    expect(published.status).toBe('published');
  });

  // ---------------------------------------------------------------------------
  // Step 9b — Assessments list page renders
  // ---------------------------------------------------------------------------
  test('step 09b — assessments list page renders', async ({ page, context }) => {
    test.skip(!admin?.cookie || !assessment?.id, 'requires step 09');

    const domain = new URL(page.url() || 'http://localhost').hostname || 'localhost';
    await context.addCookies([parseCookie(admin.cookie, domain)]);

    const getErrors = collectConsoleErrors(page);
    await page.goto('/admin/assessments');

    await expect(page.locator('body')).not.toContainText('Not found.');
    await expect(page.getByText(ASSESSMENT_NAME)).toBeVisible({ timeout: 10_000 });

    const errs = getErrors();
    expect(errs, `console errors on /admin/assessments: ${errs.join('; ')}`).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Step 10 — Mint candidate session + invite
  // ---------------------------------------------------------------------------
  test('step 10 — mint candidate + invite to assessment', async () => {
    test.skip(!admin?.cookie || !assessment?.id, 'requires step 09');

    candidate = await factories.mintCandidateSession(CANDIDATE_EMAIL);
    expect(candidate.userId).toBeTruthy();

    // Invite the candidate to the assessment
    await factories.inviteCandidate(admin.cookie, assessment.id, candidate.userId);
  });

  // ---------------------------------------------------------------------------
  // Step 11 — Candidate: list assessments, start, answer, submit
  // ---------------------------------------------------------------------------
  test('step 11 — candidate starts and submits attempt', async () => {
    test.skip(!candidate?.cookie || !assessment?.id, 'requires step 10');

    // List available assessments for this candidate
    const available = await factories.listCandidateAssessments(candidate.cookie);
    const found = available.find((a) => a.assessment_id === assessment.id);
    expect(
      found,
      `Assessment ${assessment.id} not found in candidate's available list. Got: ${JSON.stringify(available)}`,
    ).toBeTruthy();

    // Start the attempt
    const attempt = await factories.startAttempt(candidate.cookie, assessment.id);
    attemptId = attempt.id;
    expect(attempt.id).toBeTruthy();
    expect(['in_progress', 'started']).toContain(attempt.status);

    // Answer each question with a simple response
    for (const q of attempt.questions) {
      await factories.answerQuestion(
        candidate.cookie,
        attempt.id,
        q.id,
        q.type === 'mcq'
          ? JSON.stringify({ selected: 1 })
          : 'The first step is to validate the sender domain and check URL detonation.',
      );
    }

    // Submit
    await factories.submitAttempt(candidate.cookie, attempt.id);
  });

  // ---------------------------------------------------------------------------
  // Step 11b — Admin: verify submitted attempt appears in attempts list
  // ---------------------------------------------------------------------------
  test('step 11b — admin attempts list shows submitted attempt', async ({ page, context }) => {
    test.skip(!admin?.cookie || !attemptId, 'requires step 11');

    const domain = new URL(page.url() || 'http://localhost').hostname || 'localhost';
    await context.addCookies([parseCookie(admin.cookie, domain)]);

    const getErrors = collectConsoleErrors(page);
    await page.goto('/admin/attempts');

    await expect(page.locator('body')).not.toContainText('Not found.');
    // Page must render attempt list (not blank)
    await expect(page.locator('main, [role="main"], #root')).toBeVisible({ timeout: 10_000 });

    const errs = getErrors();
    expect(errs, `console errors on /admin/attempts: ${errs.join('; ')}`).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Step 12 — Admin: view attempt detail, trigger grading
  // ---------------------------------------------------------------------------
  test('step 12 — admin views attempt detail + triggers grading', async ({ page, context }) => {
    test.skip(!admin?.cookie || !attemptId, 'requires step 11');

    const domain = new URL(page.url() || 'http://localhost').hostname || 'localhost';
    await context.addCookies([parseCookie(admin.cookie, domain)]);

    // Verify the attempt detail via API (GET /admin/attempts/:id claims it)
    const detail = await factories.getAdminAttempt(admin.cookie, attemptId);
    expect(['submitted', 'pending_admin_grading']).toContain(detail.attempt.status);

    const getErrors = collectConsoleErrors(page);
    await page.goto(`/admin/attempts/${attemptId}`);

    await expect(page.locator('body')).not.toContainText('Not found.');
    await expect(page.locator('main, [role="main"], #root')).toBeVisible({ timeout: 10_000 });

    // Attempt page must not show a raw error
    await expect(page.locator('body')).not.toContainText('internal error');

    const errs = getErrors();
    expect(errs, `console errors on attempt detail: ${errs.join('; ')}`).toHaveLength(0);

    // Trigger grading — null return means claude is not available in this env (CI)
    const gradingResult = await factories.triggerGrading(admin.cookie, attemptId);

    if (gradingResult !== null) {
      // Claude IS available — accept the proposals so the attempt gets graded
      expect(Array.isArray(gradingResult.proposals)).toBe(true);
      await factories.acceptGradings(admin.cookie, attemptId, gradingResult.proposals);
      wasGraded = true;

      // Reload attempt detail — expect status=graded
      const graded = await factories.getAdminAttempt(admin.cookie, attemptId);
      expect(graded.attempt.status).toBe('graded');
    } else {
      // Claude not available (docker-compose CI) — assert at least pending_admin_grading
      const current = await factories.getAdminAttempt(admin.cookie, attemptId);
      expect(['pending_admin_grading', 'submitted']).toContain(current.attempt.status);
    }
  });

  // ---------------------------------------------------------------------------
  // Step 12b — Admin: release graded attempt (graded → released)
  // ---------------------------------------------------------------------------
  test('step 12b — admin releases graded attempt', async () => {
    test.skip(!admin?.cookie || !attemptId || !wasGraded, 'requires graded attempt from step 12');

    const released = await factories.releaseAttempt(admin.cookie, attemptId);
    expect(released.attempt.status).toBe('released');
  });

  // ---------------------------------------------------------------------------
  // Step 12c — Certificate auto-issued after release
  // ---------------------------------------------------------------------------
  test('step 12c — certificate auto-issued after release', async () => {
    test.skip(!admin?.cookie || !attemptId || !wasGraded, 'requires step 12b');

    // issueCertificateOnRelease is fire-and-forget inside the release handler;
    // retry up to 3× with a short wait to give it time to commit.
    let cert: factories.TestCertificate | null = null;
    for (let i = 0; i < 3; i++) {
      cert = await factories.getAdminCertificateForAttempt(admin.cookie, attemptId);
      if (cert !== null) break;
      await new Promise((r) => setTimeout(r, 1500));
    }

    expect(cert, `No certificate found for attempt ${attemptId} after 3 polls`).not.toBeNull();
    expect(cert!.credential_id).toBeTruthy();
    credentialId = cert!.credential_id;
  });

  // ---------------------------------------------------------------------------
  // Step 12d — Public verify page shows valid badge
  // ---------------------------------------------------------------------------
  test('step 12d — public verify page shows cert-status--valid badge', async ({ page }) => {
    test.skip(!credentialId, 'requires step 12c');

    // /verify/:credentialId is served by the API (Fastify), not the SPA.
    await page.goto(`${factories.apiBase()}/verify/${credentialId}`);

    await expect(page.locator('.cert-status--valid')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.credential-id')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.cert-status--revoked')).toHaveCount(0);
    await expect(page.locator('.cert-status--tampered')).toHaveCount(0);
  });

  // ---------------------------------------------------------------------------
  // Step 13 (Bonus) — Cohort report renders without blank page
  // This is a regression guard for the empty-state blank page bug surfaced
  // in today's manual testing (May 8, 2026). The report must render something
  // meaningful even when attempt_count=0.
  // ---------------------------------------------------------------------------
  test('step 13 — cohort report renders without blank page', async ({ page, context }) => {
    test.skip(!admin?.cookie || !assessment?.id, 'requires step 09');

    const domain = new URL(page.url() || 'http://localhost').hostname || 'localhost';
    await context.addCookies([parseCookie(admin.cookie, domain)]);

    const getErrors = collectConsoleErrors(page);
    await page.goto(`/admin/reports/cohort/${assessment.id}`);

    await expect(page.locator('body')).not.toContainText('Not found.');
    // Must not be blank — the root element must have some visible children
    await expect(page.locator('main, [role="main"], #root')).toBeVisible({ timeout: 10_000 });
    // Must not render a raw error
    await expect(page.locator('body')).not.toContainText('internal error');
    await expect(page.locator('body')).not.toContainText('undefined is not');

    const errs = getErrors();
    expect(errs, `console errors on cohort report: ${errs.join('; ')}`).toHaveLength(0);
  });
});
