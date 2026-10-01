/**
 * GET /api/admin/tenant-settings + PATCH /api/admin/tenant-settings/result-release-mode (SP2).
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
  updateResultReleaseMode: (...a: unknown[]) => mockUpdateMode(...a),
  findTenantSettings: (...a: unknown[]) => mockFindSettings(...a),
  assertTenantActive: (...a: unknown[]) => mockAssertActive(...a),
  renameTenant: vi.fn(),
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

const hdr = (role: string, extra: Record<string, string> = {}, tenant = 'tenant-a-uuid'): Record<string, string> => ({
  'x-test-session-tenant': tenant,
  'x-test-session-user': `${role}-user-uuid`,
  'x-test-session-role': role,
  'content-type': 'application/json',
  ...extra,
});
const patch = (app: FastifyInstance, headers: Record<string, string>, body: unknown) =>
  app.inject({ method: 'PATCH', url: '/api/admin/tenant-settings/result-release-mode', headers, body: JSON.stringify(body) });
const get = (app: FastifyInstance, headers: Record<string, string>) =>
  app.inject({ method: 'GET', url: '/api/admin/tenant-settings', headers });

describe('GET /api/admin/tenant-settings', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); });
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithTenant.mockImplementation(async (_t, fn) => fn({}));
    mockFindSettings.mockResolvedValue({
      result_release_mode: 'auto',
      result_release_auto_since: new Date('2026-10-01T10:00:00.000Z'),
      retention_days: 730,
      webhook_secret: 'must-never-be-returned',
    });
    mockGetTenantById.mockResolvedValue({ id: 'tenant-a-uuid', name: 'Acme University' });
  });

  it('admin gets { result_release_mode, result_release_auto_since, retention_days, company_name } for its OWN tenant only', async () => {
    const res = await get(app, hdr('admin'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      result_release_mode: 'auto',
      result_release_auto_since: '2026-10-01T10:00:00.000Z',
      retention_days: 730,
      company_name: 'Acme University',
    });
    expect(mockWithTenant).toHaveBeenCalledWith('tenant-a-uuid', expect.any(Function));
    expect(mockGetTenantById).toHaveBeenCalledWith('tenant-a-uuid');
    expect(res.body).not.toContain('must-never-be-returned'); // webhook_secret never leaves
  });

  it('a manual tenant reports result_release_auto_since: null', async () => {
    mockFindSettings.mockResolvedValue({ result_release_mode: 'manual', result_release_auto_since: null, retention_days: 365 });
    const res = await get(app, hdr('admin'));
    expect(res.json()).toMatchObject({ result_release_mode: 'manual', result_release_auto_since: null, retention_days: 365 });
  });

  it('no read-side MFA freshness requirement (a stale TOTP can still read)', async () => {
    const res = await get(app, hdr('admin', { 'x-test-totp-age-min': '600' }));
    expect(res.statusCode).toBe(200);
  });

  it.each(['reviewer', 'candidate'])('%s gets 403', async (role) => {
    const res = await get(app, hdr(role));
    expect(res.statusCode).toBe(403);
    expect(mockFindSettings).not.toHaveBeenCalled();
  });

  it('unauthenticated gets 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/tenant-settings' });
    expect(res.statusCode).toBe(401);
  });

  it('404 when the tenant has no tenant_settings row', async () => {
    mockFindSettings.mockResolvedValue(null);
    expect((await get(app, hdr('admin'))).statusCode).toBe(404);
  });
});

describe('PATCH /api/admin/tenant-settings/result-release-mode', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); });
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertActive.mockResolvedValue(undefined);
    mockUpdateMode.mockResolvedValue({
      tenantId: 'tenant-a-uuid',
      result_release_mode: 'auto',
      previous: 'manual',
      result_release_auto_since: new Date('2026-10-01T10:00:00.000Z'),
      updatedAt: new Date('2026-10-01T10:00:00.000Z'),
      auditId: '42',
    });
  });

  it('admin with fresh MFA switches the mode (tenant + actor come from the session)', async () => {
    const res = await patch(app, hdr('admin'), { mode: 'auto' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      tenantId: 'tenant-a-uuid',
      result_release_mode: 'auto',
      previous: 'manual',
      result_release_auto_since: '2026-10-01T10:00:00.000Z',
      auditId: '42',
    });
    expect(mockAssertActive).toHaveBeenCalledWith('tenant-a-uuid');
    expect(mockUpdateMode).toHaveBeenCalledWith('admin-user-uuid', 'tenant-a-uuid', 'auto');
  });

  it('ignores a tenantId smuggled in the body — cannot change another tenant', async () => {
    await patch(app, hdr('admin'), { mode: 'auto', tenantId: 'tenant-b-uuid', tenant_id: 'tenant-b-uuid' });
    expect(mockUpdateMode).toHaveBeenCalledTimes(1);
    expect(mockUpdateMode).toHaveBeenCalledWith('admin-user-uuid', 'tenant-a-uuid', 'auto');
  });

  it('STALE TOTP (older than 15 min) -> the chain\'s 401 AUTHN_FAILED "fresh totp required"; nothing changes', async () => {
    const res = await patch(app, hdr('admin', { 'x-test-totp-age-min': '16' }), { mode: 'auto' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'AUTHN_FAILED', message: 'fresh totp required' } });
    expect(mockUpdateMode).not.toHaveBeenCalled();
  });

  it('no TOTP on the session at all -> 401 as well', async () => {
    const res = await patch(app, hdr('admin', { 'x-test-totp-age-min': 'none' }), { mode: 'auto' });
    expect(res.statusCode).toBe(401);
    expect(mockUpdateMode).not.toHaveBeenCalled();
  });

  it('a TOTP 14 minutes old is still fresh (15-minute window)', async () => {
    const res = await patch(app, hdr('admin', { 'x-test-totp-age-min': '14' }), { mode: 'manual' });
    expect(res.statusCode).toBe(200);
  });

  it.each(['reviewer', 'candidate'])('%s gets 403', async (role) => {
    const res = await patch(app, hdr(role), { mode: 'auto' });
    expect(res.statusCode).toBe(403);
    expect(mockUpdateMode).not.toHaveBeenCalled();
  });

  it('unauthenticated gets 401', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/admin/tenant-settings/result-release-mode',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'auto' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('invalid mode from the service -> 400', async () => {
    mockUpdateMode.mockRejectedValue(new ValidationError('mode must be manual or auto', { details: { code: 'INVALID_RESULT_RELEASE_MODE' } }));
    const res = await patch(app, hdr('admin'), { mode: 'bogus' });
    expect(res.statusCode).toBe(400);
  });

  it('missing body is passed through as an invalid mode (service rejects it)', async () => {
    mockUpdateMode.mockRejectedValue(new ValidationError('mode must be manual or auto', { details: { code: 'INVALID_RESULT_RELEASE_MODE' } }));
    const res = await app.inject({
      method: 'PATCH', url: '/api/admin/tenant-settings/result-release-mode', headers: hdr('admin'), body: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
    expect(mockUpdateMode).toHaveBeenCalledWith('admin-user-uuid', 'tenant-a-uuid', undefined);
  });

  it('suspended/archived tenant -> 409 TENANT_NOT_ACTIVE, no change', async () => {
    mockAssertActive.mockRejectedValue(new ConflictError('not writable', { details: { code: 'TENANT_NOT_ACTIVE' } }));
    const res = await patch(app, hdr('admin'), { mode: 'auto' });
    expect(res.statusCode).toBe(409);
    expect(mockUpdateMode).not.toHaveBeenCalled();
  });
});
