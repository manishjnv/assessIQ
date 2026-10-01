/**
 * POST /api/auth/candidate/verify-link — SP3 (2026-10-01): a successful magic-link
 * sign-in lands the candidate on the results portal (/candidate/results). The result
 * email's portal link goes through this flow, so the landing page is the result list.
 * Route-level only (the token / session services are mocked).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

const mockVerify = vi.fn();
const mockMint = vi.fn();
const mockDestroy = vi.fn();
vi.mock('@assessiq/auth', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@assessiq/auth');
  const passthrough = (): unknown => async () => undefined;
  return {
    ...actual,
    rateLimitMiddleware: (_o?: unknown) => passthrough(),
    sessionLoaderMiddleware: (_o?: unknown) => passthrough(),
    apiKeyAuthMiddleware: passthrough(),
    requireAuth: (_o?: unknown) => passthrough(),
    extendOnPassMiddleware: (_n: string) => passthrough(),
    verifyCandidateLoginTokenSystem: (...a: unknown[]) => mockVerify(...a),
    mintCandidateSession: (...a: unknown[]) => mockMint(...a),
    requestCandidateLoginLinkSystem: vi.fn(),
    sessions: { destroy: (...a: unknown[]) => mockDestroy(...a) },
  };
});
vi.mock('@assessiq/notifications', () => ({ sendEmail: vi.fn() }));

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerCandidateAuthRoutes } from '../../routes/auth/candidate.js';

describe('POST /api/auth/candidate/verify-link', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = Fastify();
    await app.register(cookie);
    await registerCandidateAuthRoutes(app);
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => {
    vi.clearAllMocks();
    mockDestroy.mockResolvedValue(undefined);
  });

  const post = (body: unknown) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/candidate/verify-link',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('valid token: session cookie set and the SPA is sent to /candidate/results', async () => {
    mockVerify.mockResolvedValue({ user_id: 'user-1', tenant_id: 'tenant-1' });
    mockMint.mockResolvedValue({ token: 'session-token-abc' });
    const res = await post({ token: 'a-valid-token' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, redirect: '/candidate/results' });
    expect(res.headers['set-cookie']).toContain('session-token-abc');
    expect(mockMint).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', tenantId: 'tenant-1' }));
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('invalid / expired token: { ok:false, error:"invalid_link" } and no session minted', async () => {
    mockVerify.mockResolvedValue(null);
    const res = await post({ token: 'expired' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, error: 'invalid_link' });
    expect(mockMint).not.toHaveBeenCalled();
  });

  it('missing token: invalid_link without touching the token service', async () => {
    const res = await post({});
    expect(res.json()).toEqual({ ok: false, error: 'invalid_link' });
    expect(mockVerify).not.toHaveBeenCalled();
  });
});
