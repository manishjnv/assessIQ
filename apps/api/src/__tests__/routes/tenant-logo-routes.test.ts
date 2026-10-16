/**
 * Logo L1 routes: PUT/DELETE /api/admin/tenant-settings/logo, GET logo field,
 * super-admin PUT/DELETE, and the public GET /api/public/tenant-logo/:tenantId.
 * Service behaviour (validation, audit, RLS) is covered by 02-tenancy tenant-logo.test.ts;
 * here: role gates, the REAL fresh-MFA gate, upload plumbing, status codes and headers.
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
const mockSetLogo = vi.fn();
const mockRemoveLogo = vi.fn();
const mockLogoMeta = vi.fn();
const mockLogoBytes = vi.fn();
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
  setTenantLogo: (...a: unknown[]) => mockSetLogo(...a),
  removeTenantLogo: (...a: unknown[]) => mockRemoveLogo(...a),
  getTenantLogoMeta: (...a: unknown[]) => mockLogoMeta(...a),
  getTenantLogoBytes: (...a: unknown[]) => mockLogoBytes(...a),
  tenantLogoUrl: (t: string, sha: string) => `/api/public/tenant-logo/${t}?v=${sha.slice(0, 12)}`,
  LOGO_MAX_BYTES: 512 * 1024,
}));

vi.mock('@assessiq/users', () => ({
  listUsers: vi.fn(), getUser: vi.fn(), createUser: vi.fn(), updateUser: vi.fn(), softDelete: vi.fn(),
  restore: vi.fn(), inviteUser: vi.fn(), acceptInvitation: vi.fn(), bulkImport: vi.fn(),
  cancelInvitation: vi.fn(), sweepUserSessions: vi.fn().mockResolvedValue(undefined),
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
vi.mock('@assessiq/notifications', () => ({ registerNotificationsRoutes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@assessiq/scoring', () => ({ registerScoringRoutes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@assessiq/analytics', () => ({ registerAnalyticsRoutes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@assessiq/embed-sdk', () => ({ EMBED_COOKIE_NAME: 'aiq_embed_sess', verifyEmbedToken: vi.fn() }));
vi.mock('../../routes/embed-admin.js', () => ({ registerEmbedAdminRoutes: vi.fn().mockResolvedValue(undefined) }));


import { buildServer } from '../../server.js';
import { ValidationError } from '@assessiq/core';

const SHA = 'a'.repeat(64);
const META = { mime: 'image/png', width: 100, height: 50, byte_size: 40, sha256: SHA, updated_at: new Date('2026-10-16T10:00:00.000Z') };
const TENANT_B = '11111111-1111-4111-8111-111111111111';

const hdr = (role: string, extra: Record<string, string> = {}, tenant = 'tenant-a-uuid'): Record<string, string> => ({
  'x-test-session-tenant': tenant,
  'x-test-session-user': `${role}-user-uuid`,
  'x-test-session-role': role,
  ...extra,
});
const json = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', ...extra });
const b64 = (n: number) => Buffer.alloc(n, 1).toString('base64');

describe('PUT/DELETE /api/admin/tenant-settings/logo', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); });
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertActive.mockResolvedValue(undefined);
    mockSetLogo.mockResolvedValue(META);
    mockRemoveLogo.mockResolvedValue(true);
  });
  const put = (headers: Record<string, string>, body: unknown) =>
    app.inject({ method: 'PUT', url: '/api/admin/tenant-settings/logo', headers, body: JSON.stringify(body) });

  it('admin with fresh MFA uploads via JSON; tenant + actor come from the session', async () => {
    const res = await put(hdr('admin', json()), { content_base64: b64(40), tenantId: TENANT_B });
    expect(res.statusCode).toBe(200);
    expect(res.json().logo).toMatchObject({ mime: 'image/png', url: `/api/public/tenant-logo/tenant-a-uuid?v=${'a'.repeat(12)}` });
    expect(mockSetLogo).toHaveBeenCalledWith('tenant-a-uuid', expect.any(Buffer), 'admin-user-uuid');
  });

  it('multipart upload with field `file` works', async () => {
    const boundary = 'xBOUNDARYx';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="l.png"\r\nContent-Type: image/png\r\n\r\n`),
      Buffer.alloc(40, 1),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: 'PUT', url: '/api/admin/tenant-settings/logo',
      headers: hdr('admin', { 'content-type': `multipart/form-data; boundary=${boundary}` }), body,
    });
    expect(res.statusCode).toBe(200);
    expect(mockSetLogo.mock.calls[0]![1]).toHaveLength(40);
  });

  it('over 512 KB is 413 LOGO_TOO_LARGE', async () => {
    const res = await put(hdr('admin', json()), { content_base64: b64(512 * 1024 + 1) });
    expect(res.statusCode).toBe(413);
    expect(mockSetLogo).not.toHaveBeenCalled();
  });

  it('a bad image surfaces as 400 with the LOGO_BAD_FORMAT code', async () => {
    mockSetLogo.mockRejectedValue(new ValidationError('Only PNG and JPEG logos are accepted', { details: { code: 'LOGO_BAD_FORMAT' } }));
    const res = await put(hdr('admin', json()), { content_base64: b64(40) });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('LOGO_BAD_FORMAT');
  });

  it('missing content_base64 is 400', async () => {
    expect((await put(hdr('admin', json()), {})).statusCode).toBe(400);
  });

  it('stale TOTP is rejected by the real fresh-MFA gate', async () => {
    const res = await put(hdr('admin', json({ 'x-test-totp-age-min': '600' })), { content_base64: b64(40) });
    expect(res.statusCode).toBeGreaterThanOrEqual(401);
    expect(res.statusCode).toBeLessThan(404);
    expect(mockSetLogo).not.toHaveBeenCalled();
  });

  it.each(['candidate', 'reviewer'])('%s gets 403 on PUT and DELETE', async (role) => {
    expect((await put(hdr(role, json()), { content_base64: b64(40) })).statusCode).toBe(403);
    const del = await app.inject({ method: 'DELETE', url: '/api/admin/tenant-settings/logo', headers: hdr(role) });
    expect(del.statusCode).toBe(403);
    expect(mockSetLogo).not.toHaveBeenCalled();
    expect(mockRemoveLogo).not.toHaveBeenCalled();
  });

  it('DELETE is 204, also when there is no logo', async () => {
    mockRemoveLogo.mockResolvedValue(false);
    const res = await app.inject({ method: 'DELETE', url: '/api/admin/tenant-settings/logo', headers: hdr('admin') });
    expect(res.statusCode).toBe(204);
    expect(mockRemoveLogo).toHaveBeenCalledWith('tenant-a-uuid', 'admin-user-uuid');
  });

  it('GET /api/admin/tenant-settings includes logo (meta + url) or null', async () => {
    mockFindSettings.mockResolvedValue({ result_release_mode: 'manual', result_release_auto_since: null, retention_days: 365 });
    mockGetTenantById.mockResolvedValue({ id: 'tenant-a-uuid', name: 'Acme' });
    mockLogoMeta.mockResolvedValue(META);
    let res = await app.inject({ method: 'GET', url: '/api/admin/tenant-settings', headers: hdr('admin') });
    expect(res.json().logo).toMatchObject({ mime: 'image/png', sha256: SHA, url: expect.stringContaining('/api/public/tenant-logo/tenant-a-uuid?v=') });
    mockLogoMeta.mockResolvedValue(null);
    res = await app.inject({ method: 'GET', url: '/api/admin/tenant-settings', headers: hdr('admin') });
    expect(res.json().logo).toBeNull();
  });
});

describe('super-admin PUT/DELETE /api/admin/super/tenants/:tenantId/logo', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); });
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertActive.mockResolvedValue(undefined);
    mockSetLogo.mockResolvedValue(META);
    mockRemoveLogo.mockResolvedValue(true);
  });

  it('super_admin targets the tenant in the URL', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/api/admin/super/tenants/${TENANT_B}/logo`,
      headers: hdr('super_admin', json()), body: JSON.stringify({ content_base64: b64(40) }),
    });
    expect(res.statusCode).toBe(200);
    expect(mockSetLogo).toHaveBeenCalledWith(TENANT_B, expect.any(Buffer), 'super_admin-user-uuid');
    const del = await app.inject({ method: 'DELETE', url: `/api/admin/super/tenants/${TENANT_B}/logo`, headers: hdr('super_admin') });
    expect(del.statusCode).toBe(204);
  });

  it('a tenant admin gets 403', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/api/admin/super/tenants/${TENANT_B}/logo`,
      headers: hdr('admin', json()), body: JSON.stringify({ content_base64: b64(40) }),
    });
    expect(res.statusCode).toBe(403);
    expect(mockSetLogo).not.toHaveBeenCalled();
  });
});

describe('GET /api/public/tenant-logo/:tenantId', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); });
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogoBytes.mockResolvedValue({ mime: 'image/png', bytes: Buffer.from([1, 2, 3]), sha256: SHA });
  });
  const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });

  it('serves bytes with hardening headers and an immutable cache for the matching ?v=', async () => {
    const res = await get(`/api/public/tenant-logo/${TENANT_B}?v=${'a'.repeat(12)}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.headers.etag).toBe(`"${SHA}"`);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.rawPayload.equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(mockLogoBytes).toHaveBeenCalledWith(TENANT_B);
  });

  it('short cache without a matching ?v=', async () => {
    const res = await get(`/api/public/tenant-logo/${TENANT_B}?v=stale`);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
  });

  it('304 on If-None-Match', async () => {
    const res = await get(`/api/public/tenant-logo/${TENANT_B}`, { 'if-none-match': `"${SHA}"` });
    expect(res.statusCode).toBe(304);
  });

  it('404 for no logo and for a non-UUID id (no DB call)', async () => {
    mockLogoBytes.mockResolvedValue(null);
    expect((await get(`/api/public/tenant-logo/${TENANT_B}`)).statusCode).toBe(404);
    mockLogoBytes.mockClear();
    expect((await get('/api/public/tenant-logo/not-a-uuid')).statusCode).toBe(404);
    expect(mockLogoBytes).not.toHaveBeenCalled();
  });
});
