// AssessIQ — modules/18-certification/src/__tests__/verify.test.ts
//
// Phase 5 Session 3 — TDD RED tests for the public verify page.
//
// Tests (7):
//   1. Valid signature + non-revoked → 200, green badge HTML + JSON-LD
//   2. Tampered signature            → 200, tampered badge HTML
//   3. Revoked credential            → 200, revoked badge HTML
//   4. Unknown credential_id         → 404, friendly HTML page
//   5. Malformed credential_id       → 404, DB never called
//   6. Rate limit 61st request       → 429
//   7. OG image                      → 200, image/svg+xml, viewBox 1200×630
//
// Strategy: real HMAC (vi.stubEnv for CERT_SIGNING_SECRET, no crypto mock),
// mocked repository (withPublicVerifyContext + findByCredentialIdPublic), no
// real Postgres. Each describe creates a fresh Fastify app so in-memory rate
// limiter state is isolated per test.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';

import { CERT_SIGNING_SECRET_ENV, signCertificate } from '../crypto.js';
import type { Certificate } from '../types.js';

// ---------------------------------------------------------------------------
// Module mocks — declared before the SUT import.
// withPublicVerifyContext is in repository.js (Session 3 addition).
// incrementCounter is mocked so fire-and-forget counter bumps don't throw.
// ---------------------------------------------------------------------------

vi.mock('../repository.js', async () => {
  const actual = await vi.importActual<typeof import('../repository.js')>('../repository.js');
  return {
    ...actual,
    withPublicVerifyContext: vi.fn(),
    findByCredentialIdPublic: vi.fn(),
    incrementCounter: vi.fn().mockResolvedValue(undefined),
  };
});

// withTenant is used for the fire-and-forget verification_views counter bump.
vi.mock('@assessiq/tenancy', () => ({
  withTenant: vi.fn().mockImplementation(
    async (_tenantId: string, fn: (c: unknown) => Promise<unknown>) => fn({}),
  ),
  getPool: vi.fn(),
  closePool: vi.fn(),
  tenantContextMiddleware: vi.fn(() => ({
    preHandler: vi.fn(),
    onResponse: vi.fn(),
  })),
}));

// SUT imports — AFTER vi.mock so the mocks are in place.
import * as repo from '../repository.js';
import { registerVerifyRoutes } from '../routes-public.js';

// ---------------------------------------------------------------------------
// Constants + fixture factory
// ---------------------------------------------------------------------------

const TEST_SECRET = 'test-cert-signing-secret-session3-abc';
const CREDENTIAL_ID = 'AIQ-2026-05-ABCD12';

function buildCert(overrides: Partial<Certificate> = {}): Certificate {
  const base = {
    id: '11111111-1111-1111-1111-111111111111',
    tenant_id: '22222222-2222-2222-2222-222222222222',
    attempt_id: '33333333-3333-3333-3333-333333333333',
    candidate_id: '44444444-4444-4444-4444-444444444444',
    template_key: 'default',
    credential_id: CREDENTIAL_ID,
    tier: 'completion' as const,
    display_name: 'Jane Smith',
    course_title: 'AI Fundamentals',
    level: 'L1',
    issued_at: '2026-05-11T12:00:00Z',
    revoked_at: null as string | null,
    revoke_reason: null as string | null,
    pdf_downloads: 0,
    linkedin_shares: 0,
    verification_views: 5,
    created_at: '2026-05-11T12:00:00Z',
    updated_at: '2026-05-11T12:00:00Z',
    ...overrides,
  };

  // Compute fresh HMAC unless the caller explicitly supplies signed_hash.
  const signed_hash =
    overrides.signed_hash !== undefined
      ? overrides.signed_hash
      : signCertificate(
          {
            id: base.id,
            tenant_id: base.tenant_id,
            attempt_id: base.attempt_id,
            candidate_id: base.candidate_id,
            template_key: base.template_key,
            credential_id: base.credential_id,
            tier: base.tier,
            display_name: base.display_name,
            course_title: base.course_title,
            level: base.level,
            issued_at: base.issued_at,
          },
          TEST_SECRET,
        );

  return { ...base, signed_hash };
}

async function buildTestApp(): Promise<FastifyInstance> {
  // trustProxy: true so req.ip uses X-Forwarded-For (needed for rate limiting).
  const app = Fastify({ logger: false, trustProxy: true });
  await registerVerifyRoutes(app);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// 1. Valid signature + non-revoked → 200, green badge HTML + JSON-LD
// ---------------------------------------------------------------------------

describe('GET /verify/:credentialId — valid cert', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.stubEnv(CERT_SIGNING_SECRET_ENV, TEST_SECRET);
    vi.mocked(repo.withPublicVerifyContext).mockImplementation(async (fn) =>
      fn({} as PoolClient),
    );
    vi.mocked(repo.findByCredentialIdPublic).mockResolvedValue(buildCert());
    app = await buildTestApp();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
    await app.close();
  });

  it('returns 200 HTML with valid-state badge and JSON-LD credential schema', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/verify/${CREDENTIAL_ID}`,
      headers: { 'x-forwarded-for': '10.0.0.1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('cert-status--valid');
    expect(res.body).toContain(CREDENTIAL_ID);
    expect(res.body).toContain('EducationalOccupationalCredential');
  });
});

// ---------------------------------------------------------------------------
// 2. Tampered signature → 200, tampered badge
// ---------------------------------------------------------------------------

describe('GET /verify/:credentialId — tampered signature', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.stubEnv(CERT_SIGNING_SECRET_ENV, TEST_SECRET);
    // 64 hex chars but wrong value → timingSafeEqual returns false
    const tamperedCert = buildCert({ signed_hash: 'a'.repeat(64) });
    vi.mocked(repo.withPublicVerifyContext).mockImplementation(async (fn) =>
      fn({} as PoolClient),
    );
    vi.mocked(repo.findByCredentialIdPublic).mockResolvedValue(tamperedCert);
    app = await buildTestApp();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
    await app.close();
  });

  it('returns 200 HTML with tampered-state badge', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/verify/${CREDENTIAL_ID}`,
      headers: { 'x-forwarded-for': '10.0.0.2' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('cert-status--tampered');
  });
});

// ---------------------------------------------------------------------------
// 3. Revoked credential → 200, revoked badge
// ---------------------------------------------------------------------------

describe('GET /verify/:credentialId — revoked cert', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.stubEnv(CERT_SIGNING_SECRET_ENV, TEST_SECRET);
    const revokedCert = buildCert({
      revoked_at: '2026-05-12T09:00:00Z',
      revoke_reason: 'policy violation',
    });
    vi.mocked(repo.withPublicVerifyContext).mockImplementation(async (fn) =>
      fn({} as PoolClient),
    );
    vi.mocked(repo.findByCredentialIdPublic).mockResolvedValue(revokedCert);
    app = await buildTestApp();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
    await app.close();
  });

  it('returns 200 HTML with revoked-state badge', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/verify/${CREDENTIAL_ID}`,
      headers: { 'x-forwarded-for': '10.0.0.3' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('cert-status--revoked');
  });
});

// ---------------------------------------------------------------------------
// 4. Unknown credential_id → 404, friendly HTML page
// ---------------------------------------------------------------------------

describe('GET /verify/:credentialId — not found', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.stubEnv(CERT_SIGNING_SECRET_ENV, TEST_SECRET);
    vi.mocked(repo.withPublicVerifyContext).mockImplementation(async (fn) =>
      fn({} as PoolClient),
    );
    vi.mocked(repo.findByCredentialIdPublic).mockResolvedValue(null);
    app = await buildTestApp();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
    await app.close();
  });

  it('returns 404 with a friendly HTML page (not a JSON error body)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/verify/AIQ-2026-05-XXXXXX`,
      headers: { 'x-forwarded-for': '10.0.0.4' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('<!DOCTYPE html>');
  });
});

// ---------------------------------------------------------------------------
// 5. Malformed credential_id → 404, DB never called
// ---------------------------------------------------------------------------

describe('GET /verify/:credentialId — malformed credential_id', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.stubEnv(CERT_SIGNING_SECRET_ENV, TEST_SECRET);
    vi.mocked(repo.withPublicVerifyContext).mockImplementation(async (fn) =>
      fn({} as PoolClient),
    );
    app = await buildTestApp();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
    await app.close();
  });

  it('returns 404 without touching the DB for a credential_id that fails the regex', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/verify/not-valid-id`,
      headers: { 'x-forwarded-for': '10.0.0.5' },
    });

    expect(res.statusCode).toBe(404);
    expect(vi.mocked(repo.findByCredentialIdPublic)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. Rate limit — 61st request from same IP → 429
// ---------------------------------------------------------------------------

describe('GET /verify/:credentialId — rate limit', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.stubEnv(CERT_SIGNING_SECRET_ENV, TEST_SECRET);
    vi.mocked(repo.withPublicVerifyContext).mockImplementation(async (fn) =>
      fn({} as PoolClient),
    );
    vi.mocked(repo.findByCredentialIdPublic).mockResolvedValue(buildCert());
    app = await buildTestApp();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
    await app.close();
  });

  it('allows 60 requests per hour then returns 429 on the 61st from the same IP', async () => {
    const ip = '203.0.113.99'; // TEST-NET-3 — unambiguously a test IP

    for (let i = 0; i < 60; i++) {
      const res = await app.inject({
        method: 'GET',
        url: `/verify/${CREDENTIAL_ID}`,
        headers: { 'x-forwarded-for': ip },
      });
      expect(res.statusCode).toBe(200);
    }

    const blocked = await app.inject({
      method: 'GET',
      url: `/verify/${CREDENTIAL_ID}`,
      headers: { 'x-forwarded-for': ip },
    });
    expect(blocked.statusCode).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// 7. OG image — 200 + image/svg+xml + 1200×630 viewBox
// ---------------------------------------------------------------------------

describe('GET /verify/:credentialId/og.svg — OG image', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.stubEnv(CERT_SIGNING_SECRET_ENV, TEST_SECRET);
    vi.mocked(repo.withPublicVerifyContext).mockImplementation(async (fn) =>
      fn({} as PoolClient),
    );
    vi.mocked(repo.findByCredentialIdPublic).mockResolvedValue(buildCert());
    app = await buildTestApp();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
    await app.close();
  });

  it('returns 200 image/svg+xml with a 1200×630 viewBox', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/verify/${CREDENTIAL_ID}/og.svg`,
      headers: { 'x-forwarded-for': '10.0.0.6' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/svg\+xml/);
    expect(res.body).toContain('viewBox="0 0 1200 630"');
  });
});
