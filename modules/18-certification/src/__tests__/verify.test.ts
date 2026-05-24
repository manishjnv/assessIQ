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
    // Privacy regression pin (SEO_Strategy §10): verify pages must be noindex —
    // a candidate's name + result must not be bulk-indexed by search engines.
    expect(res.body).toContain('name="robots" content="noindex,follow"');
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
    expect(res.headers['x-robots-tag']).toBe('noindex');
    expect(res.body).toContain('viewBox="0 0 1200 630"');
  });
});

// ---------------------------------------------------------------------------
// 8. OG/Twitter meta tags — Session 7
// ---------------------------------------------------------------------------
//
// Without PUBLIC_BASE_URL the page must still render (meta tags silently
// omitted). With it set, og:image must point at the absolute /og.png URL so
// LinkedIn's crawler can fetch the PNG (LinkedIn rejects SVG previews).

describe('GET /verify/:credentialId — OG meta tags', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.stubEnv(CERT_SIGNING_SECRET_ENV, TEST_SECRET);
    vi.stubEnv('PUBLIC_BASE_URL', 'https://assessiq.automateedge.cloud');
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

  it('emits og:image pointing at the absolute /og.png URL', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/verify/${CREDENTIAL_ID}`,
      headers: { 'x-forwarded-for': '10.0.0.7' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(
      `<meta property="og:image" content="https://assessiq.automateedge.cloud/verify/${CREDENTIAL_ID}/og.png"`,
    );
    expect(res.body).toContain('<meta property="og:image:width" content="1200"');
    expect(res.body).toContain('<meta property="og:image:height" content="630"');
    expect(res.body).toContain('<meta property="og:image:type" content="image/png"');
  });

  it('emits twitter:card=summary_large_image and twitter:image', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/verify/${CREDENTIAL_ID}`,
      headers: { 'x-forwarded-for': '10.0.0.8' },
    });

    expect(res.body).toContain(
      '<meta name="twitter:card" content="summary_large_image"',
    );
    expect(res.body).toContain(
      `<meta name="twitter:image" content="https://assessiq.automateedge.cloud/verify/${CREDENTIAL_ID}/og.png"`,
    );
  });

  it('does NOT crash when PUBLIC_BASE_URL is unset (meta tags omitted)', async () => {
    vi.stubEnv('PUBLIC_BASE_URL', '');

    const res = await app.inject({
      method: 'GET',
      url: `/verify/${CREDENTIAL_ID}`,
      headers: { 'x-forwarded-for': '10.0.0.9' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('og:image');
    // Page still renders the certificate.
    expect(res.body).toContain(CREDENTIAL_ID);
  });
});

// ---------------------------------------------------------------------------
// 9. OG PNG — Session 7 (LinkedIn-compatible)
// ---------------------------------------------------------------------------
//
// LinkedIn's link previewer fetches PNG only (SVG is rejected). The PNG
// endpoint must return image/png with a valid PNG byte stream (8-byte magic
// header: 89 50 4E 47 0D 0A 1A 0A).

describe('GET /verify/:credentialId/og.png — Session 7', () => {
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

  it('returns 200 image/png with a valid PNG byte stream', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/verify/${CREDENTIAL_ID}/og.png`,
      headers: { 'x-forwarded-for': '10.0.0.10' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
    expect(res.headers['cache-control']).toContain('max-age=3600');
    expect(res.headers['x-robots-tag']).toBe('noindex');

    const buf = res.rawPayload;
    expect(buf.length).toBeGreaterThan(0);
    // PNG magic bytes
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
    expect(buf[2]).toBe(0x4e);
    expect(buf[3]).toBe(0x47);
  });

  it('returns 404 for a malformed credential_id (DB never called)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/verify/not-valid-id/og.png`,
      headers: { 'x-forwarded-for': '10.0.0.11' },
    });

    expect(res.statusCode).toBe(404);
    expect(vi.mocked(repo.findByCredentialIdPublic)).not.toHaveBeenCalled();
  });

  it('returns 404 when the credential is not found', async () => {
    vi.mocked(repo.findByCredentialIdPublic).mockResolvedValue(null);

    const res = await app.inject({
      method: 'GET',
      url: `/verify/AIQ-2026-05-NOTFND/og.png`,
      headers: { 'x-forwarded-for': '10.0.0.12' },
    });

    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 10. LinkedIn share button — Session 10
// ---------------------------------------------------------------------------

describe('GET /verify/:credentialId — LinkedIn share button (active cert)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.stubEnv(CERT_SIGNING_SECRET_ENV, TEST_SECRET);
    vi.stubEnv('PUBLIC_BASE_URL', 'https://assessiq.automateedge.cloud');
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

  it('renders the LinkedIn share link for an active cert', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/verify/${CREDENTIAL_ID}`,
      headers: { 'x-forwarded-for': '10.0.1.1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('share-linkedin');
    expect(res.body).toContain('linkedin.com/sharing/share-offsite');
    expect(res.body).not.toContain('<button disabled');
  });

  it('share href contains the encoded verify URL as the url= param', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/verify/${CREDENTIAL_ID}`,
      headers: { 'x-forwarded-for': '10.0.1.2' },
    });

    const expectedEncoded = encodeURIComponent(
      `https://assessiq.automateedge.cloud/verify/${CREDENTIAL_ID}`,
    );
    expect(res.body).toContain(expectedEncoded);
  });

  it('sets target=_blank and rel=noopener noreferrer on the share link', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/verify/${CREDENTIAL_ID}`,
      headers: { 'x-forwarded-for': '10.0.1.3' },
    });

    expect(res.body).toContain('target="_blank"');
    expect(res.body).toContain('rel="noopener noreferrer"');
  });
});

describe('GET /verify/:credentialId — LinkedIn share button (revoked cert)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.stubEnv(CERT_SIGNING_SECRET_ENV, TEST_SECRET);
    vi.stubEnv('PUBLIC_BASE_URL', 'https://assessiq.automateedge.cloud');
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

  it('renders a disabled LinkedIn button with tooltip for a revoked cert', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/verify/${CREDENTIAL_ID}`,
      headers: { 'x-forwarded-for': '10.0.1.4' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('share-linkedin--disabled');
    expect(res.body).toContain('disabled');
    expect(res.body).toContain('Revoked certificates');
    // No href on a disabled button
    expect(res.body).not.toContain('href=');
  });
});

describe('GET /verify/:credentialId — LinkedIn share button (tampered cert)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.stubEnv(CERT_SIGNING_SECRET_ENV, TEST_SECRET);
    vi.stubEnv('PUBLIC_BASE_URL', 'https://assessiq.automateedge.cloud');
    vi.mocked(repo.withPublicVerifyContext).mockImplementation(async (fn) =>
      fn({} as PoolClient),
    );
    vi.mocked(repo.findByCredentialIdPublic).mockResolvedValue(
      buildCert({ signed_hash: 'a'.repeat(64) }),
    );
    app = await buildTestApp();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
    await app.close();
  });

  it('omits the LinkedIn button for a tampered cert', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/verify/${CREDENTIAL_ID}`,
      headers: { 'x-forwarded-for': '10.0.1.5' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('linkedin.com/sharing');
    expect(res.body).not.toContain('<a') ; // no anchor element for tampered
  });
});

describe('GET /verify/:credentialId — LinkedIn share button (no PUBLIC_BASE_URL)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.stubEnv(CERT_SIGNING_SECRET_ENV, TEST_SECRET);
    vi.stubEnv('PUBLIC_BASE_URL', '');
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

  it('omits the LinkedIn button when PUBLIC_BASE_URL is unset', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/verify/${CREDENTIAL_ID}`,
      headers: { 'x-forwarded-for': '10.0.1.6' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('linkedin.com/sharing');
    // Page still renders the cert fields
    expect(res.body).toContain(CREDENTIAL_ID);
  });
});
