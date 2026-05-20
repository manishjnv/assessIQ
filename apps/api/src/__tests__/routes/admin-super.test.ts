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
vi.mock('@assessiq/auth', () => {
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
  };

  return {
    rateLimitMiddleware: (_opts?: unknown) => passthrough(),
    sessionLoaderMiddleware,
    apiKeyAuthMiddleware: passthrough(),
    requireAuth,
    requireRole: (_roles: string[]) => passthrough(),
    requireFreshMfa: (_min?: number) => passthrough(),
    requireScope: (_scope: string) => passthrough(),
    cookieParserMiddleware: passthrough(),
    requestIdMiddleware: passthrough(),
    extendOnPassMiddleware: (_name: string) => passthrough(),
    extractClientIp: () => 'test-ip',
    parseCookieHeader: () => ({}),
    sessions: { create: vi.fn(), get: vi.fn(), refresh: vi.fn() },
    totp: { enrollStart: vi.fn(), enrollConfirm: vi.fn(), verify: vi.fn() },
    apiKeys: { create: vi.fn(), list: vi.fn(), revoke: vi.fn(), authenticate: vi.fn(), requireScope: vi.fn() },
    normalizeEmail: (e: string) => e.trim().toLowerCase(),
    setRedisForTesting: vi.fn(),
    closeRedis: vi.fn().mockResolvedValue(undefined),
  };
});

// @assessiq/tenancy — mock updateAiGenerateMode; other symbols are no-ops.
const mockUpdateAiGenerateMode = vi.fn();

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
  suspendTenant: vi.fn(),
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
