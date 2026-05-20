// AssessIQ — apps/web/e2e/fixtures/factories.ts
//
// Node.js fetch helpers used by admin-workflow.spec.ts.
//
// All functions call the real REST API directly (not via Playwright's page) so
// data-setup steps are decoupled from UI assertions. The spec can then navigate
// to pages and assert that the already-created data renders correctly.
//
// INVARIANTS:
//   - MUST NOT import from @assessiq/* packages (spec isolation rule).
//   - Uses native fetch (Node 22+ / browser global — both supported by Playwright 1.59+).
//   - Every helper throws on non-2xx so the test fails fast with a clear message.
//   - Never hardcodes production credentials or tokens.

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** API base URL. In CI this points at the local docker-compose stack. */
export function apiBase(): string {
  // PLAYWRIGHT_BASE_URL is the SPA origin (e.g. http://localhost:5173).
  // The API is on a different port (3000) unless VITE_API_URL rewrites proxying.
  // When running against the VPS, API and SPA share the same origin via Caddy.
  const spa = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
  return process.env['E2E_API_BASE_URL'] ?? spa.replace(':5173', ':3000');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MintedSession {
  /** Raw "aiq_sess=<token>" cookie string, ready for use in Cookie headers. */
  cookie: string;
  /** UUID of the created/found user. Use for invite + assertions. */
  userId: string;
  sessionId: string;
}

export interface TestPack {
  id: string;
  name: string;
  status: string;
}

export interface TestLevel {
  id: string;
  label: string;
  position: number;
}

export interface TestQuestion {
  id: string;
  type: string;
  status: string;
}

export interface TestAssessment {
  id: string;
  name: string;
  status: string;
}

export interface TestAttempt {
  id: string;
  status: string;
  questions: Array<{ id: string; type: string }>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function apiFetch(
  path: string,
  opts: {
    method?: string;
    cookie?: string;
    body?: unknown;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.cookie) headers['Cookie'] = opts.cookie;

  const res = await fetch(`${apiBase()}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return res;
}

async function apiFetchJson<T>(
  path: string,
  opts: {
    method?: string;
    cookie?: string;
    body?: unknown;
    expectedStatus?: number;
    label?: string;
  } = {},
): Promise<T> {
  const res = await apiFetch(path, opts);
  const expectedStatus = opts.expectedStatus ?? (opts.method === 'POST' ? 201 : 200);
  if (res.status !== expectedStatus) {
    const text = await res.text().catch(() => '(unreadable body)');
    throw new Error(
      `[factories] ${opts.label ?? path} expected ${expectedStatus}, got ${res.status}: ${text}`,
    );
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

/**
 * Mint a session via POST /api/dev/mint-session.
 * Requires ENABLE_E2E_TEST_MINTER=true on the API server.
 */
async function mintSession(
  email: string,
  role: 'admin' | 'reviewer' | 'candidate',
  tenantSlug: string,
): Promise<MintedSession> {
  const res = await apiFetch('/api/dev/mint-session', {
    method: 'POST',
    body: { email, role, tenantSlug },
  });

  if (res.status !== 200) {
    const text = await res.text().catch(() => '(unreadable body)');
    throw new Error(
      `[factories] mint-session for ${email}/${role} failed — ${res.status}: ${text}\n` +
        `Ensure ENABLE_E2E_TEST_MINTER=true is set on the API server.`,
    );
  }

  const body = (await res.json()) as { sessionId: string; userId: string; expiresAt: string };

  // Extract the "aiq_sess=<value>" portion from Set-Cookie header.
  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookiePart = setCookie.split(';')[0] ?? '';
  if (!cookiePart.startsWith('aiq_sess=')) {
    throw new Error(`[factories] mint-session: expected aiq_sess cookie, got: ${setCookie}`);
  }

  return { cookie: cookiePart, userId: body.userId, sessionId: body.sessionId };
}

export function mintAdminSession(
  email: string,
  tenantSlug = 'wipro-soc',
): Promise<MintedSession> {
  return mintSession(email, 'admin', tenantSlug);
}

export function mintCandidateSession(
  email: string,
  tenantSlug = 'wipro-soc',
): Promise<MintedSession> {
  return mintSession(email, 'candidate', tenantSlug);
}

// ---------------------------------------------------------------------------
// Question-bank setup
// ---------------------------------------------------------------------------

export async function createPack(adminCookie: string, name: string): Promise<TestPack> {
  return apiFetchJson<TestPack>('/api/admin/packs', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      name,
      domain: 'soc',
      description: `E2E test pack — created by admin-workflow.spec.ts (safe to delete)`,
    },
    expectedStatus: 201,
    label: 'createPack',
  });
}

export async function addLevel(
  adminCookie: string,
  packId: string,
  label: string,
  position: number,
): Promise<TestLevel> {
  return apiFetchJson<TestLevel>(`/api/admin/packs/${packId}/levels`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      label,
      description: `E2E ${label} level`,
      position,
      duration_minutes: 30,
      default_question_count: 2,
      passing_score_pct: 60,
    },
    expectedStatus: 201,
    label: `addLevel(${label})`,
  });
}

export async function createMcqQuestion(
  adminCookie: string,
  packId: string,
  levelId: string,
  stem: string,
): Promise<TestQuestion> {
  return apiFetchJson<TestQuestion>('/api/admin/questions', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      pack_id: packId,
      level_id: levelId,
      type: 'mcq',
      topic: 'e2e-test',
      points: 5,
      tags: ['e2e-test'],
      content: {
        question: stem,
        options: [
          'Option A (distractor)',
          'Option B (correct answer)',
          'Option C (distractor)',
          'Option D (distractor)',
        ],
        correct: 1,
        rationale: 'B is correct for E2E test purposes.',
      },
      rubric: null,
    },
    expectedStatus: 201,
    label: 'createMcqQuestion',
  });
}

export async function createSubjectiveQuestion(
  adminCookie: string,
  packId: string,
  levelId: string,
  stem: string,
): Promise<TestQuestion> {
  return apiFetchJson<TestQuestion>('/api/admin/questions', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      pack_id: packId,
      level_id: levelId,
      type: 'subjective',
      topic: 'e2e-test',
      points: 10,
      tags: ['e2e-test'],
      content: {
        question: stem,
      },
      rubric: {
        anchors: [
          {
            id: 'a1',
            concept: 'identifies the key issue',
            weight: 50,
            synonyms: ['issue', 'problem', 'root cause'],
          },
          {
            id: 'a2',
            concept: 'proposes a remediation step',
            weight: 50,
            synonyms: ['fix', 'remediate', 'resolve', 'mitigate'],
          },
        ],
        reasoning_bands: {
          band_4: 'Both anchors present with clear rationale.',
          band_3: 'Both anchors present, one with weak rationale.',
          band_2: 'One anchor present.',
          band_1: 'Mentions the topic but no anchor hit.',
          band_0: 'No relevant content.',
        },
        anchor_weight_total: 100,
        reasoning_weight_total: 100,
      },
    },
    expectedStatus: 201,
    label: 'createSubjectiveQuestion',
  });
}

export async function activateQuestion(adminCookie: string, questionId: string): Promise<void> {
  await apiFetchJson<unknown>(`/api/admin/questions/${questionId}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { status: 'active' },
    expectedStatus: 200,
    label: `activateQuestion(${questionId})`,
  });
}

/**
 * Bulk-activate all draft questions for a pack.
 * Requires the pack to be already published.
 */
export async function activateAllQuestionsForPack(
  adminCookie: string,
  packId: string,
): Promise<{ activated: number; alreadyActive: number; archived: number }> {
  return apiFetchJson<{ activated: number; alreadyActive: number; archived: number }>(
    `/api/admin/packs/${packId}/activate-questions`,
    {
      method: 'POST',
      cookie: adminCookie,
      body: {},
      expectedStatus: 200,
      label: 'activateAllQuestionsForPack',
    },
  );
}

export async function publishPack(adminCookie: string, packId: string): Promise<TestPack> {
  return apiFetchJson<TestPack>(`/api/admin/packs/${packId}/publish`, {
    method: 'POST',
    cookie: adminCookie,
    body: {},
    expectedStatus: 200,
    label: 'publishPack',
  });
}

// ---------------------------------------------------------------------------
// Assessment lifecycle
// ---------------------------------------------------------------------------

export async function createAssessment(
  adminCookie: string,
  opts: {
    name: string;
    packId: string;
    levelId: string;
    questionCount?: number;
  },
): Promise<TestAssessment> {
  const opensAt = new Date(Date.now() + 60_000).toISOString(); // 1 min from now
  const closesAt = new Date(Date.now() + 7 * 24 * 3600_000).toISOString(); // 7 days

  return apiFetchJson<TestAssessment>('/api/admin/assessments', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      name: opts.name,
      description: 'E2E test cycle — safe to delete',
      pack_id: opts.packId,
      level_id: opts.levelId,
      question_count: opts.questionCount ?? 1,
      opens_at: opensAt,
      closes_at: closesAt,
    },
    expectedStatus: 201,
    label: 'createAssessment',
  });
}

export async function publishAssessment(
  adminCookie: string,
  assessmentId: string,
): Promise<TestAssessment> {
  return apiFetchJson<TestAssessment>(`/api/admin/assessments/${assessmentId}/publish`, {
    method: 'POST',
    cookie: adminCookie,
    body: {},
    expectedStatus: 200,
    label: 'publishAssessment',
  });
}

export async function inviteCandidate(
  adminCookie: string,
  assessmentId: string,
  candidateUserId: string,
): Promise<void> {
  await apiFetchJson<unknown>(`/api/admin/assessments/${assessmentId}/invite`, {
    method: 'POST',
    cookie: adminCookie,
    body: { user_ids: [candidateUserId] },
    expectedStatus: 201,
    label: 'inviteCandidate',
  });
}

// ---------------------------------------------------------------------------
// Candidate — attempt flow via ME routes
// ---------------------------------------------------------------------------

export async function listCandidateAssessments(
  candidateCookie: string,
): Promise<Array<{ assessment_id: string; name: string; status: string }>> {
  const res = await apiFetchJson<{ items: Array<{ assessment_id: string; name: string; status: string }> }>(
    '/api/me/assessments',
    { cookie: candidateCookie, label: 'listCandidateAssessments' },
  );
  return res.items;
}

export async function startAttempt(
  candidateCookie: string,
  assessmentId: string,
): Promise<TestAttempt> {
  return apiFetchJson<TestAttempt>(`/api/me/assessments/${assessmentId}/start`, {
    method: 'POST',
    cookie: candidateCookie,
    body: {},
    // The start endpoint returns 200 (idempotent — re-call returns existing attempt)
    expectedStatus: 200,
    label: 'startAttempt',
  });
}

export async function answerQuestion(
  candidateCookie: string,
  attemptId: string,
  questionId: string,
  response: string,
): Promise<void> {
  await apiFetchJson<unknown>(`/api/me/attempts/${attemptId}/answer`, {
    method: 'POST',
    cookie: candidateCookie,
    body: { question_id: questionId, response },
    expectedStatus: 200,
    label: `answerQuestion(${questionId})`,
  });
}

export async function submitAttempt(
  candidateCookie: string,
  attemptId: string,
): Promise<void> {
  await apiFetchJson<unknown>(`/api/me/attempts/${attemptId}/submit`, {
    method: 'POST',
    cookie: candidateCookie,
    body: {},
    expectedStatus: 200,
    label: 'submitAttempt',
  });
}

// ---------------------------------------------------------------------------
// Admin — attempt + grading
// ---------------------------------------------------------------------------

export async function getAdminAttempt(
  adminCookie: string,
  attemptId: string,
): Promise<{ attempt: { id: string; status: string }; answers: unknown[]; gradings: unknown[] }> {
  return apiFetchJson<{
    attempt: { id: string; status: string };
    answers: unknown[];
    gradings: unknown[];
  }>(`/api/admin/attempts/${attemptId}`, {
    cookie: adminCookie,
    label: 'getAdminAttempt',
  });
}

export interface GradingProposal {
  attempt_id: string;
  question_id: string;
  score_earned: number;
  score_max: number;
  reasoning_band: number;
  ai_justification: string;
  prompt_version_sha: string;
  grader: string;
  label: string;
  model: string;
  error_class: string | null;
}

export async function triggerGrading(
  adminCookie: string,
  attemptId: string,
): Promise<{ proposals: GradingProposal[] } | null> {
  const res = await apiFetch(`/api/admin/attempts/${attemptId}/grade`, {
    method: 'POST',
    cookie: adminCookie,
    body: {},
  });

  if (res.status === 503 || res.status === 409) {
    // 503 = claude CLI not available in this env (CI without VPS skills)
    // 409 = AIG_GRADING_IN_PROGRESS or AIG_HEARTBEAT_STALE
    // Both are expected in docker-compose CI where claude is not installed.
    // Return null so the spec can handle the "no grading" path gracefully.
    return null;
  }
  if (res.status !== 200) {
    const text = await res.text().catch(() => '(unreadable body)');
    throw new Error(`[factories] triggerGrading failed: ${res.status}: ${text}`);
  }
  return res.json() as Promise<{ proposals: GradingProposal[] }>;
}

export async function acceptGradings(
  adminCookie: string,
  attemptId: string,
  proposals: GradingProposal[],
): Promise<void> {
  await apiFetchJson<unknown>(`/api/admin/attempts/${attemptId}/accept`, {
    method: 'POST',
    cookie: adminCookie,
    body: { proposals },
    expectedStatus: 200,
    label: 'acceptGradings',
  });
}

// ---------------------------------------------------------------------------
// Release + certificate (graded → released → cert auto-issued)
// ---------------------------------------------------------------------------

export async function releaseAttempt(
  adminCookie: string,
  attemptId: string,
): Promise<{ attempt: { id: string; status: string } }> {
  return apiFetchJson<{ attempt: { id: string; status: string } }>(
    `/api/admin/attempts/${attemptId}/release`,
    {
      method: 'POST',
      cookie: adminCookie,
      body: {},
      expectedStatus: 200,
      label: 'releaseAttempt',
    },
  );
}

export interface TestCertificate {
  id: string;
  attempt_id: string;
  credential_id: string;
  signed_hash: string;
}

export async function getAdminCertificateForAttempt(
  adminCookie: string,
  attemptId: string,
): Promise<TestCertificate | null> {
  const res = await apiFetchJson<{ items: TestCertificate[]; total: number }>(
    '/api/admin/certificates',
    { cookie: adminCookie, label: 'getAdminCertificateForAttempt' },
  );
  return res.items.find((c) => c.attempt_id === attemptId) ?? null;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Best-effort cleanup of test data.
 * Errors are logged but not rethrown — test data accumulation is a minor
 * nuisance; a failed cleanup must not obscure a real test failure.
 */
export async function cleanupTestData(opts: {
  adminCookie: string;
  packId?: string;
  assessmentId?: string;
}): Promise<void> {
  const errors: string[] = [];

  // Close assessment first (if still active) before archiving pack.
  if (opts.assessmentId) {
    const closeRes = await apiFetch(`/api/admin/assessments/${opts.assessmentId}/close`, {
      method: 'POST',
      cookie: opts.adminCookie,
      body: {},
    }).catch((err) => {
      errors.push(`close assessment: ${String(err)}`);
      return null;
    });
    if (closeRes !== null && closeRes.status >= 500) {
      errors.push(`close assessment: ${closeRes.status}`);
    }
  }

  // Archive pack (soft-deletes it for future cleanup).
  if (opts.packId) {
    const archiveRes = await apiFetch(`/api/admin/packs/${opts.packId}/archive`, {
      method: 'POST',
      cookie: opts.adminCookie,
      body: {},
    }).catch((err) => {
      errors.push(`archive pack: ${String(err)}`);
      return null;
    });
    if (archiveRes !== null && archiveRes.status >= 500) {
      errors.push(`archive pack: ${archiveRes.status}`);
    }
  }

  if (errors.length > 0) {
    // Warn but don't throw — cleanup failures must not hide real test failures.
    // eslint-disable-next-line no-console
    console.warn('[factories] cleanup had non-fatal errors:', errors);
  }
}
