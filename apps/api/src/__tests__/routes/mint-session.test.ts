// AssessIQ — apps/api/src/__tests__/routes/mint-session.test.ts
//
// Unit tests for POST /api/dev/mint-session.
//
// KEY ASSERTIONS:
//   (a) Route is NOT registered when ENABLE_E2E_TEST_MINTER is false/absent.
//   (b) Route IS registered and returns 200 + sets aiq_sess cookie when the
//       flag is true.
//   (c) Returns 400 on invalid email or unknown role.
//   (d) Returns 401 when tenantSlug does not resolve.
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any AI SDK.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Mocks — hoisted
// ---------------------------------------------------------------------------

vi.mock('@assessiq/auth', () => {
  const passthrough = (): unknown => async () => undefined;

  const sessionLoaderMiddleware = (_opts?: unknown) => async (req: any) => {
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

  const requireAuth = (opts: any = {}) => async (req: any) => {
    const { AuthnError, AuthzError } = await import('@assessiq/core');
    if (req.session === undefined && req.apiKey === undefined) throw new AuthnError('required');
    if (req.session !== undefined) {
      if (Array.isArray(opts.roles) && !opts.roles.includes(req.session.role))
        throw new AuthzError('not authorized');
    }
  };

  return {
    rateLimitMiddleware: () => passthrough(),
    sessionLoaderMiddleware,
    apiKeyAuthMiddleware: () => async () => undefined,
    requireAuth,
    requireRole: () => passthrough(),
    requireFreshMfa: () => passthrough(),
    requireScope: () => passthrough(),
    cookieParserMiddleware: passthrough(),
    requestIdMiddleware: passthrough(),
    extendOnPassMiddleware: () => passthrough(),
    extractClientIp: () => 'test-ip',
    parseCookieHeader: () => ({}),
    mintCandidateSession: vi.fn(),
    sessions: {
      create: vi.fn().mockResolvedValue({
        id: 'sess-uuid',
        token: 'test-token-abc123',
        expiresAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
      }),
      get: vi.fn(),
      refresh: vi.fn(),
      markTotpVerified: vi.fn(),
      destroy: vi.fn(),
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
      authenticate: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      revoke: vi.fn(),
      list: vi.fn(),
    },
    startGoogleSso: vi.fn(),
    handleGoogleCallback: vi.fn(),
    normalizeEmail: vi.fn(),
    mintEmbedToken: vi.fn(),
    verifyEmbedToken: vi.fn(),
    createEmbedSecret: vi.fn(),
    rotateEmbedSecret: vi.fn(),
    listEmbedSecrets: vi.fn(),
    isIdleExpired: vi.fn(),
    setRedisForTesting: vi.fn(),
    closeRedis: vi.fn(),
  };
});

vi.mock('@assessiq/tenancy', () => {
  const mockGetPool = () => ({
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
        // BEGIN / COMMIT / ROLLBACK
        if (typeof sql === 'string' && /^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(sql)) {
          return { rows: [] };
        }
        // users SELECT — return mock user
        if (typeof sql === 'string' && sql.includes('FROM users')) {
          return { rows: [{ id: 'user-uuid-1', role: 'admin' }] };
        }
        // INSERT INTO users
        if (typeof sql === 'string' && sql.includes('INSERT INTO users')) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    }),
  });

  return {
    getPool: mockGetPool,
    withTenant: vi.fn().mockImplementation(async (_tenantId: string, fn: (c: any) => Promise<any>) => {
      return fn({ query: vi.fn().mockResolvedValue({ rows: [] }) });
    }),
    tenantContextMiddleware: () => ({
      preHandler: async () => undefined,
      onResponse: async () => undefined,
    }),
    getTenantBySlug: vi.fn().mockImplementation(async (slug: string) => {
      if (slug === 'wipro-soc') {
        return { id: 'tenant-uuid-1', name: 'Wipro SOC', slug: 'wipro-soc' };
      }
      return null;
    }),
    setPoolForTesting: vi.fn(),
  };
});

vi.mock('@assessiq/audit-log', () => ({
  audit: vi.fn().mockResolvedValue(undefined),
}));

// Mock all other heavy modules that buildServer imports.
vi.mock('@assessiq/question-bank', () => ({
  registerQuestionBankRoutes: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@assessiq/assessment-lifecycle', () => ({
  registerAssessmentLifecycleRoutes: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@assessiq/attempt-engine', () => ({
  registerAttemptCandidateRoutes: vi.fn().mockResolvedValue(undefined),
  registerAttemptTakeRoutes: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@assessiq/ai-grading', () => ({
  registerGradingRoutes: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@assessiq/help-system', () => ({
  registerHelpPublicRoutes: vi.fn().mockResolvedValue(undefined),
  registerHelpAuthRoutes: vi.fn().mockResolvedValue(undefined),
  registerHelpAdminRoutes: vi.fn().mockResolvedValue(undefined),
  registerHelpTrackRoutes: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@assessiq/notifications', () => ({
  registerNotificationsRoutes: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@assessiq/scoring', () => ({
  registerScoringRoutes: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@assessiq/analytics', () => ({
  registerAnalyticsRoutes: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@assessiq/embed-sdk', () => ({
  EMBED_COOKIE_NAME: 'aiq_embed_sess',
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/dev/mint-session', () => {
  describe('when ENABLE_E2E_TEST_MINTER is false (default)', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      // Ensure the flag is off for this suite.
      process.env['ENABLE_E2E_TEST_MINTER'] = 'false';
      // Import after setting the env var so config picks it up.
      const { buildServer } = await import('../../server.js');
      app = await buildServer();
    });

    afterAll(async () => {
      await app.close();
      delete process.env['ENABLE_E2E_TEST_MINTER'];
    });

    it('returns 404 — route is not registered', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/dev/mint-session',
        payload: { email: 'test@example.com', role: 'admin', tenantSlug: 'wipro-soc' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('when ENABLE_E2E_TEST_MINTER is true', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      process.env['ENABLE_E2E_TEST_MINTER'] = 'true';
      // Re-import buildServer so config re-evaluates. vitest module isolation
      // requires clearing the module cache between suites.
      vi.resetModules();

      // Re-apply mocks after resetModules.
      vi.mock('@assessiq/auth', () => {
        const passthrough = (): unknown => async () => undefined;
        const sessionLoaderMiddleware = (_opts?: unknown) => async () => undefined;
        const requireAuth = () => async () => undefined;
        return {
          rateLimitMiddleware: () => passthrough(),
          sessionLoaderMiddleware,
          apiKeyAuthMiddleware: () => async () => undefined,
          requireAuth,
          requireRole: () => passthrough(),
          requireFreshMfa: () => passthrough(),
          requireScope: () => passthrough(),
          cookieParserMiddleware: passthrough(),
          requestIdMiddleware: passthrough(),
          extendOnPassMiddleware: () => passthrough(),
          extractClientIp: () => 'test-ip',
          parseCookieHeader: () => ({}),
          mintCandidateSession: vi.fn(),
          sessions: {
            create: vi.fn().mockResolvedValue({
              id: 'sess-uuid-2',
              token: 'cookie-token-xyz',
              expiresAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
            }),
            get: vi.fn(),
            refresh: vi.fn(),
            markTotpVerified: vi.fn(),
            destroy: vi.fn(),
            destroyAllForUser: vi.fn(),
          },
          totp: { enrollStart: vi.fn(), enrollConfirm: vi.fn(), verify: vi.fn(), consumeRecovery: vi.fn(), regenerateRecoveryCodes: vi.fn() },
          apiKeys: { authenticate: vi.fn().mockResolvedValue(null), create: vi.fn(), revoke: vi.fn(), list: vi.fn() },
          startGoogleSso: vi.fn(), handleGoogleCallback: vi.fn(), normalizeEmail: vi.fn(),
          mintEmbedToken: vi.fn(), verifyEmbedToken: vi.fn(), createEmbedSecret: vi.fn(), rotateEmbedSecret: vi.fn(), listEmbedSecrets: vi.fn(),
          isIdleExpired: vi.fn(), setRedisForTesting: vi.fn(), closeRedis: vi.fn(),
        };
      });

      const { buildServer } = await import('../../server.js');
      app = await buildServer();
    });

    afterAll(async () => {
      await app.close();
      delete process.env['ENABLE_E2E_TEST_MINTER'];
    });

    it('returns 200 + sets aiq_sess cookie for a valid admin request', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/dev/mint-session',
        payload: { email: 'test@wipro.com', role: 'admin', tenantSlug: 'wipro-soc' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ sessionId: string; userId: string; expiresAt: string }>();
      expect(typeof body.sessionId).toBe('string');
      expect(typeof body.userId).toBe('string');
      const cookie = res.cookies.find((c) => c.name === 'aiq_sess');
      expect(cookie).toBeDefined();
    });

    it('returns 400 for an invalid email format', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/dev/mint-session',
        payload: { email: 'not-an-email', role: 'admin', tenantSlug: 'wipro-soc' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 401 for an unknown tenantSlug', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/dev/mint-session',
        payload: { email: 'test@wipro.com', role: 'admin', tenantSlug: 'unknown-tenant' },
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
