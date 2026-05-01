import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Mocks — must precede `import { buildServer }` (vi.mock is hoisted by vitest).
// Mirrors the pattern in routes/auth.test.ts: replace @assessiq/auth middleware
// factories with passthrough hooks that synthesize req.session from
// x-test-session-* headers, and stub library functions with vi.fn().
// ---------------------------------------------------------------------------
vi.mock('@assessiq/auth', () => {
  const passthrough = (): unknown => async (_req: unknown, _reply: unknown) => {
    // no-op
  };

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

  const apiKeyAuthMiddleware = async () => {
    // no-op for these tests
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
    }
  };

  return {
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
      revoke: vi.fn(),
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
    setRedisForTesting: vi.fn(),
    closeRedis: vi.fn().mockResolvedValue(undefined),
  };
});

// @assessiq/users — surface admin-users handlers' deps.
vi.mock('@assessiq/users', () => ({
  listUsers: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 }),
  getUser: vi.fn().mockResolvedValue({ id: 'u_1', email: 'test@example.com', name: 'Test', tenantId: 't_test', role: 'admin', status: 'active' }),
  createUser: vi.fn().mockResolvedValue({ id: 'u_1', email: 'test@example.com' }),
  updateUser: vi.fn().mockResolvedValue({ id: 'u_1', email: 'test@example.com' }),
  softDelete: vi.fn().mockResolvedValue(undefined),
  restore: vi.fn().mockResolvedValue({ id: 'u_1', email: 'test@example.com' }),
  inviteUser: vi.fn().mockResolvedValue({
    user: { id: 'u_1', email: 'test@example.com' },
    invitation: { id: 'inv_1', email: 'test@example.com', role: 'admin', expires_at: '2026-05-08T00:00:00.000Z' },
  }),
  acceptInvitation: vi.fn().mockImplementation(async (token: string) => {
    const { NotFoundError } = await import('@assessiq/core');
    if (token.startsWith('bogus')) {
      throw new NotFoundError('invitation not found', { details: { code: 'INVITATION_NOT_FOUND' } });
    }
    return {
      user: { id: 'u_1', email: 'test@example.com' },
      sessionToken: 'sess_abc123',
      expiresAt: '2026-05-01T16:00:00.000Z',
    };
  }),
  bulkImport: vi.fn(),
}));

vi.mock('@assessiq/tenancy', () => ({
  tenantContextMiddleware: () => ({
    preHandler: vi.fn().mockResolvedValue(undefined),
    onResponse: vi.fn().mockResolvedValue(undefined),
  }),
  getTenantBySlug: vi.fn().mockResolvedValue(null),
  getTenantById: vi.fn().mockResolvedValue(null),
  withTenant: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
  setPoolForTesting: vi.fn(),
  updateTenantSettings: vi.fn(),
  suspendTenant: vi.fn(),
}));

import { buildServer } from '../server.js';

const ADMIN_HEADERS = {
  'x-test-session-tenant': 't_test',
  'x-test-session-user': 'u_admin',
  'x-test-session-role': 'admin',
  'x-test-session-totp-verified': 'true',
};

const REVIEWER_HEADERS = {
  ...ADMIN_HEADERS,
  'x-test-session-role': 'reviewer',
};

describe('AssessIQ API server', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
  });

  afterAll(async () => {
    await app.close();
  });

  // 1. Health check — no auth required (skipAuth: true).
  it('GET /api/health returns { status: "ok" } without auth headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  // 2. Admin users — missing session → 401 AUTHN_FAILED.
  it('GET /api/admin/users without session returns 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/users' });
    expect(res.statusCode).toBe(401);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('AUTHN_FAILED');
  });

  // 3. Admin users — reviewer role → 403 AUTHZ_FAILED.
  it('GET /api/admin/users with reviewer role returns 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: REVIEWER_HEADERS,
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('AUTHZ_FAILED');
  });

  // 4. Bulk import stub — admin auth → 501 + correct code.
  it('POST /api/admin/users/import with admin auth returns 501 + BULK_IMPORT_PHASE_1', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/users/import',
      headers: ADMIN_HEADERS,
    });
    expect(res.statusCode).toBe(501);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('BULK_IMPORT_PHASE_1');
  });

  // 5. Accept invitation — bogus token → 404.
  it('POST /api/invitations/accept with bogus token returns 404', async () => {
    const bogus = 'bogus-token-' + 'x'.repeat(43 - 'bogus-token-'.length);
    const res = await app.inject({
      method: 'POST',
      url: '/api/invitations/accept',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ token: bogus }),
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  // DB-dependent tests — require testcontainers (Phase 1)
  it.todo('GET /api/admin/users — returns paginated users from live DB');
  it.todo('POST /api/admin/users — creates user and returns 201');
  it.todo('PATCH /api/admin/users/:id — updates user role');
  it.todo('DELETE /api/admin/users/:id — soft deletes and returns 204');
  it.todo('POST /api/admin/users/:id/restore — restores deleted user');
  it.todo('POST /api/admin/invitations — sends invitation email via 13-notifications stub');
  it.todo('POST /api/invitations/accept — mints session and sets cookie');
});
