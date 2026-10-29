/**
 * EXP-10 part 1, attack A08: who may touch the question image routes. The real auth chain (authChain) guards
 * POST /api/admin/question-assets and the two GET routes; the services are never reached by the denied callers.
 * The upload, size, type and tenant rules are tested against a real database in modules/04-question-bank.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';

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
vi.mock('@assessiq/tenancy', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@assessiq/tenancy');
  return {
    ...actual,
    tenantContextMiddleware: () => ({
      preHandler: vi.fn().mockResolvedValue(undefined),
      onResponse: vi.fn().mockResolvedValue(undefined),
    }),
  };
});

import { registerAssetRoutes } from '@assessiq/question-bank';
import { authChain } from '../../middleware/auth-chain.js';

const hdr = (role: string): Record<string, string> => ({
  'x-test-session-tenant': 'tenant-a-uuid',
  'x-test-session-user': `${role}-user-uuid`,
  'x-test-session-role': role,
});
const ID = '0190a0a0-0000-7000-8000-000000000001';
const URLS: Array<[string, string]> = [
  ['POST', '/api/admin/question-assets'],
  ['GET', `/api/admin/question-assets/${ID}`],
  ['GET', `/api/admin/question-assets/${ID}/meta`],
];

describe('A08 question image routes: who may call them', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = Fastify({ logger: false });
    // server.ts creates this per-request context; the chain mirrors the session into it.
    app.addHook('onRequest', async (req) => { (req as unknown as { assessiqCtx: unknown }).assessiqCtx = {}; });
    await app.register(multipart, { limits: { fileSize: 4 * 1024 * 1024, files: 1, fields: 10 } });
    app.setErrorHandler((e, _req, reply) => {
      const x = e as { status?: number; statusCode?: number; code?: string };
      reply.code(x.status ?? x.statusCode ?? 500).send({ code: x.code, message: (e as Error).message });
    });
    registerAssetRoutes(app, authChain({ roles: ['admin'] }), authChain({ roles: ['super_admin'] }));
    await app.ready();
  });
  afterAll(async () => { await app.close(); });

  it.each(URLS)('%s %s: no session is 401', async (method, url) => {
    const res = await app.inject({ method: method as 'GET' | 'POST', url, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { payload: '{}' } : {}) });
    expect(res.statusCode).toBe(401);
  });

  it.each(URLS)('%s %s: a candidate is 403', async (method, url) => {
    const res = await app.inject({ method: method as 'GET' | 'POST', url, headers: { ...hdr('candidate'), 'content-type': 'application/json' }, ...(method === 'POST' ? { payload: '{}' } : {}) });
    expect(res.statusCode).toBe(403);
  });

  it.each(URLS)('%s %s: a reviewer (removed role) is 403', async (method, url) => {
    const res = await app.inject({ method: method as 'GET' | 'POST', url, headers: { ...hdr('reviewer'), 'content-type': 'application/json' }, ...(method === 'POST' ? { payload: '{}' } : {}) });
    expect(res.statusCode).toBe(403);
  });

  it('a tenant admin may read images but not upload: POST is 403, GET passes the chain', async () => {
    const post = await app.inject({ method: 'POST', url: '/api/admin/question-assets', headers: { ...hdr('admin'), 'content-type': 'application/json' }, payload: '{}' });
    expect(post.statusCode).toBe(403);
    const get = await app.inject({ method: 'GET', url: `/api/admin/question-assets/${ID}/meta`, headers: hdr('admin') });
    expect([401, 403]).not.toContain(get.statusCode); // passes the chain (the service then answers or fails without a database)
  });

  it('a super admin passes the upload chain: an empty body is a 400 from the route, not a 401 or 403', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/question-assets', headers: { ...hdr('super_admin'), 'content-type': 'application/json' }, payload: '{}' });
    expect(res.statusCode).toBe(400);
  });

  it('a body over 700 KB is stopped by the route limit (413) before any parsing, even for a super admin', async () => {
    const big = JSON.stringify({ pack_id: ID, alt_text: 'x'.repeat(5), content_base64: 'A'.repeat(800 * 1024) });
    const res = await app.inject({ method: 'POST', url: '/api/admin/question-assets', headers: { ...hdr('super_admin'), 'content-type': 'application/json' }, payload: big });
    expect(res.statusCode).toBe(413);
  });
});
