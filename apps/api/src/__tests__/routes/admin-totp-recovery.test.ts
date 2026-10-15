/**
 * RW-45 route tests: recovery-code regenerate + super-admin TOTP reset.
 * Auth/tenancy/users are mocked (same seam as admin-super.test.ts); the real
 * same-tx audit assertions live in modules/01-auth/src/__tests__/totp.test.ts.
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
const mockVerify = vi.fn();
const mockRegen = vi.fn();
const mockReset = vi.fn();
const mockGetUser = vi.fn();

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
    if (req.session !== undefined && req.headers['x-test-mfa-off'] !== 'true' && opts.requireTotpVerified !== false && !req.session.totpVerified) {
      throw new AuthnError('totp verification required');
    }
    // Fresh-MFA step-up: mirrors the real gate (AuthnError). x-test-session-totp-stale=true
    // makes the last TOTP older than any window. The age math is covered in 01-auth tests.
    // x-test-mfa-off mimics MFA_REQUIRED=false for a non-super role: the middleware skips the TOTP/fresh gates.
    // x-test-session-totp-stale sets lastTotpAt 20 min old (the middleware would reject; with mfa-off the handler must).
    if (req.session !== undefined && req.headers['x-test-session-totp-stale'] === 'true') {
      if (req.headers['x-test-mfa-off'] === 'true') {
        req.session.lastTotpAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
        return;
      }
      throw new AuthnError('fresh totp required');
    }
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
    totp: {
      verify: (...a: unknown[]) => mockVerify(...a),
      regenerateRecoveryCodes: (...a: unknown[]) => mockRegen(...a),
      adminResetTotp: (...a: unknown[]) => mockReset(...a),
    },
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
  getUser: (...a: unknown[]) => mockGetUser(...a),
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
vi.mock('@assessiq/attempt-engine', () => ({ registerAttemptCandidateRoutes: vi.fn().mockResolvedValue(undefined), registerAttemptTakeRoutes: vi.fn().mockResolvedValue(undefined), registerAttemptAdminRoutes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@assessiq/ai-grading', () => ({ registerGradingRoutes: vi.fn().mockResolvedValue(undefined), registerSuperEvaluationRoutes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@assessiq/help-system', () => ({
  registerHelpPublicRoutes: vi.fn().mockResolvedValue(undefined),
  registerHelpTrackRoutes: vi.fn().mockResolvedValue(undefined),
  registerHelpAuthRoutes: vi.fn().mockResolvedValue(undefined),
  registerHelpAdminRoutes: vi.fn().mockResolvedValue(undefined),
}));
const mockNotice = vi.fn();
vi.mock('@assessiq/notifications', () => ({
  registerNotificationsRoutes: vi.fn().mockResolvedValue(undefined),
  sendTotpResetNoticeEmail: (...a: unknown[]) => mockNotice(...a),
}));
vi.mock('@assessiq/scoring', () => ({ registerScoringRoutes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@assessiq/analytics', () => ({ registerAnalyticsRoutes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@assessiq/embed-sdk', () => ({ EMBED_COOKIE_NAME: 'aiq_embed_sess', verifyEmbedToken: vi.fn() }));
vi.mock('../../routes/embed-admin.js', () => ({ registerEmbedAdminRoutes: vi.fn().mockResolvedValue(undefined) }));

import { buildServer } from '../../server.js';
import { NotFoundError, AuthnError } from '@assessiq/core';

const T = '00000000-0000-4000-8000-0000000000a1';
const U = '00000000-0000-4000-8000-0000000000b2';
const SUPER = { 'x-test-session-tenant': 'platform', 'x-test-session-user': '00000000-0000-4000-8000-0000000000c3', 'x-test-session-role': 'super_admin', 'x-test-session-totp-verified': 'true' };
const SUPER_NO_TOTP = { ...SUPER, 'x-test-session-totp-verified': 'false' };
const ADMIN = { 'x-test-session-tenant': T, 'x-test-session-user': U, 'x-test-session-role': 'admin', 'x-test-session-totp-verified': 'true' };
const ADMIN_NO_TOTP = { ...ADMIN, 'x-test-session-totp-verified': 'false' };
const J = { 'content-type': 'application/json' };

describe('RW-45 routes', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); });
  beforeEach(() => { for (const m of [mockVerify, mockRegen, mockReset, mockGetUser, mockNotice]) m.mockReset(); });

  const regen = (headers: Record<string, string>, body: unknown) =>
    app.inject({ method: 'POST', url: '/api/auth/totp/recovery-codes/regenerate', headers: { ...headers, ...J }, payload: JSON.stringify(body) });
  const reset = (headers: Record<string, string>, body: unknown, userId = U) =>
    app.inject({ method: 'POST', url: `/api/admin/super/tenants/${T}/users/${userId}/totp/reset`, headers: { ...headers, ...J }, payload: JSON.stringify(body) });

  describe('POST /api/auth/totp/recovery-codes/regenerate', () => {
    it('returns the new codes when the current TOTP code verifies', async () => {
      mockVerify.mockResolvedValue(true);
      mockRegen.mockResolvedValue({ recoveryCodes: ['AAAAAAAA', 'BBBBBBBB'] });
      const res = await regen(ADMIN, { code: '123456' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ codes: ['AAAAAAAA', 'BBBBBBBB'] });
      expect(mockRegen).toHaveBeenCalledWith(U, T);
    });
    it('401 and no regeneration on a wrong code', async () => {
      mockVerify.mockResolvedValue(false);
      const res = await regen(ADMIN, { code: '000000' });
      expect(res.statusCode).toBe(401);
      expect(mockRegen).not.toHaveBeenCalled();
    });
    it('423 and no regeneration when locked out', async () => {
      mockVerify.mockRejectedValue(new AuthnError('account locked'));
      const res = await regen(ADMIN, { code: '000000' });
      expect(res.statusCode).toBe(423);
      expect(mockRegen).not.toHaveBeenCalled();
    });
    it('400 on a missing or malformed code', async () => {
      expect((await regen(ADMIN, {})).statusCode).toBe(400);
      expect((await regen(ADMIN, { code: 'ABCDEF' })).statusCode).toBe(400);
      expect(mockRegen).not.toHaveBeenCalled();
    });
    it('rejects a session that is not TOTP-verified', async () => {
      const res = await regen(ADMIN_NO_TOTP, { code: '123456' });
      expect(res.statusCode).toBe(401);
      expect(mockVerify).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/admin/super/tenants/:tenantId/users/:userId/totp/reset', () => {
    it('204 for a verified super admin; passes actor, tenant, target, trimmed reason', async () => {
      mockGetUser.mockResolvedValue({ id: U });
      mockReset.mockResolvedValue(undefined);
      const res = await reset(SUPER, { reason: '  lost phone  ' });
      expect(res.statusCode).toBe(204);
      expect(mockReset).toHaveBeenCalledWith(SUPER['x-test-session-user'], T, U, 'lost phone');
    });
    it('sends the notice after the reset, with the platform role and no secret', async () => {
      mockGetUser.mockResolvedValue({ id: U, email: 'a@x.test', name: 'Asha', role: 'admin' });
      mockReset.mockResolvedValue(undefined);
      await reset(SUPER, { reason: 'lost phone' });
      expect(mockNotice).toHaveBeenCalledTimes(1);
      expect(mockNotice.mock.invocationCallOrder[0]).toBeGreaterThan(mockReset.mock.invocationCallOrder[0]!);
      expect(mockNotice.mock.calls[0]![0]).toEqual({ to: 'a@x.test', recipientName: 'Asha', actorRole: 'super_admin', tenantId: T });
    });
    it('403 for a tenant admin', async () => {
      const res = await reset(ADMIN, { reason: 'x' });
      expect(res.statusCode).toBe(403);
      expect(mockReset).not.toHaveBeenCalled();
    });
    it('rejects a super admin without verified TOTP', async () => {
      const res = await reset(SUPER_NO_TOTP, { reason: 'x' });
      expect(res.statusCode).toBe(401);
      expect(mockReset).not.toHaveBeenCalled();
    });
    it('409 on self-reset', async () => {
      const res = await reset(SUPER, { reason: 'x' }, SUPER['x-test-session-user']);
      expect(res.statusCode).toBe(409);
      expect(mockReset).not.toHaveBeenCalled();
    });
    it('400 on missing, blank or over-long reason', async () => {
      for (const body of [{}, { reason: '   ' }, { reason: 'x'.repeat(501) }]) {
        expect((await reset(SUPER, body)).statusCode).toBe(400);
      }
      expect(mockReset).not.toHaveBeenCalled();
    });
    it('404 when the target is not in the tenant', async () => {
      mockGetUser.mockRejectedValue(new NotFoundError('user not found'));
      const res = await reset(SUPER, { reason: 'x' });
      expect(res.statusCode).toBe(404);
      expect(mockReset).not.toHaveBeenCalled();
    });
  });

  // RW-91: tenant admin reset. Tenant comes from the session (T); RLS scopes getUser.
  describe('POST /api/admin/users/:userId/totp/reset', () => {
    const TARGET = '00000000-0000-4000-8000-0000000000d4';
    const tenantReset = (headers: Record<string, string>, body: unknown, userId = TARGET) =>
      app.inject({ method: 'POST', url: `/api/admin/users/${userId}/totp/reset`, headers: { ...headers, ...J }, payload: JSON.stringify(body) });

    it('204 for an admin with fresh TOTP; resets then notifies with the role, never a secret', async () => {
      mockGetUser.mockResolvedValue({ id: TARGET, email: 'b@x.test', name: '', role: 'admin' });
      mockReset.mockResolvedValue(undefined);
      const res = await tenantReset(ADMIN, { reason: '  lost phone  ' });
      expect(res.statusCode).toBe(204);
      expect(mockGetUser).toHaveBeenCalledWith(T, TARGET);
      expect(mockReset).toHaveBeenCalledWith(U, T, TARGET, 'lost phone');
      expect(mockNotice.mock.invocationCallOrder[0]).toBeGreaterThan(mockReset.mock.invocationCallOrder[0]!);
      expect(mockNotice).toHaveBeenCalledWith({ to: 'b@x.test', recipientName: 'b@x.test', actorRole: 'admin', tenantId: T });
    });
    it('still 204 when the notice email fails', async () => {
      mockGetUser.mockResolvedValue({ id: TARGET, email: 'b@x.test', name: 'B', role: 'admin' });
      mockReset.mockResolvedValue(undefined);
      mockNotice.mockRejectedValue(new Error('smtp down'));
      expect((await tenantReset(ADMIN, { reason: 'x' })).statusCode).toBe(204);
    });
    it('401 without fresh TOTP; nothing is reset', async () => {
      const res = await tenantReset({ ...ADMIN, 'x-test-session-totp-stale': 'true' }, { reason: 'x' });
      expect(res.statusCode).toBe(401);
      expect(mockReset).not.toHaveBeenCalled();
    });
    it('401 FRESH_TOTP_REQUIRED with MFA off and no TOTP at all (handler enforces)', async () => {
      const res = await tenantReset({ ...ADMIN_NO_TOTP, 'x-test-mfa-off': 'true' }, { reason: 'x' });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.details.code).toBe('FRESH_TOTP_REQUIRED');
      expect(mockReset).not.toHaveBeenCalled();
    });
    it('401 with MFA off and a 20-minute-old TOTP', async () => {
      const res = await tenantReset({ ...ADMIN, 'x-test-mfa-off': 'true', 'x-test-session-totp-stale': 'true' }, { reason: 'x' });
      expect(res.statusCode).toBe(401);
      expect(mockReset).not.toHaveBeenCalled();
    });
    it('403 for a super admin session (admin-only route)', async () => {
      expect((await tenantReset(SUPER, { reason: 'x' })).statusCode).toBe(403);
      expect(mockReset).not.toHaveBeenCalled();
    });
    it('409 on self-reset', async () => {
      expect((await tenantReset(ADMIN, { reason: 'x' }, U)).statusCode).toBe(409);
      expect(mockReset).not.toHaveBeenCalled();
    });
    it('403 when the target is a super admin', async () => {
      mockGetUser.mockResolvedValue({ id: TARGET, email: 's@x.test', name: 'S', role: 'super_admin' });
      expect((await tenantReset(ADMIN, { reason: 'x' })).statusCode).toBe(403);
      expect(mockReset).not.toHaveBeenCalled();
      expect(mockNotice).not.toHaveBeenCalled();
    });
    it('404 when the user is in another tenant', async () => {
      mockGetUser.mockRejectedValue(new NotFoundError('user not found'));
      expect((await tenantReset(ADMIN, { reason: 'x' })).statusCode).toBe(404);
      expect(mockReset).not.toHaveBeenCalled();
    });
    it('400 on missing, blank or over-long reason', async () => {
      for (const body of [{}, { reason: '   ' }, { reason: 'x'.repeat(501) }]) {
        expect((await tenantReset(ADMIN, body)).statusCode).toBe(400);
      }
      expect(mockReset).not.toHaveBeenCalled();
    });
  });
});
