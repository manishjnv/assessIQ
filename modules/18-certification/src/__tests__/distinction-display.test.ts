// AssessIQ — modules/18-certification/src/__tests__/distinction-display.test.ts
//
// Z-50: the organisation switch decides if the word "Distinction" is shown.
// The stored tier (and the HMAC over it) never changes. Checks the PDF route,
// the public verify page, the OG share preview and the candidate list.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';

import { CERT_SIGNING_SECRET_ENV, signCertificate } from '../crypto.js';
import type { Certificate } from '../types.js';

const { showDistinction, renderPdf } = vi.hoisted(() => ({
  showDistinction: vi.fn(),
  renderPdf: vi.fn(),
}));

vi.mock('../pdf/render.js', () => ({ renderCertificatePdf: (...a: unknown[]) => renderPdf(...a) }));

vi.mock('../repository.js', async () => {
  const actual = await vi.importActual<typeof import('../repository.js')>('../repository.js');
  return {
    ...actual,
    withPublicVerifyContext: vi.fn(),
    findByCredentialIdPublic: vi.fn(),
    findByCredentialId: vi.fn(),
    listCertificates: vi.fn(),
    incrementCounter: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@assessiq/tenancy', () => ({
  withTenant: vi.fn().mockImplementation(
    async (_tenantId: string, fn: (c: unknown) => Promise<unknown>) =>
      fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
  ),
  getTenantById: vi.fn().mockResolvedValue({ name: 'Acme College' }),
  getTenantLogoBytes: vi.fn().mockResolvedValue(null),
  getCertificateShowDistinction: (...a: unknown[]) => showDistinction(...a),
  getPool: vi.fn(),
  closePool: vi.fn(),
  tenantContextMiddleware: vi.fn(() => ({ preHandler: vi.fn(), onResponse: vi.fn() })),
}));

import * as repo from '../repository.js';
import { registerVerifyRoutes } from '../routes-public.js';
import { registerCertificationRoutes } from '../routes.js';
import { listForUser } from '../service.js';
import { applyDistinctionSetting } from '../display.js';

const SECRET = 'test-cert-signing-secret-z50';
const CREDENTIAL_ID = 'AIQ-2026-05-ABCD12';
const CANDIDATE_ID = '44444444-4444-4444-4444-444444444444';
const TENANT_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_TENANT_ID = '99999999-9999-9999-9999-999999999999';

function buildCert(tier: Certificate['tier'], tenantId = TENANT_ID): Certificate {
  const base = {
    id: '11111111-1111-1111-1111-111111111111',
    tenant_id: tenantId,
    attempt_id: '33333333-3333-3333-3333-333333333333',
    candidate_id: CANDIDATE_ID,
    template_key: 'default',
    credential_id: CREDENTIAL_ID,
    tier,
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
  };
  const signed_hash = signCertificate(
    {
      id: base.id, tenant_id: base.tenant_id, attempt_id: base.attempt_id, candidate_id: base.candidate_id,
      template_key: base.template_key, credential_id: base.credential_id, tier: base.tier,
      display_name: base.display_name, course_title: base.course_title, level: base.level, issued_at: base.issued_at,
    },
    SECRET,
  );
  return { ...base, signed_hash };
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.stubEnv(CERT_SIGNING_SECRET_ENV, SECRET);
  vi.stubEnv('PUBLIC_BASE_URL', 'https://assessiq.test');
  showDistinction.mockReset();
  renderPdf.mockReset().mockResolvedValue(Buffer.from('%PDF-1.4 z50'));
  vi.mocked(repo.withPublicVerifyContext).mockImplementation(async (fn) => fn({} as PoolClient));
  app = Fastify({ logger: false, trustProxy: true });
  const injectSession = async (req: FastifyRequest) => {
    (req as unknown as { session: unknown }).session = {
      userId: CANDIDATE_ID, tenantId: TENANT_ID, role: 'candidate', totpVerified: true,
    };
  };
  await registerVerifyRoutes(app);
  await registerCertificationRoutes(app, { candidateAuth: [injectSession], adminAuth: [injectSession] });
  await app.ready();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await app.close();
});

const verify = (suffix = '') =>
  app.inject({ method: 'GET', url: `/verify/${CREDENTIAL_ID}${suffix}`, headers: { 'x-forwarded-for': '10.0.0.8' } });

describe('Z-50 distinction wording follows the organisation switch', () => {
  it('applyDistinctionSetting only maps distinction, and never mutates the input', () => {
    const d = buildCert('distinction');
    expect(applyDistinctionSetting(d, false).tier).toBe('completion');
    expect(applyDistinctionSetting(d, true).tier).toBe('distinction');
    expect(applyDistinctionSetting(buildCert('completion'), false).tier).toBe('completion');
    expect(d.tier).toBe('distinction');
  });

  it('verify page: switch OFF hides Distinction, signature still verifies (stored tier unchanged)', async () => {
    vi.mocked(repo.findByCredentialIdPublic).mockResolvedValue(buildCert('distinction'));
    showDistinction.mockResolvedValue(false);
    const res = await verify();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Verified');
    expect(res.body).not.toContain('Invalid Signature');
    expect(res.body.toLowerCase()).not.toContain('distinction');
    expect(res.body).toContain('Verified completion credential');
    expect(showDistinction).toHaveBeenCalledWith(TENANT_ID);
  });

  it('verify page: switch ON shows Distinction in the field, JSON-LD and share preview text', async () => {
    vi.mocked(repo.findByCredentialIdPublic).mockResolvedValue(buildCert('distinction'));
    showDistinction.mockResolvedValue(true);
    const res = await verify();
    expect(res.body).toContain('<p class="value">distinction</p>');
    expect(res.body).toContain('"credentialCategory":"distinction"');
    expect(res.body).toContain('Verified distinction credential');
  });

  it('share preview image (og.svg) follows the switch', async () => {
    vi.mocked(repo.findByCredentialIdPublic).mockResolvedValue(buildCert('distinction'));
    showDistinction.mockResolvedValue(false);
    expect((await verify('/og.svg')).body).not.toContain('distinction');
    showDistinction.mockResolvedValue(true);
    expect((await verify('/og.svg')).body).toContain('L1 · distinction');
  });

  it('a completion certificate never reads the setting', async () => {
    vi.mocked(repo.findByCredentialIdPublic).mockResolvedValue(buildCert('completion'));
    const res = await verify();
    expect(res.statusCode).toBe(200);
    expect(showDistinction).not.toHaveBeenCalled();
  });

  it('tenant isolation: the setting is read for the certificate tenant only', async () => {
    vi.mocked(repo.findByCredentialIdPublic).mockResolvedValue(buildCert('distinction', OTHER_TENANT_ID));
    showDistinction.mockImplementation(async (t: string) => t === TENANT_ID);
    const res = await verify();
    expect(res.body.toLowerCase()).not.toContain('distinction');
    expect(showDistinction).toHaveBeenCalledTimes(1);
    expect(showDistinction).toHaveBeenCalledWith(OTHER_TENANT_ID);
  });

  it('PDF route: renders the display tier, switch OFF then ON', async () => {
    vi.mocked(repo.findByCredentialId).mockResolvedValue(buildCert('distinction'));
    showDistinction.mockResolvedValue(false);
    const off = await app.inject({ method: 'GET', url: `/api/certificates/${CREDENTIAL_ID}/pdf` });
    expect(off.statusCode).toBe(200);
    expect(renderPdf.mock.calls[0]![0]).toMatchObject({ tier: 'completion' });

    showDistinction.mockResolvedValue(true);
    await app.inject({ method: 'GET', url: `/api/certificates/${CREDENTIAL_ID}/pdf` });
    expect(renderPdf.mock.calls[1]![0]).toMatchObject({ tier: 'distinction' });
  });

  it('candidate list: tier follows the switch, signature check uses the stored tier', async () => {
    vi.mocked(repo.listCertificates).mockResolvedValue({ items: [buildCert('distinction')], total: 1 } as never);
    showDistinction.mockResolvedValue(false);
    const off = await listForUser(TENANT_ID, CANDIDATE_ID);
    expect(off.certificates[0]).toMatchObject({ tier: 'completion', signed_hash_valid: true });
    showDistinction.mockResolvedValue(true);
    const on = await listForUser(TENANT_ID, CANDIDATE_ID);
    expect(on.certificates[0]).toMatchObject({ tier: 'distinction', signed_hash_valid: true });
  });
});
