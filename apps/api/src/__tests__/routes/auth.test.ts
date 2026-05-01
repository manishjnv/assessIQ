import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Mocks — hoist to top of file (vi.mock is hoisted by vitest).
// ---------------------------------------------------------------------------

// @assessiq/auth — replace library functions with vi.fn stubs and replace
// middleware factories with passthrough hooks. Tests then drive auth state
// by setting headers (x-test-session-* family) read by the passthrough hooks.
vi.mock('@assessiq/auth', () => {
  const passthrough = (): unknown => async (_req: unknown, _reply: unknown) => {
    // no-op
  };

  const sessionLoaderMiddleware = (_opts?: unknown) => async (req: any) => {
    // Test seam: read x-test-session-* headers and synthesize req.session.
    const t = req.headers['x-test-session-tenant'] as string | undefined;
    const u = req.headers['x-test-session-user'] as string | undefined;
    const r = req.headers['x-test-session-role'] as string | undefined;
    const totp = req.headers['x-test-session-totp-verified'] as string | undefined;
    if (typeof t === 'string' && typeof u === 'string' && typeof r === 'string') {
      req.session = {
        id: 'test-session',
        tenantId: t,
        userId: u,
        role: r,
        totpVerified: totp !== 'false',
        expiresAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
        lastTotpAt: totp === 'false' ? null : new Date().toISOString(),
      };
    }
  };

  const apiKeyAuthMiddleware = async () => {
    // Tests use cookies/session, not bearer tokens.
  };

  const requireAuth = (opts: any = {}) => async (req: any) => {
    const { AuthnError, AuthzError } = await import('@assessiq/core');
    if (req.session === undefined && req.apiKey === undefined) {
      throw new AuthnError('authentication required');
    }
    if (req.session !== undefined) {
      if (Array.isArray(opts.roles) && !opts.roles.includes(req.session.role)) {
        throw new AuthzError(`role ${req.session.role} not authorized`);
      }
      const requireTotp = opts.requireTotpVerified ?? (req.session.role !== 'candidate');
      if (requireTotp && !req.session.totpVerified) {
        throw new AuthnError('totp verification required');
      }
      if (typeof opts.freshMfaWithinMinutes === 'number' && req.session.lastTotpAt === null) {
        throw new AuthnError('fresh totp required');
      }
    }
  };

  return {
    // middleware factories / hooks — passthroughs
    rateLimitMiddleware: (_opts?: unknown) => passthrough(),
    sessionLoaderMiddleware,
    apiKeyAuthMiddleware,
    requireAuth,
    requireRole: (_roles: string[]) => passthrough(),
    requireFreshMfa: (_min?: number) => passthrough(),
    requireScope: (_scope: string) => passthrough(),
    cookieParserMiddleware: passthrough(),
    requestIdMiddleware: passthrough(),
    extendOnPassMiddleware: (_name: string) => passthrough(),
    extractClientIp: () => 'test-ip',
    parseCookieHeader: () => ({}),

    // library functions — vi.fn stubs configured per-test below
    sessions: {
      create: vi.fn(),
      get: vi.fn(),
      refresh: vi.fn(),
      markTotpVerified: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
      destroyAllForUser: vi.fn(),
    },
    totp: {
      enrollStart: vi.fn(),
      enrollConfirm: vi.fn(),
      verify: vi.fn(),
      consumeRecovery: vi.fn(),
      regenerateRecoveryCodes: vi.fn(),
    },
    apiKeys: {
      create: vi.fn(),
      list: vi.fn(),
      revoke: vi.fn().mockResolvedValue(undefined),
      authenticate: vi.fn(),
      requireScope: vi.fn(),
    },
    mintEmbedToken: vi.fn(),
    verifyEmbedToken: vi.fn(),
    createEmbedSecret: vi.fn(),
    rotateEmbedSecret: vi.fn(),
    startGoogleSso: vi.fn(),
    handleGoogleCallback: vi.fn(),
    normalizeEmail: (e: string) => e.trim().toLowerCase(),
    mintCandidateSession: vi.fn(),

    // test escape hatches (re-exported from index.ts)
    setRedisForTesting: vi.fn(),
    closeRedis: vi.fn().mockResolvedValue(undefined),
  };
});

// @assessiq/users — surface getUser only (whoami + totp enroll use it).
vi.mock('@assessiq/users', () => ({
  listUsers: vi.fn(),
  getUser: vi.fn().mockResolvedValue({
    id: 'u_1',
    tenantId: 't_1',
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    status: 'active',
  }),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  softDelete: vi.fn(),
  restore: vi.fn(),
  inviteUser: vi.fn(),
  acceptInvitation: vi.fn(),
  bulkImport: vi.fn(),
}));

// @assessiq/tenancy — getTenantBySlug for /api/auth/google/start;
// getTenantById for whoami; tenantContextMiddleware no-op.
vi.mock('@assessiq/tenancy', () => ({
  tenantContextMiddleware: () => ({
    preHandler: vi.fn().mockResolvedValue(undefined),
    onResponse: vi.fn().mockResolvedValue(undefined),
  }),
  getTenantBySlug: vi.fn().mockImplementation(async (slug: string) =>
    slug === 'unknown'
      ? null
      : { id: '01955600-0000-7f00-8000-000000000001', slug, name: slug },
  ),
  getTenantById: vi.fn().mockResolvedValue({
    id: '01955600-0000-7f00-8000-000000000001',
    slug: 'wipro-soc',
    name: 'Wipro SOC',
  }),
  withTenant: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
  setPoolForTesting: vi.fn(),
  updateTenantSettings: vi.fn(),
  suspendTenant: vi.fn(),
}));

import { buildServer } from '../../server.js';
import * as auth from '@assessiq/auth';

const ADMIN_VERIFIED_HEADERS = {
  'x-test-session-tenant': 'tenant-uuid',
  'x-test-session-user': 'user-uuid',
  'x-test-session-role': 'admin',
  'x-test-session-totp-verified': 'true',
};

const ADMIN_PRE_MFA_HEADERS = {
  ...ADMIN_VERIFIED_HEADERS,
  'x-test-session-totp-verified': 'false',
};

const REVIEWER_HEADERS = {
  ...ADMIN_VERIFIED_HEADERS,
  'x-test-session-role': 'reviewer',
};

describe('AssessIQ auth routes — security-critical', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Google SSO start ──────────────────────────────────────────────────
  describe('GET /api/auth/google/start', () => {
    it('returns 302 with Set-Cookie state+nonce when tenant slug is valid', async () => {
      vi.mocked(auth.startGoogleSso).mockResolvedValue({
        redirectUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
        stateCookie: {
          name: 'aiq_oauth_state',
          value: 's-value',
          opts: { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 600 },
        },
        nonceCookie: {
          name: 'aiq_oauth_nonce',
          value: 'n-value',
          opts: { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 600 },
        },
      });

      const res = await app.inject({ method: 'GET', url: '/api/auth/google/start?tenant=wipro-soc' });
      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toContain('accounts.google.com');
      const setCookies = res.headers['set-cookie'];
      const cookies = Array.isArray(setCookies) ? setCookies : [setCookies as string];
      expect(cookies.some((c) => c.startsWith('aiq_oauth_state='))).toBe(true);
      expect(cookies.some((c) => c.startsWith('aiq_oauth_nonce='))).toBe(true);
      expect(cookies.every((c) => /HttpOnly/i.test(c) && /SameSite=Lax/i.test(c))).toBe(true);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('returns 400 INVALID_TENANT_PARAM on missing tenant', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/auth/google/start' });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: { details?: { code?: string } } };
      expect(body.error.details?.code).toBe('INVALID_TENANT_PARAM');
    });

    it('returns 401 on unknown tenant slug', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/auth/google/start?tenant=unknown' });
      expect(res.statusCode).toBe(401);
    });

    it('returns 400 on malformed tenant slug', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/auth/google/start?tenant=BAD!SLUG' });
      expect(res.statusCode).toBe(400);
    });
  });

  // ─── Google SSO callback ───────────────────────────────────────────────
  describe('GET /api/auth/google/cb', () => {
    it('sets aiq_sess cookie with HttpOnly + SameSite=Lax on successful callback', async () => {
      vi.mocked(auth.handleGoogleCallback).mockResolvedValue({
        sessionToken: 'sess-token-abc',
        user: { id: 'u_1', email: 'a@x.com', tenantId: 't_1', role: 'admin' },
        redirectTo: '/admin/mfa',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/google/cb?code=abc&state=xyz',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toBe('/admin/mfa');
      const setCookies = res.headers['set-cookie'];
      const cookies = Array.isArray(setCookies) ? setCookies : [setCookies as string];
      const sessCookie = cookies.find((c) => c.startsWith('aiq_sess='));
      expect(sessCookie).toBeDefined();
      expect(sessCookie!).toMatch(/HttpOnly/i);
      expect(sessCookie!).toMatch(/SameSite=Lax/i);
      // Defense-in-depth: never None.
      expect(sessCookie!).not.toMatch(/SameSite=None/i);
    });

    it('returns 400 on missing code or state', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/auth/google/cb' });
      expect(res.statusCode).toBe(400);
    });
  });

  // ─── TOTP verify ───────────────────────────────────────────────────────
  describe('POST /api/auth/totp/verify', () => {
    it('returns 204 on successful verify and promotes session', async () => {
      vi.mocked(auth.totp.verify).mockResolvedValue(true);
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/verify',
        headers: { ...ADMIN_PRE_MFA_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ code: '123456' }),
      });
      expect(res.statusCode).toBe(204);
    });

    it('returns 401 INVALID_CODE on wrong code', async () => {
      vi.mocked(auth.totp.verify).mockResolvedValue(false);
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/verify',
        headers: { ...ADMIN_PRE_MFA_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ code: '000000' }),
      });
      expect(res.statusCode).toBe(401);
      const body = res.json() as { error: { code: string } };
      expect(body.error.code).toBe('INVALID_CODE');
    });

    it('returns 423 ACCOUNT_LOCKED when library signals lockout', async () => {
      const { AuthnError } = await import('@assessiq/core');
      vi.mocked(auth.totp.verify).mockRejectedValue(new AuthnError('account locked'));
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/verify',
        headers: { ...ADMIN_PRE_MFA_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ code: '000000' }),
      });
      expect(res.statusCode).toBe(423);
      const body = res.json() as { error: { code: string; details?: { retryAfterSeconds?: number } } };
      expect(body.error.code).toBe('ACCOUNT_LOCKED');
      expect(body.error.details?.retryAfterSeconds).toBe(900);
    });

    it('rejects malformed code (not 6 digits)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/verify',
        headers: { ...ADMIN_PRE_MFA_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ code: 'ABCDEF' }),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ─── Embed verify (alg=none + replay) ──────────────────────────────────
  describe('GET /embed', () => {
    it('returns 401 INVALID_TOKEN on alg=none or any AuthnError', async () => {
      const { AuthnError } = await import('@assessiq/core');
      vi.mocked(auth.verifyEmbedToken).mockRejectedValue(new AuthnError('invalid embed token'));
      // Even if a client crafts {"alg":"none"} header + claims, the library
      // rejects via AuthnError; the route maps to 401 INVALID_TOKEN uniformly.
      const algNoneToken = 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJhdWQiOiJhc3Nlc3NpcSJ9.';
      const res = await app.inject({ method: 'GET', url: `/embed?token=${algNoneToken}` });
      expect(res.statusCode).toBe(401);
      const body = res.json() as { error: { code: string } };
      expect(body.error.code).toBe('INVALID_TOKEN');
      // No session cookie should be set on failure.
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('returns 200 on valid token; second call (replay) returns 401', async () => {
      vi.mocked(auth.verifyEmbedToken)
        .mockResolvedValueOnce({
          payload: {
            iss: 'host', aud: 'assessiq', sub: 'h-user', tenant_id: 't-1',
            email: 'c@x.com', name: 'C', assessment_id: 'a-1', iat: 0, exp: 9, jti: 'j-1',
          },
          tenantId: 't-1',
        })
        .mockRejectedValueOnce(
          new (await import('@assessiq/core')).AuthnError('invalid embed token'),
        );

      const r1 = await app.inject({ method: 'GET', url: '/embed?token=valid' });
      expect(r1.statusCode).toBe(200);
      const b1 = r1.json() as { accepted: boolean; tenantId: string; assessmentId: string };
      expect(b1.accepted).toBe(true);
      expect(b1.tenantId).toBe('t-1');
      expect(b1.assessmentId).toBe('a-1');

      const r2 = await app.inject({ method: 'GET', url: '/embed?token=valid' });
      expect(r2.statusCode).toBe(401);
    });

    it('returns 400 MISSING_TOKEN when token query param is absent', async () => {
      const res = await app.inject({ method: 'GET', url: '/embed' });
      expect(res.statusCode).toBe(400);
    });
  });

  // ─── API keys (role + freshMfa) ────────────────────────────────────────
  describe('POST /api/admin/api-keys', () => {
    it('rejects reviewer role with 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/api-keys',
        headers: { ...REVIEWER_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'k1', scopes: ['attempts:read'] }),
      });
      expect(res.statusCode).toBe(403);
    });

    it('accepts admin and returns 201 with plaintextKey ONCE', async () => {
      vi.mocked(auth.apiKeys.create).mockResolvedValue({
        record: {
          id: '01955600-0000-7f00-8000-000000000099',
          tenantId: 't-1',
          name: 'k1',
          keyPrefix: 'aiq_live_xy',
          scopes: ['attempts:read'],
          status: 'active',
          lastUsedAt: null,
          createdBy: 'user-uuid',
          createdAt: new Date().toISOString(),
          expiresAt: null,
        },
        plaintextKey: 'aiq_live_secret-43-char-base62-string-here-padded-x',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/api-keys',
        headers: { ...ADMIN_VERIFIED_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'k1', scopes: ['attempts:read'] }),
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { plaintextKey: string; keyPrefix: string };
      expect(body.plaintextKey).toMatch(/^aiq_live_/);
      expect(body.keyPrefix).toMatch(/^aiq_live_/);
    });

    it('rejects invalid scope value with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/api-keys',
        headers: { ...ADMIN_VERIFIED_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'k1', scopes: ['not-a-real-scope'] }),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ─── Logout ────────────────────────────────────────────────────────────
  describe('POST /api/auth/logout', () => {
    it('returns 204 and clears the aiq_sess cookie', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: ADMIN_VERIFIED_HEADERS,
      });
      expect(res.statusCode).toBe(204);
      const setCookies = res.headers['set-cookie'];
      const cookies = Array.isArray(setCookies) ? setCookies : [setCookies as string];
      const cleared = cookies.find((c) => c.startsWith('aiq_sess='));
      expect(cleared).toBeDefined();
      // Cleared cookie has Max-Age=0 or Expires in the past.
      expect(cleared!).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    });
  });

  // ─── Whoami ────────────────────────────────────────────────────────────
  describe('GET /api/auth/whoami', () => {
    it('returns user + tenant + mfaStatus for session-backed admin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/whoami',
        headers: ADMIN_VERIFIED_HEADERS,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { user: { role: string }; mfaStatus: string };
      expect(body.user.role).toBe('admin');
      expect(body.mfaStatus).toBe('verified');
    });

    it('returns 401 when no session and no apiKey', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/auth/whoami' });
      expect(res.statusCode).toBe(401);
    });
  });
});
