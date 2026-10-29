/**
 * PATCH /api/admin/tenant-settings/candidate-answer-key (Z-172).
 *
 * Route-level: role gates, tenant-from-session, the REAL requireAuth fresh-MFA gate
 * (a stale TOTP surfaces as the chain's 401 AUTHN_FAILED "fresh totp required"), and the
 * response contract. Service behaviour (audit row, no-op, auto_since stamping, atomicity)
 * is covered by 02-tenancy result-release-mode.test.ts.
 *
 * Auth stub: session built from x-test-* headers (as admin-tenant-rename.test.ts), but
 * requireAuth is the REAL one from @assessiq/auth so freshMfaWithinMinutes is truly enforced.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('@assessiq/auth', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@assessiq/auth');
  const passthrough = (): unknown => async () => undefined;
  type MockReq = { headers: Record<string, string | undefined>; session?: Record<string, unknown>; apiKey?: unknown };
  const sessionLoaderMiddleware = (_o?: unknown) => async (req: MockReq) => {
    const t = req.headers['x-test-session-tenant'];
    const u = req.headers['x-test-session-user'];
    const r = req.headers['x-test-session-role'];
    if (typeof t === 'string' && typeof u === 'string' && typeof r === 'string') {
      const ageMin = req.headers['x-test-totp-age-min'];
      req.session = {
        id: 'test-session', tenantId: t, userId: u, role: r, totpVerified: true,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        lastSeenAt: new Date().toISOString(),
        // 'none' => never did TOTP; otherwise N minutes ago (default: 1 minute ago = fresh)
        lastTotpAt: ageMin === 'none' ? null : new Date(Date.now() - Number(ageMin ?? '1') * 60_000).toISOString(),
      };
    }
  };
  return {
    ...actual,
    rateLimitMiddleware: (_o?: unknown) => passthrough(),
    sessionLoaderMiddleware,
    apiKeyAuthMiddleware: passthrough(),
    extendOnPassMiddleware: (_n: string) => passthrough(),
  };
});

const mockUpdateMode = vi.fn();
const mockAssertActive = vi.fn();
const mockFindSettings = vi.fn();
const mockGetTenantById = vi.fn();
const mockWithTenant = vi.fn(async (_tenantId: string, fn: (c: unknown) => Promise<unknown>) => fn({}));
vi.mock('@assessiq/tenancy', () => ({
  tenantContextMiddleware: () => ({
    preHandler: vi.fn().mockResolvedValue(undefined),
    onResponse: vi.fn().mockResolvedValue(undefined),
  }),
  getTenantBySlug: vi.fn(),
  getTenantById: (...a: unknown[]) => mockGetTenantById(...a),
  withTenant: (...a: Parameters<typeof mockWithTenant>) => mockWithTenant(...a),
  getPool: vi.fn(),
  closePool: vi.fn(),
  setPoolForTesting: vi.fn(),
  updateTenantSettings: vi.fn(),
  updateRetentionDays: vi.fn(),
  updateResultReleaseMode: vi.fn(),
  updateResultFeedbackLevel: vi.fn(),
  updateCandidateAnswerKey: (...a: unknown[]) => mockUpdateMode(...a),
  findTenantSettings: (...a: unknown[]) => mockFindSettings(...a),
  assertTenantActive: (...a: unknown[]) => mockAssertActive(...a),
  renameTenant: vi.fn(),
  setTenantAccent: vi.fn(),
  createTenant: vi.fn(),
  activateTenant: vi.fn(),
  suspendTenant: vi.fn(),
  resumeTenant: vi.fn(),
  archiveTenant: vi.fn(),
  unarchiveTenant: vi.fn(),
  updateAiGenerateMode: vi.fn(),
  getTenantLogoMeta: vi.fn().mockResolvedValue(null),
  tenantLogoUrl: vi.fn(),
}));

vi.mock('@assessiq/users', () => ({
  listUsers: vi.fn(), getUser: vi.fn(), createUser: vi.fn(), updateUser: vi.fn(), softDelete: vi.fn(),
  restore: vi.fn(), inviteUser: vi.fn(), acceptInvitation: vi.fn(), bulkImport: vi.fn(),
  cancelInvitation: vi.fn(), sweepUserSessions: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@assessiq/question-bank', () => ({ registerQuestionBankRoutes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@assessiq/assessment-lifecycle', () => ({ registerAssessmentLifecycleRoutes: vi.fn().mockResolvedValue(undefined), setCameraRequiredResolver: vi.fn(), setRevokeAttemptSubmitter: vi.fn() }));
vi.mock('@assessiq/attempt-engine', () => ({ registerAttemptCandidateRoutes: vi.fn().mockResolvedValue(undefined), registerAttemptTakeRoutes: vi.fn().mockResolvedValue(undefined), registerAttemptAdminRoutes: vi.fn().mockResolvedValue(undefined), registerCameraCandidateRoutes: vi.fn().mockResolvedValue(undefined), registerCameraAdminRoutes: vi.fn().mockResolvedValue(undefined), listDeclinedCameraInvitationIds: vi.fn().mockResolvedValue([]), isCameraRequired: vi.fn(), submitAttemptForRevokeInTx: vi.fn().mockResolvedValue(false) }));
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
import { ConflictError } from '@assessiq/core';

const hdr = (role: string, extra: Record<string, string> = {}, tenant = 'tenant-a-uuid'): Record<string, string> => ({
  'x-test-session-tenant': tenant,
  'x-test-session-user': `${role}-user-uuid`,
  'x-test-session-role': role,
  'content-type': 'application/json',
  ...extra,
});
const patch = (app: FastifyInstance, headers: Record<string, string>, body: unknown) =>
  app.inject({ method: 'PATCH', url: '/api/admin/tenant-settings/candidate-answer-key', headers, body: JSON.stringify(body) });

describe('PATCH /api/admin/tenant-settings/candidate-answer-key', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); });
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertActive.mockResolvedValue(undefined);
    mockUpdateMode.mockResolvedValue({
      tenantId: 'tenant-a-uuid', candidate_answer_key: true, previous: false,
      updatedAt: new Date('2026-10-01T10:00:00.000Z'), auditId: '42',
    });
  });

  it('admin with fresh MFA sets the switch (tenant + actor come from the session)', async () => {
    const res = await patch(app, hdr('admin'), { enabled: true, tenantId: 'tenant-b-uuid' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ candidate_answer_key: true, previous: false, auditId: '42' });
    expect(mockUpdateMode).toHaveBeenCalledWith('admin-user-uuid', 'tenant-a-uuid', true);
  });

  it('stale TOTP -> 401, nothing changes', async () => {
    const res = await patch(app, hdr('admin', { 'x-test-totp-age-min': '16' }), { enabled: false });
    expect(res.statusCode).toBe(401);
    expect(mockUpdateMode).not.toHaveBeenCalled();
  });

  it.each(['reviewer', 'candidate'])('%s gets 403', async (role) => {
    expect((await patch(app, hdr(role), { enabled: false })).statusCode).toBe(403);
    expect(mockUpdateMode).not.toHaveBeenCalled();
  });

  it('unauthenticated gets 401', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/admin/tenant-settings/candidate-answer-key',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    });
    expect(res.statusCode).toBe(401);
  });

  it.each([{ enabled: 'yes' }, {}, { enabled: 1 }])('invalid body %j -> 400 INVALID_CANDIDATE_ANSWER_KEY', async (b) => {
    const res = await patch(app, hdr('admin'), b);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.code).toBe('INVALID_CANDIDATE_ANSWER_KEY');
    expect(mockUpdateMode).not.toHaveBeenCalled();
  });

  it('inactive tenant -> 409', async () => {
    mockAssertActive.mockRejectedValue(new ConflictError('not writable', { details: { code: 'TENANT_NOT_ACTIVE' } }));
    expect((await patch(app, hdr('admin'), { enabled: true })).statusCode).toBe(409);
    expect(mockUpdateMode).not.toHaveBeenCalled();
  });
});
