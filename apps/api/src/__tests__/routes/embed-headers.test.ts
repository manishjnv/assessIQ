/**
 * FU-B13 / RV44 — GET /embed header behaviour and GET /embed/sdk.js headers.
 *   (a) CSP frame-ancestors comes from the tenant origins
 *   (b) X-Frame-Options is absent on the success response
 *   (c) invalid token -> 401, no redirect, no session cookie, no session minted (fail closed)
 * Collaborators are mocked; buildEmbedCsp is the REAL implementation.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { AppError, AuthnError } from '@assessiq/core';

const h = vi.hoisted(() => ({
  verify: vi.fn(),
  origins: vi.fn(),
  mintSession: vi.fn(),
}));

vi.mock('@assessiq/auth', () => ({
  verifyEmbedToken: h.verify,
  mintEmbedToken: vi.fn(),
  extractClientIp: () => '203.0.113.9',
}));
vi.mock('@assessiq/embed-sdk', async () => {
  const csp = await vi.importActual<{ buildEmbedCsp: (o: string[]) => string }>('@assessiq/embed-sdk');
  return {
    buildEmbedCsp: csp.buildEmbedCsp,
    getEmbedOrigins: h.origins,
    mintEmbedSession: h.mintSession,
    resolveJitUser: vi.fn().mockResolvedValue({ userId: 'u1' }),
    EMBED_COOKIE_NAME: 'aiq_embed_sess',
  };
});
vi.mock('@assessiq/attempt-engine', () => ({ startAttempt: vi.fn().mockResolvedValue({ id: 'att1' }) }));
vi.mock('../../middleware/auth-chain.js', () => ({ publicAuthChain: [], authChain: () => [] }));

import { registerEmbedRoutes } from '../../routes/auth/embed.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await app.register(cookie);
  // Mimic the edge default that the handler must override for /embed.
  app.addHook('onRequest', async (_req, reply) => { reply.header('X-Frame-Options', 'DENY'); });
  app.setErrorHandler((err, _req, reply) => {
    const e = err as Partial<AppError> & { statusCode?: number };
    void reply.code(e.status ?? e.statusCode ?? 500).send({ error: { code: e.code } });
  });
  await registerEmbedRoutes(app);
  await app.ready();
});
afterAll(async () => { await app?.close(); });

describe('GET /embed headers', () => {
  it('sets CSP frame-ancestors from tenant origins and removes X-Frame-Options', async () => {
    h.verify.mockResolvedValueOnce({
      tenantId: 't1',
      payload: { email: 'a@b.c', name: 'A', sub: 's', assessment_id: 'as1', exp: 9999999999 },
    });
    h.origins.mockResolvedValueOnce(['https://portal.example.com']);
    h.mintSession.mockResolvedValueOnce({ token: 'sess', maxAge: 600 });
    const res = await app.inject({ method: 'GET', url: '/embed?token=good' });
    expect(res.statusCode).toBe(302);
    expect(res.headers['content-security-policy']).toBe('frame-ancestors https://portal.example.com');
    expect(res.headers['x-frame-options']).toBeUndefined();
  });

  it('tenant with no origins gets frame-ancestors none (fail closed)', async () => {
    h.verify.mockResolvedValueOnce({
      tenantId: 't1',
      payload: { email: 'a@b.c', name: 'A', sub: 's', assessment_id: 'as1', exp: 9999999999 },
    });
    h.origins.mockResolvedValueOnce([]);
    h.mintSession.mockResolvedValueOnce({ token: 'sess', maxAge: 600 });
    const res = await app.inject({ method: 'GET', url: '/embed?token=good' });
    expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
  });

  it('invalid token -> 401, no redirect, no cookie, no session minted', async () => {
    h.mintSession.mockClear();
    h.verify.mockRejectedValueOnce(new AuthnError('bad token'));
    const res = await app.inject({ method: 'GET', url: '/embed?token=bad' });
    expect(res.statusCode).toBe(401);
    expect(res.headers.location).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(h.mintSession).not.toHaveBeenCalled();
  });

  it('missing token -> 400-class, nothing minted', async () => {
    const res = await app.inject({ method: 'GET', url: '/embed' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('GET /embed/sdk.js', () => {
  it('serves the built SDK with version header and ETag; 304 on match', async () => {
    const res = await app.inject({ method: 'GET', url: '/embed/sdk.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/javascript');
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(res.headers['x-assessiq-sdk-version']).toMatch(/^\d+\.\d+\.\d+/);
    expect(res.body).toContain('AssessIQ');
    const etag = res.headers['etag'] as string;
    expect(etag).toBeTruthy();
    const again = await app.inject({ method: 'GET', url: '/embed/sdk.js', headers: { 'if-none-match': etag } });
    expect(again.statusCode).toBe(304);
  });
});
