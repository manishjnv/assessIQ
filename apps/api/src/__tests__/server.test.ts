import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Mock @assessiq/users before importing server (module is resolved at import
// time; vi.mock is hoisted to the top of the module by Vitest).
// ---------------------------------------------------------------------------
vi.mock('@assessiq/users', () => ({
  listUsers: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 }),
  getUser: vi.fn().mockResolvedValue({ id: 'u_1', email: 'test@example.com' }),
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
    // Throw NotFoundError for any token starting with 'bogus' (test discriminator).
    if (token.startsWith('bogus')) {
      throw new NotFoundError('invitation not found', {
        details: { code: 'INVITATION_NOT_FOUND' },
      });
    }
    return {
      user: { id: 'u_1', email: 'test@example.com' },
      sessionToken: 'sess_abc123',
      expiresAt: '2026-05-01T16:00:00.000Z',
    };
  }),
  bulkImport: vi.fn(),
}));

// Mock @assessiq/tenancy so tests don't need a live DB
vi.mock('@assessiq/tenancy', () => ({
  tenantContextMiddleware: () => ({
    preHandler: vi.fn().mockResolvedValue(undefined),
    onResponse: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { buildServer } from '../server.js';

const ADMIN_HEADERS = {
  'x-aiq-test-tenant': 't_test',
  'x-aiq-test-user-id': 'u_admin',
  'x-aiq-test-user-role': 'admin',
};

const REVIEWER_HEADERS = {
  'x-aiq-test-tenant': 't_test',
  'x-aiq-test-user-id': 'u_reviewer',
  'x-aiq-test-user-role': 'reviewer',
};

describe('AssessIQ API server', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
  });

  afterAll(async () => {
    await app.close();
  });

  // 1. Health check — no auth required
  it('GET /api/health returns { status: "ok" } without auth headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  // 2. Admin users — missing dev-auth headers → 401
  it('GET /api/admin/users without dev-auth headers returns 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/users' });
    expect(res.statusCode).toBe(401);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('AUTHN_FAILED');
  });

  // 3. Admin users — reviewer role → 403
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
  // No request body needed; the route returns 501 unconditionally.
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

  // 5. Accept invitation — well-formed but unknown token → 404 with INVITATION_NOT_FOUND.
  // Token must satisfy the schema (>= 43 chars) so the handler reaches acceptInvitation;
  // the mocked acceptInvitation throws NotFoundError for any token starting with 'bogus'.
  it('POST /api/invitations/accept with bogus token returns 404', async () => {
    // 43-char placeholder that passes schema validation.
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
