/**
 * N26 — the reviewer role was removed (2026-10-02). HTTP-level guards:
 *   - 400 when an invite, a user create or a user PATCH uses role 'reviewer'
 *   - 403 for a session whose role is 'reviewer' on the notifications and TOTP routes
 *
 * Auth stub as admin-tenant-settings-release-mode.test.ts: session built from x-test-* headers,
 * the REAL requireAuth role gate. @assessiq/users and @assessiq/notifications are REAL:
 * every request here is rejected before any DB access.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
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
      req.session = {
        id: 'test-session', tenantId: t, userId: u, role: r, totpVerified: true,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        lastSeenAt: new Date().toISOString(),
        lastTotpAt: new Date(Date.now() - 60_000).toISOString(),
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
  updateResultReleaseMode: vi.fn(),
  findTenantSettings: vi.fn(),
  assertTenantActive: vi.fn(),
  renameTenant: vi.fn(),
  createTenant: vi.fn(),
  activateTenant: vi.fn(),
  suspendTenant: vi.fn(),
  resumeTenant: vi.fn(),
  archiveTenant: vi.fn(),
  unarchiveTenant: vi.fn(),
  updateAiGenerateMode: vi.fn(),
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
vi.mock('@assessiq/scoring', () => ({ registerScoringRoutes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@assessiq/analytics', () => ({ registerAnalyticsRoutes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@assessiq/embed-sdk', () => ({ EMBED_COOKIE_NAME: 'aiq_embed_sess', verifyEmbedToken: vi.fn() }));
vi.mock('../../routes/embed-admin.js', () => ({ registerEmbedAdminRoutes: vi.fn().mockResolvedValue(undefined) }));

import { buildServer } from '../../server.js';

const hdr = (role: string): Record<string, string> => ({
  'x-test-session-tenant': 'tenant-a-uuid',
  'x-test-session-user': `${role}-user-uuid`,
  'x-test-session-role': role,
  'content-type': 'application/json',
});

describe('reviewer role removed — HTTP level', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); });

  it('POST /api/admin/invitations with role reviewer is 400 (schema enum)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/admin/invitations', headers: hdr('admin'),
      payload: JSON.stringify({ email: 'new@example.com', role: 'reviewer' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/admin/users with role reviewer is 400 (INVALID_ROLE)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/admin/users', headers: hdr('admin'),
      payload: JSON.stringify({ email: 'new@example.com', name: 'New User', role: 'reviewer' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH /api/admin/users/:id with role reviewer is 400 (INVALID_ROLE)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/admin/users/00000000-0000-4000-8000-000000000001', headers: hdr('admin'),
      payload: JSON.stringify({ role: 'reviewer' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it.each([
    ['GET', '/api/admin/notifications'],
    ['POST', '/api/admin/notifications/00000000-0000-4000-8000-000000000001/mark-read'],
    ['GET', '/api/admin/webhooks'],
  ])('a reviewer session gets 403 on %s %s', async (method, url) => {
    const res = await app.inject(
      method === 'POST'
        ? { method: 'POST', url, headers: hdr('reviewer'), payload: '{}' }
        : { method: 'GET', url, headers: hdr('reviewer') },
    );
    expect(res.statusCode).toBe(403);
  });

  it('a reviewer session gets 403 on POST /api/auth/totp/enroll/start', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/totp/enroll/start', headers: hdr('reviewer'), payload: '{}' });
    expect(res.statusCode).toBe(403);
  });
});
