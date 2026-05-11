// AssessIQ — modules/18-certification/src/__tests__/pdf.test.ts
//
// Phase 5 Session 4 — TDD tests for the PDF download endpoint.
//
// Tests (6):
//   1. Happy path — valid cert, owner → 200 application/pdf, counter incremented
//   2. Wrong owner (candidate role, different userId) → 403 Forbidden
//   3. Revoked certificate → 410 Gone
//   4. Tampered HMAC (wrong signed_hash) → 500 Internal Server Error
//   5. Not found (findByCredentialId returns null) → 404 Not Found
//   6. Concurrent requests → pdf_downloads incremented once per request (+2 total)
//
// Strategy: renderCertificatePdf is mocked (returns fake buffer — no Chromium).
// HMAC is real (vi.stubEnv for CERT_SIGNING_SECRET, no crypto mock).
// Repository functions and withTenant are mocked so no Postgres needed.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';

import { CERT_SIGNING_SECRET_ENV, signCertificate } from '../crypto.js';
import type { Certificate } from '../types.js';

// ---------------------------------------------------------------------------
// Module mocks — declared before the SUT imports.
// ---------------------------------------------------------------------------

// renderCertificatePdf: prevent real Chromium launch in unit tests.
vi.mock('../pdf/render.js', () => ({
  renderCertificatePdf: vi.fn(),
}));

// Repository: mock findByCredentialId and incrementCounter; keep other exports.
vi.mock('../repository.js', async () => {
  const actual = await vi.importActual<typeof import('../repository.js')>('../repository.js');
  return {
    ...actual,
    findByCredentialId: vi.fn(),
    incrementCounter: vi.fn().mockResolvedValue(undefined),
  };
});

// Tenancy: withTenant calls the callback with a fake client (no Postgres).
vi.mock('@assessiq/tenancy', () => ({
  withTenant: vi.fn().mockImplementation(
    async <T>(_tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> => fn({} as PoolClient),
  ),
  getPool: vi.fn(),
  closePool: vi.fn(),
  tenantContextMiddleware: vi.fn(() => ({ preHandler: vi.fn(), onResponse: vi.fn() })),
}));

// ---------------------------------------------------------------------------
// SUT imports — AFTER vi.mock so mocks are in place.
// ---------------------------------------------------------------------------

import * as renderModule from '../pdf/render.js';
import * as repo from '../repository.js';
import { withTenant } from '@assessiq/tenancy';
import { registerCertificationRoutes } from '../routes.js';

// ---------------------------------------------------------------------------
// Top-level beforeEach — re-wire mocks that vi.resetAllMocks() would clear.
//
// vi.resetAllMocks() removes mock implementations (not just call history).
// withTenant is used in every route handler; without re-wiring it returns
// undefined, causing cert === undefined (bypasses the null check) and making
// withTenant(...).catch() throw (can't call .catch on undefined).
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(withTenant).mockImplementation(
    async <T>(_tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> => fn({} as PoolClient),
  );
  vi.mocked(repo.incrementCounter).mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Constants + fixture factory
// ---------------------------------------------------------------------------

const TEST_SECRET = 'test-cert-signing-secret-session4-xyz';
const CREDENTIAL_ID = 'AIQ-2026-05-ABCD12';
const CANDIDATE_ID = '44444444-4444-4444-4444-444444444444';
const TENANT_ID = '22222222-2222-2222-2222-222222222222';
const FAKE_PDF_BYTES = Buffer.from('%PDF-1.4 fake-session4');

interface SessionInfo {
  userId: string;
  tenantId: string;
  role: string;
  totpVerified: boolean;
}

const DEFAULT_SESSION: SessionInfo = {
  userId: CANDIDATE_ID,
  tenantId: TENANT_ID,
  role: 'candidate',
  totpVerified: true,
};

function buildCert(overrides: Partial<Certificate> = {}): Certificate {
  const base: Omit<Certificate, 'signed_hash'> = {
    id: '11111111-1111-1111-1111-111111111111',
    tenant_id: TENANT_ID,
    attempt_id: '33333333-3333-3333-3333-333333333333',
    candidate_id: CANDIDATE_ID,
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

  return { ...base, signed_hash } as Certificate;
}

async function buildTestApp(session: SessionInfo = DEFAULT_SESSION): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Fake auth hook that injects the session onto the request,
  // replacing the real authChain() for unit test isolation.
  const injectSession = async (req: FastifyRequest) => {
    (req as unknown as { session: SessionInfo }).session = session;
  };

  await registerCertificationRoutes(app, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    candidateAuth: [injectSession as any],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adminAuth: [injectSession as any],
  });

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// 1. Happy path — valid cert, caller is the owner → 200 + PDF
// ---------------------------------------------------------------------------

describe('GET /api/certificates/:credentialId/pdf — happy path', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.stubEnv(CERT_SIGNING_SECRET_ENV, TEST_SECRET);
    vi.mocked(repo.findByCredentialId).mockResolvedValue(buildCert());
    vi.mocked(renderModule.renderCertificatePdf).mockResolvedValue(FAKE_PDF_BYTES);
    app = await buildTestApp();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
    await app.close();
  });

  it('returns 200 application/pdf and the rendered buffer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/certificates/${CREDENTIAL_ID}/pdf`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toContain(`${CREDENTIAL_ID}.pdf`);
    expect(res.rawPayload).toEqual(FAKE_PDF_BYTES);
  });

  it('increments the pdf_downloads counter exactly once', async () => {
    await app.inject({ method: 'GET', url: `/api/certificates/${CREDENTIAL_ID}/pdf` });

    expect(vi.mocked(repo.incrementCounter)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repo.incrementCounter)).toHaveBeenCalledWith(
      expect.anything(),
      '11111111-1111-1111-1111-111111111111',
      'pdf_downloads',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Wrong owner (candidate viewing another user's cert) → 403
// ---------------------------------------------------------------------------

describe('GET /api/certificates/:credentialId/pdf — wrong owner', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.stubEnv(CERT_SIGNING_SECRET_ENV, TEST_SECRET);
    vi.mocked(repo.findByCredentialId).mockResolvedValue(buildCert());
    app = await buildTestApp({
      userId: 'different-user-00000000-0000-0000-0000-000000000000',
      tenantId: TENANT_ID,
      role: 'candidate',
      totpVerified: true,
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
    await app.close();
  });

  it('returns 403 Forbidden', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/certificates/${CREDENTIAL_ID}/pdf`,
    });

    expect(res.statusCode).toBe(403);
  });

  it('does not render a PDF or increment the counter', async () => {
    await app.inject({ method: 'GET', url: `/api/certificates/${CREDENTIAL_ID}/pdf` });

    expect(vi.mocked(renderModule.renderCertificatePdf)).not.toHaveBeenCalled();
    expect(vi.mocked(repo.incrementCounter)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Revoked certificate → 410 Gone
// ---------------------------------------------------------------------------

describe('GET /api/certificates/:credentialId/pdf — revoked', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.stubEnv(CERT_SIGNING_SECRET_ENV, TEST_SECRET);
    vi.mocked(repo.findByCredentialId).mockResolvedValue(
      buildCert({ revoked_at: '2026-05-12T09:00:00Z', revoke_reason: 'policy violation' }),
    );
    app = await buildTestApp();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
    await app.close();
  });

  it('returns 410 Gone', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/certificates/${CREDENTIAL_ID}/pdf`,
    });

    expect(res.statusCode).toBe(410);
  });

  it('does not render a PDF', async () => {
    await app.inject({ method: 'GET', url: `/api/certificates/${CREDENTIAL_ID}/pdf` });

    expect(vi.mocked(renderModule.renderCertificatePdf)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Tampered HMAC → 500 Internal Server Error
// ---------------------------------------------------------------------------

describe('GET /api/certificates/:credentialId/pdf — tampered HMAC', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.stubEnv(CERT_SIGNING_SECRET_ENV, TEST_SECRET);
    // Wrong hash (64 valid hex chars but not the correct HMAC).
    vi.mocked(repo.findByCredentialId).mockResolvedValue(
      buildCert({ signed_hash: 'b'.repeat(64) }),
    );
    app = await buildTestApp();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
    await app.close();
  });

  it('returns 500 Internal Server Error', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/certificates/${CREDENTIAL_ID}/pdf`,
    });

    expect(res.statusCode).toBe(500);
  });

  it('does not render a PDF for a tampered cert', async () => {
    await app.inject({ method: 'GET', url: `/api/certificates/${CREDENTIAL_ID}/pdf` });

    expect(vi.mocked(renderModule.renderCertificatePdf)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. Not found → 404
// ---------------------------------------------------------------------------

describe('GET /api/certificates/:credentialId/pdf — not found', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.stubEnv(CERT_SIGNING_SECRET_ENV, TEST_SECRET);
    vi.mocked(repo.findByCredentialId).mockResolvedValue(null);
    app = await buildTestApp();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
    await app.close();
  });

  it('returns 404 for an unknown credential_id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/certificates/${CREDENTIAL_ID}/pdf`,
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 404 without touching the DB for a malformed credential_id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/certificates/not-a-valid-id/pdf`,
    });

    expect(res.statusCode).toBe(404);
    expect(vi.mocked(repo.findByCredentialId)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. Concurrent requests → pdf_downloads incremented once per request
// ---------------------------------------------------------------------------

describe('GET /api/certificates/:credentialId/pdf — concurrent counter', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.stubEnv(CERT_SIGNING_SECRET_ENV, TEST_SECRET);
    vi.mocked(repo.findByCredentialId).mockResolvedValue(buildCert());
    vi.mocked(renderModule.renderCertificatePdf).mockResolvedValue(FAKE_PDF_BYTES);
    app = await buildTestApp();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
    await app.close();
  });

  it('increments pdf_downloads once per concurrent request (+2 for two concurrent)', async () => {
    const [res1, res2] = await Promise.all([
      app.inject({ method: 'GET', url: `/api/certificates/${CREDENTIAL_ID}/pdf` }),
      app.inject({ method: 'GET', url: `/api/certificates/${CREDENTIAL_ID}/pdf` }),
    ]);

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    expect(vi.mocked(repo.incrementCounter)).toHaveBeenCalledTimes(2);
  });
});
