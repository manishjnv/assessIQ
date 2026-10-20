/**
 * PATCH /api/admin/super/users/:userId — target-role guard (roadmap Y-4).
 * Only admin targets are editable; candidate/legacy rows get 400 INVALID_ROLE.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('@assessiq/auth', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@assessiq/auth');
  const passthrough = (): unknown => async () => undefined;
  type MockReq = { headers: Record<string, string | undefined>; session?: Record<string, unknown>; apiKey?: unknown };
  const sessionLoaderMiddleware = (_opts?: unknown) => async (req: MockReq) => {
    const t = req.headers['x-test-session-tenant'];
    const u = req.headers['x-test-session-user'];
    const r = req.headers['x-test-session-role'];
    if (typeof t === 'string' && typeof u === 'string' && typeof r === 'string') {
      req.session = {
        id: 'test-session',
        tenantId: t,
        userId: u,
        role: r,
        totpVerified: true,
        expiresAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
        lastTotpAt: new Date().toISOString(),
      };
    }
  };
  const requireAuth = (opts: { roles?: string[] } = {}) => async (req: MockReq) => {
    const { AuthnError, AuthzError } = await import('@assessiq/core');
    if (req.session === undefined) throw new AuthnError('authentication required');
    if (Array.isArray(opts.roles) && !opts.roles.includes(req.session['role'] as string)) {
      throw new AuthzError('not authorized');
    }
  };
  return {
    ...actual,
    rateLimitMiddleware: () => passthrough(),
    sessionLoaderMiddleware,
    apiKeyAuthMiddleware: passthrough(),
    requireAuth,
    extendOnPassMiddleware: () => passthrough(),
    logLifecycleEvent: vi.fn(),
  };
});

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
  assertTenantActive: vi.fn().mockResolvedValue(undefined),
  createTenant: vi.fn(),
  activateTenant: vi.fn(),
  suspendTenant: vi.fn(),
  resumeTenant: vi.fn(),
  archiveTenant: vi.fn(),
  unarchiveTenant: vi.fn(),
  updateAiGenerateMode: vi.fn(),
}));

const mockResolveUserTenant = vi.fn();
const mockUpdateProfile = vi.fn();
const mockInviteUser = vi.fn();

vi.mock('@assessiq/users', () => ({
  listUsers: vi.fn(),
  getUser: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  softDelete: vi.fn(),
  restore: vi.fn(),
  acceptInvitation: vi.fn(),
  bulkImport: vi.fn(),
  cancelInvitation: vi.fn(),
  sweepUserSessions: vi.fn().mockResolvedValue(undefined),
  inviteUser: (...a: unknown[]) => mockInviteUser(...a),
  resolveUserTenant: (...a: unknown[]) => mockResolveUserTenant(...a),
  updateUserProfileAsSuperAdmin: (...a: unknown[]) => mockUpdateProfile(...a),
  listTenantUsersForSuperAdmin: vi.fn(),
  resolvePendingInvitationTenant: vi.fn(),
  disableUserAsSuperAdmin: vi.fn(),
  reenableUserAsSuperAdmin: vi.fn(),
  softDeleteUserAsSuperAdmin: vi.fn(),
  restoreUserAsSuperAdmin: vi.fn(),
}));
vi.mock('@assessiq/question-bank', () => ({ registerQuestionBankRoutes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@assessiq/assessment-lifecycle', () => ({ registerAssessmentLifecycleRoutes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@assessiq/attempt-engine', () => ({ registerAttemptCandidateRoutes: vi.fn().mockResolvedValue(undefined), registerAttemptTakeRoutes: vi.fn().mockResolvedValue(undefined), registerAttemptAdminRoutes: vi.fn().mockResolvedValue(undefined), registerCameraCandidateRoutes: vi.fn().mockResolvedValue(undefined), registerCameraAdminRoutes: vi.fn().mockResolvedValue(undefined) }));
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

const SUPER_ADMIN_HEADERS = {
  'x-test-session-tenant': 'platform-tenant-uuid',
  'x-test-session-user': 'super-admin-user-uuid',
  'x-test-session-role': 'super_admin',
};
const USER_ID = '00000000-0000-4000-8000-0000000000b1';
const TENANT_ID = '00000000-0000-4000-8000-0000000000a1';

const target = (role: string) => ({
  tenantId: TENANT_ID,
  email: 'a@example.com',
  name: 'Old Name',
  role,
  status: 'active',
  deleted_at: null,
});

describe('PATCH /api/admin/super/users/:userId — target role guard', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    mockResolveUserTenant.mockReset();
    mockUpdateProfile.mockReset();
    mockInviteUser.mockReset();
  });

  const patch = (body: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/admin/super/users/${USER_ID}`,
      headers: SUPER_ADMIN_HEADERS,
      payload: body,
    });

  it('rejects a candidate target with 400 INVALID_ROLE and does not update or invite', async () => {
    mockResolveUserTenant.mockResolvedValue(target('candidate'));
    const res = await patch({ name: 'New Name' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.code).toBe('INVALID_ROLE');
    expect(mockUpdateProfile).not.toHaveBeenCalled();
    expect(mockInviteUser).not.toHaveBeenCalled();
  });

  it('edits an admin target (200)', async () => {
    mockResolveUserTenant.mockResolvedValue(target('admin'));
    mockUpdateProfile.mockResolvedValue('audit-1');
    const res = await patch({ name: 'New Name' });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('admin');
    expect(mockUpdateProfile).toHaveBeenCalledTimes(1);
  });
});
