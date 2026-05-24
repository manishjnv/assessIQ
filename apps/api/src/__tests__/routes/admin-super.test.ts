/**
 * Unit tests for admin-super routes.
 *
 * PATCH /api/admin/super/tenants/:tenantId/ai-generate-mode
 *
 * Auth is stubbed via the same test-seam pattern as auth.test.ts
 * (x-test-session-* headers → req.session synthesis in the @assessiq/auth mock).
 * No Postgres container needed: @assessiq/tenancy is fully mocked.
 *
 * Coverage:
 *   1. super_admin can flip mode; 200 with correct shape returned
 *   2. tenant_admin (role='admin') gets 403
 *   3. reviewer gets 403
 *   4. unauthenticated gets 401
 *   5. invalid mode value gets 400
 *   6. null mode (reset to global default) returns 200
 *   7. NotFoundError from service → 404
 *   8. audit emit failure rolls back UPDATE (service throws; column unchanged)
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Mocks — hoisted via vi.mock
// ---------------------------------------------------------------------------

// @assessiq/auth — same passthrough-seam pattern as auth.test.ts.
// Spread the REAL @assessiq/auth (so every constant + helper the buildServer
// route graph imports — candidate-login, embed, google, email-otp, etc. — is
// present without manual enumeration), then override ONLY the gating middleware
// with the x-test-session-* header seam. Real auth has no import-time Redis
// side effects (verified), so importActual is safe.
vi.mock('@assessiq/auth', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@assessiq/auth');
  const passthrough = (): unknown => async (_req: unknown, _reply: unknown) => undefined;

  type MockReq = { headers: Record<string, string | undefined>; session?: { id: string; tenantId: string; userId: string; role: string; totpVerified: boolean; expiresAt: string; lastTotpAt: string | null }; apiKey?: unknown };
  type AuthOpts = { roles?: string[]; requireTotpVerified?: boolean; freshMfaWithinMinutes?: number };

  const sessionLoaderMiddleware = (_opts?: unknown) => async (req: MockReq) => {
    const t = req.headers['x-test-session-tenant'];
    const u = req.headers['x-test-session-user'];
    const r = req.headers['x-test-session-role'];
    const totp = req.headers['x-test-session-totp-verified'];
    if (typeof t === 'string' && typeof u === 'string' && typeof r === 'string') {
      req.session = {
        id: 'test-session',
        tenantId: t,
        userId: u,
        role: r,
        totpVerified: totp !== 'false',
        expiresAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
        lastTotpAt: totp === 'false' ? null : new Date().toISOString(),
      };
    }
  };

  const requireAuth = (opts: AuthOpts = {}) => async (req: MockReq) => {
    const { AuthnError, AuthzError } = await import('@assessiq/core');
    if (req.session === undefined && req.apiKey === undefined) {
      throw new AuthnError('authentication required');
    }
    if (req.session !== undefined && Array.isArray(opts.roles) && !opts.roles.includes(req.session.role)) {
      throw new AuthzError(`role ${req.session.role} not authorized`);
    }
    // NOTE: this seam does NOT enforce freshMfaWithinMinutes — the real gate is
    // exercised in 01-auth unit tests. These route tests focus on handler logic.
  };

  return {
    ...actual,
    rateLimitMiddleware: (_opts?: unknown) => passthrough(),
    sessionLoaderMiddleware,
    apiKeyAuthMiddleware: passthrough(),
    requireAuth,
    extendOnPassMiddleware: (_name: string) => passthrough(),
    // Override the session store so the suspend/archive handlers' tenant-wide
    // session sweep is a controllable no-op (no Redis/PG).
    sessions: {
      ...(actual.sessions as Record<string, unknown>),
      destroyAllForTenant: vi.fn().mockResolvedValue({ revokedCount: 0, affectedUsers: [] }),
    },
  };
});

// @assessiq/tenancy — controllable handles for the service functions the
// admin-super handlers call; other symbols are no-ops.
const mockUpdateAiGenerateMode = vi.fn();
const mockSuspendTenant = vi.fn();
const mockResumeTenant = vi.fn();
const mockArchiveTenant = vi.fn();
const mockUnarchiveTenant = vi.fn();

vi.mock('@assessiq/tenancy', () => ({
  tenantContextMiddleware: () => ({
    preHandler: vi.fn().mockResolvedValue(undefined),
    onResponse: vi.fn().mockResolvedValue(undefined),
  }),
  getTenantBySlug: vi.fn(),
  getTenantById: vi.fn(),
  withTenant: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
  setPoolForTesting: vi.fn(),
  updateTenantSettings: vi.fn(),
  // assertTenantActive is a write-block guard on config endpoints; lifecycle
  // endpoints intentionally do NOT call it. Default to a resolved no-op.
  assertTenantActive: vi.fn().mockResolvedValue(undefined),
  createTenant: vi.fn(),
  activateTenant: vi.fn(),
  suspendTenant: (...args: unknown[]) => mockSuspendTenant(...args),
  resumeTenant: (...args: unknown[]) => mockResumeTenant(...args),
  archiveTenant: (...args: unknown[]) => mockArchiveTenant(...args),
  unarchiveTenant: (...args: unknown[]) => mockUnarchiveTenant(...args),
  updateAiGenerateMode: (...args: unknown[]) => mockUpdateAiGenerateMode(...args),
}));

// Remaining dependencies that buildServer() pulls transitively.
vi.mock('@assessiq/users', () => ({
  listUsers: vi.fn(),
  getUser: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  softDelete: vi.fn(),
  restore: vi.fn(),
  inviteUser: vi.fn(),
  acceptInvitation: vi.fn(),
  bulkImport: vi.fn(),
  cancelInvitation: vi.fn(),
  sweepUserSessions: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@assessiq/question-bank', () => ({ registerQuestionBankRoutes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@assessiq/assessment-lifecycle', () => ({ registerAssessmentLifecycleRoutes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@assessiq/attempt-engine', () => ({ registerAttemptCandidateRoutes: vi.fn().mockResolvedValue(undefined), registerAttemptTakeRoutes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@assessiq/ai-grading', () => ({ registerGradingRoutes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@assessiq/help-system', () => ({
  registerHelpPublicRoutes: vi.fn().mockResolvedValue(undefined),
  registerHelpTrackRoutes: vi.fn().mockResolvedValue(undefined),
  registerHelpAuthRoutes: vi.fn().mockResolvedValue(undefined),
  registerHelpAdminRoutes: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@assessiq/notifications', () => ({ registerNotificationsRoutes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@assessiq/scoring', () => ({ registerScoringRoutes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@assessiq/analytics', () => ({ registerAnalyticsRoutes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@assessiq/embed-sdk', () => ({ EMBED_COOKIE_NAME: 'aiq_embed_sess', verifyEmbedToken: vi.fn() }));
vi.mock('../../routes/embed-admin.js', () => ({ registerEmbedAdminRoutes: vi.fn().mockResolvedValue(undefined) }));

import { buildServer } from '../../server.js';
import { NotFoundError } from '@assessiq/core';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SUPER_ADMIN_HEADERS = {
  'x-test-session-tenant': 'platform-tenant-uuid',
  'x-test-session-user': 'super-admin-user-uuid',
  'x-test-session-role': 'super_admin',
  'x-test-session-totp-verified': 'true',
};

const TENANT_ADMIN_HEADERS = {
  'x-test-session-tenant': 'other-tenant-uuid',
  'x-test-session-user': 'tenant-admin-user-uuid',
  'x-test-session-role': 'admin',
  'x-test-session-totp-verified': 'true',
};

const REVIEWER_HEADERS = {
  'x-test-session-tenant': 'other-tenant-uuid',
  'x-test-session-user': 'reviewer-user-uuid',
  'x-test-session-role': 'reviewer',
  'x-test-session-totp-verified': 'true',
};

const TARGET_TENANT_ID = 'target-tenant-uuid';

const SUCCESS_RESULT = {
  tenantId: TARGET_TENANT_ID,
  ai_generate_mode: 'sharded' as const,
  previous: null as null,
  updatedAt: new Date('2026-05-10T10:00:00Z'),
  auditId: 'audit-row-uuid-001',
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('PATCH /api/admin/super/tenants/:tenantId/ai-generate-mode', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── 1. Happy path: super_admin flips mode ────────────────────────────

  it('returns 200 with tenantId/ai_generate_mode/previous/updatedAt/auditId for super_admin', async () => {
    mockUpdateAiGenerateMode.mockResolvedValue(SUCCESS_RESULT);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/super/tenants/${TARGET_TENANT_ID}/ai-generate-mode`,
      headers: { ...SUPER_ADMIN_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'sharded' }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      tenantId: string;
      ai_generate_mode: string;
      previous: null;
      updatedAt: string;
      auditId: string;
    }>();
    expect(body.tenantId).toBe(TARGET_TENANT_ID);
    expect(body.ai_generate_mode).toBe('sharded');
    expect(body.previous).toBeNull();
    expect(body.auditId).toBe('audit-row-uuid-001');
    // Verify service was called with correct args
    expect(mockUpdateAiGenerateMode).toHaveBeenCalledWith(
      'super-admin-user-uuid',
      TARGET_TENANT_ID,
      'sharded',
    );
  });

  // ─── 2. tenant_admin (role='admin') gets 403 ─────────────────────────

  it('returns 403 when caller has role=admin (tenant admin)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/super/tenants/${TARGET_TENANT_ID}/ai-generate-mode`,
      headers: { ...TENANT_ADMIN_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'sharded' }),
    });

    expect(res.statusCode).toBe(403);
    // Service MUST NOT be called — auth gate prevents it.
    expect(mockUpdateAiGenerateMode).not.toHaveBeenCalled();
  });

  // ─── 3. reviewer gets 403 ─────────────────────────────────────────────

  it('returns 403 when caller has role=reviewer', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/super/tenants/${TARGET_TENANT_ID}/ai-generate-mode`,
      headers: { ...REVIEWER_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'omnibus' }),
    });

    expect(res.statusCode).toBe(403);
    expect(mockUpdateAiGenerateMode).not.toHaveBeenCalled();
  });

  // ─── 4. unauthenticated gets 401 ──────────────────────────────────────

  it('returns 401 when no session cookie is present', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/super/tenants/${TARGET_TENANT_ID}/ai-generate-mode`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'sharded' }),
    });

    expect(res.statusCode).toBe(401);
    expect(mockUpdateAiGenerateMode).not.toHaveBeenCalled();
  });

  // ─── 5. invalid mode value gets 400 ───────────────────────────────────

  it('returns 400 for an invalid mode value', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/super/tenants/${TARGET_TENANT_ID}/ai-generate-mode`,
      headers: { ...SUPER_ADMIN_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'parallel' }), // not a valid mode
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(mockUpdateAiGenerateMode).not.toHaveBeenCalled();
  });

  it('returns 400 when mode is missing from body', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/super/tenants/${TARGET_TENANT_ID}/ai-generate-mode`,
      headers: { ...SUPER_ADMIN_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({}), // mode key absent → undefined
    });

    expect(res.statusCode).toBe(400);
    expect(mockUpdateAiGenerateMode).not.toHaveBeenCalled();
  });

  // ─── 6. null mode (reset to global default) ───────────────────────────

  it('returns 200 when mode=null (reset to global default)', async () => {
    mockUpdateAiGenerateMode.mockResolvedValue({
      ...SUCCESS_RESULT,
      ai_generate_mode: null,
      previous: 'sharded',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/super/tenants/${TARGET_TENANT_ID}/ai-generate-mode`,
      headers: { ...SUPER_ADMIN_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: null }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ ai_generate_mode: null; previous: string }>();
    expect(body.ai_generate_mode).toBeNull();
    expect(body.previous).toBe('sharded');
    expect(mockUpdateAiGenerateMode).toHaveBeenCalledWith(
      'super-admin-user-uuid',
      TARGET_TENANT_ID,
      null,
    );
  });

  // ─── 7. non-existent tenant → 404 ────────────────────────────────────

  it('returns 404 when the target tenant has no tenant_settings row', async () => {
    mockUpdateAiGenerateMode.mockRejectedValue(
      new NotFoundError('tenant_settings not found for tenant ghost-tenant-uuid'),
    );

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/super/tenants/ghost-tenant-uuid/ai-generate-mode`,
      headers: { ...SUPER_ADMIN_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'sharded' }),
    });

    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  // ─── 8. audit emit failure rolls back UPDATE ─────────────────────────
  //
  // The service method runs UPDATE + auditInTx in the same withTenant
  // transaction. If auditInTx throws, withTenant rolls back the UPDATE.
  // The handler must surface this as a 500 (or the underlying error code).
  //
  // In this test we mock updateAiGenerateMode to throw a DB error, simulating
  // an auditInTx failure mid-transaction. The test asserts:
  //   a) the response is 500 (not 200)
  //   b) the service was called once (handler did reach the service)
  //   c) the caller sees an error envelope (UPDATE not silently swallowed)

  it('returns 500 when the service throws due to audit emit failure (UPDATE rolls back)', async () => {
    const dbError = new Error('INSERT into audit_log failed: permission denied');
    mockUpdateAiGenerateMode.mockRejectedValue(dbError);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/super/tenants/${TARGET_TENANT_ID}/ai-generate-mode`,
      headers: { ...SUPER_ADMIN_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'sharded' }),
    });

    expect(res.statusCode).toBe(500);
    // The response must contain an error envelope — not silently return 200.
    const body = res.json<{ error: { code: string } }>();
    expect(body.error).toBeDefined();
    // Service was attempted once.
    expect(mockUpdateAiGenerateMode).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Tenant lifecycle endpoints: suspend / resume / archive / unarchive
//
// These POST routes are gated by superAdminFreshMfa. The handler:
//   - parses + validates body.reason (≤500 chars, no control chars)
//   - calls the matching service fn (mocked here)
//   - on suspend + archive AND !noOp, sweeps tenant sessions (destroyAllForTenant)
//     and returns sessionsRevoked; resume/unarchive never sweep
//   - returns 200 { tenantId, slug, status, previousStatus, noOp, auditId,
//     sessionsRevoked? }
// Note: the test seam does not enforce fresh-MFA (see the @assessiq/auth mock).
// ---------------------------------------------------------------------------

describe('POST /api/admin/super/tenants/:tenantId/{suspend,resume,archive,unarchive}', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const lifecycleResult = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    tenantId: TARGET_TENANT_ID,
    slug: 'acme',
    previousStatus: 'active',
    newStatus: 'suspended',
    auditId: 'audit-life-001',
    noOp: false,
    ...over,
  });

  const post = (action: string, headers: Record<string, string>, body: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/admin/super/tenants/${TARGET_TENANT_ID}/${action}`,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  // ─── suspend: happy path sweeps sessions ──────────────────────────────
  it('suspend: 200 with status/previousStatus/noOp + sessionsRevoked for super_admin', async () => {
    mockSuspendTenant.mockResolvedValue(lifecycleResult());

    const res = await post('suspend', SUPER_ADMIN_HEADERS, { reason: 'policy violation' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      tenantId: string; slug: string; status: string; previousStatus: string;
      noOp: boolean; auditId: string; sessionsRevoked?: { count: number; affectedUsers: string[] };
    }>();
    expect(body.status).toBe('suspended');
    expect(body.previousStatus).toBe('active');
    expect(body.noOp).toBe(false);
    expect(body.auditId).toBe('audit-life-001');
    // suspend (not noOp) MUST report a session sweep result.
    expect(body.sessionsRevoked).toEqual({ count: 0, affectedUsers: [] });
    // actorUserId + actorTenantId come from the session, reason from the body.
    expect(mockSuspendTenant).toHaveBeenCalledWith(
      TARGET_TENANT_ID, 'super-admin-user-uuid', 'platform-tenant-uuid', 'policy violation',
    );
  });

  // ─── suspend: idempotent no-op skips the session sweep ────────────────
  it('suspend: noOp result omits sessionsRevoked (no sweep on already-suspended)', async () => {
    mockSuspendTenant.mockResolvedValue(
      lifecycleResult({ previousStatus: 'suspended', newStatus: 'suspended', noOp: true, auditId: null }),
    );

    const res = await post('suspend', SUPER_ADMIN_HEADERS, {});

    expect(res.statusCode).toBe(200);
    const body = res.json<{ noOp: boolean; sessionsRevoked?: unknown }>();
    expect(body.noOp).toBe(true);
    expect(body.sessionsRevoked).toBeUndefined();
  });

  // ─── archive: happy path sweeps sessions ──────────────────────────────
  it('archive: 200 archived + sweeps sessions', async () => {
    mockArchiveTenant.mockResolvedValue(
      lifecycleResult({ newStatus: 'archived', previousStatus: 'active', auditId: 'audit-life-arch' }),
    );

    const res = await post('archive', SUPER_ADMIN_HEADERS, { reason: 'end of life' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; sessionsRevoked?: unknown }>();
    expect(body.status).toBe('archived');
    expect(body.sessionsRevoked).toBeDefined();
    expect(mockArchiveTenant).toHaveBeenCalledWith(
      TARGET_TENANT_ID, 'super-admin-user-uuid', 'platform-tenant-uuid', 'end of life',
    );
  });

  // ─── resume: never sweeps (re-enabling access) ────────────────────────
  it('resume: 200 active and never includes sessionsRevoked', async () => {
    mockResumeTenant.mockResolvedValue(
      lifecycleResult({ newStatus: 'active', previousStatus: 'suspended', auditId: 'audit-life-res' }),
    );

    const res = await post('resume', SUPER_ADMIN_HEADERS, {});

    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; sessionsRevoked?: unknown }>();
    expect(body.status).toBe('active');
    expect(body.sessionsRevoked).toBeUndefined();
  });

  // ─── wrong-direction transition → 409 ─────────────────────────────────
  it('unarchive: 409 when the service throws INVALID_LIFECYCLE_TRANSITION', async () => {
    const { ConflictError } = await import('@assessiq/core');
    mockUnarchiveTenant.mockRejectedValue(
      new ConflictError("tenant cannot transition from 'active' to 'active'", {
        details: { code: 'INVALID_LIFECYCLE_TRANSITION', currentStatus: 'active' },
      }),
    );

    const res = await post('unarchive', SUPER_ADMIN_HEADERS, {});

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error).toBeDefined();
  });

  // ─── role gate: tenant admin gets 403, service not called ─────────────
  it('suspend: 403 for role=admin (service not called)', async () => {
    const res = await post('suspend', TENANT_ADMIN_HEADERS, {});
    expect(res.statusCode).toBe(403);
    expect(mockSuspendTenant).not.toHaveBeenCalled();
  });

  // ─── unauthenticated → 401, service not called ────────────────────────
  it('archive: 401 when no session is present (service not called)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/super/tenants/${TARGET_TENANT_ID}/archive`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(401);
    expect(mockArchiveTenant).not.toHaveBeenCalled();
  });

  // ─── reason validation: control chars → 400 ───────────────────────────
  it('suspend: 400 INVALID_REASON when reason contains control characters', async () => {
    const res = await post('suspend', SUPER_ADMIN_HEADERS, { reason: 'bad' + String.fromCharCode(0) + 'reason' });
    expect(res.statusCode).toBe(400);
    expect(mockSuspendTenant).not.toHaveBeenCalled();
  });

  // ─── reason validation: > 500 chars → 400 ─────────────────────────────
  it('suspend: 400 INVALID_REASON when reason exceeds 500 chars', async () => {
    const res = await post('suspend', SUPER_ADMIN_HEADERS, { reason: 'x'.repeat(501) });
    expect(res.statusCode).toBe(400);
    expect(mockSuspendTenant).not.toHaveBeenCalled();
  });
});
