/**
 * FU-B1 (2026-10-06) — the five module-14 audit routes are mounted in server.ts
 * behind the admin chain. HTTP-level guards:
 *   - 401 with no session on every route
 *   - 403 for a candidate session on every route
 *   - 200 for an admin session on the list, the two exports and the archive list
 *   - 503 S3_NOT_CONFIGURED for restore with the archive stub (a clean "not available")
 *
 * Auth stub as reviewer-role-removed.test.ts: session built from x-test-* headers,
 * the REAL requireAuth role gate. @assessiq/audit-log is REAL (the routes under
 * test); @assessiq/tenancy.withTenant runs the callback against a fake client
 * whose query() answers COUNT(*) with 0 and everything else with no rows, so
 * the list and the cursor-based exports complete without Postgres.
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

const fakeClient = {
  query: vi.fn(async (sql: unknown) => {
    const text = typeof sql === 'string' ? sql : '';
    if (text.includes('COUNT(*)')) return { rows: [{ count: '0' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }),
};

vi.mock('@assessiq/tenancy', () => ({
  tenantContextMiddleware: () => ({
    preHandler: vi.fn().mockResolvedValue(undefined),
    onResponse: vi.fn().mockResolvedValue(undefined),
  }),
  getTenantBySlug: vi.fn(),
  getTenantById: vi.fn(),
  withTenant: vi.fn(async (_tenantId: string, fn: (c: unknown) => Promise<unknown>) => fn(fakeClient)),
  onCommit: vi.fn(),
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
  listActiveTenantIds: vi.fn().mockResolvedValue([]),
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
vi.mock('@assessiq/notifications', () => ({ registerNotificationsRoutes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@assessiq/billing', () => ({ registerBillingRoutes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@assessiq/certification', () => ({ registerCertificationRoutes: vi.fn().mockResolvedValue(undefined), registerVerifyRoutes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@assessiq/embed-sdk', () => ({ EMBED_COOKIE_NAME: 'aiq_embed_sess', verifyEmbedToken: vi.fn() }));
vi.mock('../../routes/embed-admin.js', () => ({ registerEmbedAdminRoutes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../routes/admin-worker.js', () => ({ registerAdminWorkerRoutes: vi.fn().mockResolvedValue(undefined) }));

import { buildServer } from '../../server.js';

const hdr = (role: string): Record<string, string> => ({
  'x-test-session-tenant': '00000000-0000-4000-8000-00000000000a',
  'x-test-session-user': `00000000-0000-4000-8000-00000000000${role === 'admin' ? '1' : '2'}`,
  'x-test-session-role': role,
  'content-type': 'application/json',
});

const ROUTES: Array<['GET' | 'POST', string]> = [
  ['GET', '/api/admin/audit'],
  ['GET', '/api/admin/audit/export.csv'],
  ['GET', '/api/admin/audit/export.jsonl'],
  ['GET', '/api/admin/audit/archives'],
  ['POST', '/api/admin/audit/archives/2026-10-01/restore'],
];

describe('FU-B1 — audit routes are mounted behind the admin chain', () => {
  let app: FastifyInstance;
  const savedBucket = process.env['S3_BUCKET'];
  beforeAll(async () => {
    delete process.env['S3_BUCKET'];
    app = await buildServer();
  });
  afterAll(async () => {
    if (savedBucket !== undefined) process.env['S3_BUCKET'] = savedBucket;
    await app.close();
  });

  it.each(ROUTES)('%s %s answers 401 with no session', async (method, url) => {
    // content-type is set so the body parser does not answer 415 before the auth chain runs
    const res = await app.inject(
      method === 'POST' ? { method, url, headers: { 'content-type': 'application/json' }, payload: '{}' } : { method, url },
    );
    expect(res.statusCode).toBe(401);
  });

  it.each(ROUTES)('%s %s answers 403 for a candidate session', async (method, url) => {
    const res = await app.inject(
      method === 'POST' ? { method, url, headers: hdr('candidate'), payload: '{}' } : { method, url, headers: hdr('candidate') },
    );
    expect(res.statusCode).toBe(403);
  });

  it('GET /api/admin/audit answers 200 with the pagination envelope for an admin', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/audit?page=1&pageSize=10', headers: hdr('admin') });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ rows: [], total: 0, page: 1, pageSize: 10 });
  });

  it('GET /api/admin/audit answers 400 on a bad query for an admin', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/audit?actorKind=robot', headers: hdr('admin') });
    expect(res.statusCode).toBe(400);
  });

  it('the two exports answer 200 with the file headers for an admin', async () => {
    const csv = await app.inject({ method: 'GET', url: '/api/admin/audit/export.csv', headers: hdr('admin') });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('attachment');
    expect(csv.body.split('\n')[0]).toContain('id,tenant_id,actor_user_id');
    const jsonl = await app.inject({ method: 'GET', url: '/api/admin/audit/export.jsonl', headers: hdr('admin') });
    expect(jsonl.statusCode).toBe(200);
    expect(jsonl.headers['content-type']).toContain('application/x-ndjson');
  });

  it('GET /api/admin/audit/archives answers 200 with the stub note for an admin', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/audit/archives', headers: hdr('admin') });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ archives: [] });
  });

  it('POST restore answers a clean 503 S3_NOT_CONFIGURED with the archive stub', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/audit/archives/2026-10-01/restore', headers: hdr('admin'), payload: '{}' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'S3_NOT_CONFIGURED' });
  });
});
