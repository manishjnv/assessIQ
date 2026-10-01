/**
 * PATCH /api/admin/tenant — tenant admin renames own company.
 * Route-level: role gate + tenant-from-session only. Service behaviour
 * (validation, audit, atomicity, cross-tenant isolation) is covered by the
 * 02-tenancy integration test rename-tenant.test.ts.
 * Auth stub mirrors admin-super.test.ts (x-test-session-* headers).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('@assessiq/auth', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@assessiq/auth');
  const passthrough = (): unknown => async () => undefined;
  type MockReq = { headers: Record<string, string | undefined>; session?: Record<string, unknown>; apiKey?: unknown };
  type AuthOpts = { roles?: string[] };
  const sessionLoaderMiddleware = (_o?: unknown) => async (req: MockReq) => {
    const t = req.headers['x-test-session-tenant'];
    const u = req.headers['x-test-session-user'];
    const r = req.headers['x-test-session-role'];
    if (typeof t === 'string' && typeof u === 'string' && typeof r === 'string') {
      req.session = {
        id: 'test-session', tenantId: t, userId: u, role: r, totpVerified: true,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(), lastTotpAt: new Date().toISOString(),
      };
    }
  };
  const requireAuth = (opts: AuthOpts = {}) => async (req: MockReq) => {
    const { AuthnError, AuthzError } = await import('@assessiq/core');
    if (req.session === undefined && req.apiKey === undefined) throw new AuthnError('authentication required');
    if (req.session !== undefined && Array.isArray(opts.roles) && !opts.roles.includes(req.session.role as string)) {
      throw new AuthzError(`role ${String(req.session.role)} not authorized`);
    }
  };
  return {
    ...actual,
    rateLimitMiddleware: (_o?: unknown) => passthrough(),
    sessionLoaderMiddleware,
    apiKeyAuthMiddleware: passthrough(),
    requireAuth,
    extendOnPassMiddleware: (_n: string) => passthrough(),
  };
});

const mockRenameTenant = vi.fn();
const mockAssertActive = vi.fn();
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
  updateRetentionDays: vi.fn(),
  assertTenantActive: (...a: unknown[]) => mockAssertActive(...a),
  renameTenant: (...a: unknown[]) => mockRenameTenant(...a),
  createTenant: vi.fn(),
  activateTenant: vi.fn(),
  suspendTenant: vi.fn(),
  resumeTenant: vi.fn(),
  archiveTenant: vi.fn(),
  unarchiveTenant: vi.fn(),
  updateAiGenerateMode: vi.fn(),
}));

vi.mock('@assessiq/users', () => ({
  listUsers: vi.fn(), getUser: vi.fn(), createUser: vi.fn(), updateUser: vi.fn(), softDelete: vi.fn(),
  restore: vi.fn(), inviteUser: vi.fn(), acceptInvitation: vi.fn(), bulkImport: vi.fn(),
  cancelInvitation: vi.fn(), sweepUserSessions: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@assessiq/question-bank', () => ({ registerQuestionBankRoutes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@assessiq/assessment-lifecycle', () => ({ registerAssessmentLifecycleRoutes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@assessiq/attempt-engine', () => ({ registerAttemptCandidateRoutes: vi.fn().mockResolvedValue(undefined), registerAttemptTakeRoutes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@assessiq/ai-grading', () => ({ registerGradingRoutes: vi.fn().mockResolvedValue(undefined), registerSuperEvaluationRoutes: vi.fn().mockResolvedValue(undefined) }));
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
import { ValidationError, ConflictError } from '@assessiq/core';

const hdr = (role: string, tenant = 'tenant-a-uuid'): Record<string, string> => ({
  'x-test-session-tenant': tenant,
  'x-test-session-user': `${role}-user-uuid`,
  'x-test-session-role': role,
  'content-type': 'application/json',
});
const patch = (app: FastifyInstance, headers: Record<string, string>, body: unknown) =>
  app.inject({ method: 'PATCH', url: '/api/admin/tenant', headers, body: JSON.stringify(body) });

describe('PATCH /api/admin/tenant', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); });
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertActive.mockResolvedValue(undefined);
  });

  it('admin renames own tenant (tenant + actor come from the session)', async () => {
    mockRenameTenant.mockResolvedValue({ tenantId: 'tenant-a-uuid', name: 'New Co', previousName: 'Old Co', auditId: 'a1', noOp: false });
    const res = await patch(app, hdr('admin'), { name: 'New Co' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'New Co', previousName: 'Old Co', auditId: 'a1', noOp: false });
    expect(mockAssertActive).toHaveBeenCalledWith('tenant-a-uuid');
    expect(mockRenameTenant).toHaveBeenCalledWith('admin-user-uuid', 'tenant-a-uuid', 'New Co');
  });

  it('ignores a tenantId/slug smuggled in the body — cannot rename another tenant', async () => {
    mockRenameTenant.mockResolvedValue({ tenantId: 'tenant-a-uuid', name: 'X Co', previousName: 'Old', auditId: 'a2', noOp: false });
    await patch(app, hdr('admin'), { name: 'X Co', tenantId: 'tenant-b-uuid', id: 'tenant-b-uuid', slug: 'evil' });
    expect(mockRenameTenant).toHaveBeenCalledTimes(1);
    expect(mockRenameTenant).toHaveBeenCalledWith('admin-user-uuid', 'tenant-a-uuid', 'X Co');
    expect(mockAssertActive).toHaveBeenCalledWith('tenant-a-uuid');
  });

  it.each(['reviewer', 'candidate', 'super_admin'])('%s gets 403', async (role) => {
    const res = await patch(app, hdr(role), { name: 'Hacked' });
    expect(res.statusCode).toBe(403);
    expect(mockRenameTenant).not.toHaveBeenCalled();
  });

  it('unauthenticated gets 401', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/admin/tenant',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'X Co' }),
    });
    expect(res.statusCode).toBe(401);
    expect(mockRenameTenant).not.toHaveBeenCalled();
  });

  it('validation error from service -> 400', async () => {
    mockRenameTenant.mockRejectedValue(new ValidationError('bad', { details: { code: 'INVALID_NAME_LENGTH' } }));
    const res = await patch(app, hdr('admin'), { name: 'A' });
    expect(res.statusCode).toBe(400);
  });

  it('suspended/archived tenant -> 409 TENANT_NOT_ACTIVE, no rename', async () => {
    mockAssertActive.mockRejectedValue(new ConflictError('not writable', { details: { code: 'TENANT_NOT_ACTIVE' } }));
    const res = await patch(app, hdr('admin'), { name: 'New Co' });
    expect(res.statusCode).toBe(409);
    expect(mockRenameTenant).not.toHaveBeenCalled();
  });
});
