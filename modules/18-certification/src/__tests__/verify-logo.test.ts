// AssessIQ — modules/18-certification/src/__tests__/verify-logo.test.ts
//
// Logo phases L3c/L4: tenant logo on the public verify page (80x32 next to the
// organisation name), the OG SVG/PNG (240x96 top-right) and the certificate PDF
// template (18 mm high, top-left). Logo absent = the pages render as before.
// Bytes are read server-side via getTenantLogoBytes, after the certificate row
// is loaded.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';

import { CERT_SIGNING_SECRET_ENV, signCertificate } from '../crypto.js';
import type { Certificate } from '../types.js';

const { getTenantLogoBytes, getTenantLogoMeta } = vi.hoisted(() => ({
  getTenantLogoBytes: vi.fn(),
  getTenantLogoMeta: vi.fn(),
}));

vi.mock('../repository.js', async () => {
  const actual = await vi.importActual<typeof import('../repository.js')>('../repository.js');
  return {
    ...actual,
    withPublicVerifyContext: vi.fn(),
    findByCredentialIdPublic: vi.fn(),
    incrementCounter: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@assessiq/tenancy', () => ({
  withTenant: vi.fn().mockImplementation(
    async (_tenantId: string, fn: (c: unknown) => Promise<unknown>) =>
      fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
  ),
  getTenantById: vi.fn().mockResolvedValue({ name: 'Acme College' }),
  getTenantLogoBytes: (...a: unknown[]) => getTenantLogoBytes(...a),
  getTenantLogoMeta: (...a: unknown[]) => getTenantLogoMeta(...a),
  tenantLogoUrl: (id: string, sha: string) => `/api/public/tenant-logo/${id}?v=${sha.slice(0, 12)}`,
  getPool: vi.fn(),
  closePool: vi.fn(),
  tenantContextMiddleware: vi.fn(() => ({ preHandler: vi.fn(), onResponse: vi.fn() })),
}));

import * as repo from '../repository.js';
import { registerVerifyRoutes } from '../routes-public.js';
import { renderCertificateHtml } from '../pdf/template.js';

const TEST_SECRET = 'test-cert-signing-secret-logo-abc';
const CREDENTIAL_ID = 'AIQ-2026-05-ABCD12';
// 1x1 transparent PNG.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAd3zAAAAAAElFTkSuQmCC',
  'base64',
);
const DATA_URI = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;

function buildCert(): Certificate {
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
  };
  const signed_hash = signCertificate(
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

let app: FastifyInstance;

beforeEach(async () => {
  vi.stubEnv(CERT_SIGNING_SECRET_ENV, TEST_SECRET);
  vi.mocked(repo.withPublicVerifyContext).mockImplementation(async (fn) => fn({} as PoolClient));
  vi.mocked(repo.findByCredentialIdPublic).mockResolvedValue(buildCert());
  app = Fastify({ logger: false, trustProxy: true });
  await registerVerifyRoutes(app);
  await app.ready();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  getTenantLogoBytes.mockReset();
  getTenantLogoMeta.mockReset();
  await app.close();
});

const get = (url: string) =>
  app.inject({ method: 'GET', url, headers: { 'x-forwarded-for': '10.0.0.7' } });

describe('verify page logo', () => {
  it('links the cached public logo URL (no data URI) next to the organisation name', async () => {
    getTenantLogoMeta.mockResolvedValue({ sha256: 'abcdef0123456789', width: 600, height: 200 });
    const res = await get(`/verify/${CREDENTIAL_ID}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('src="/api/public/tenant-logo/22222222-2222-2222-2222-222222222222?v=abcdef012345"');
    expect(res.body).not.toContain('data:image');
    expect(res.body).toContain('alt="Acme College logo"');
    expect(res.body).toContain('width="80" height="32"');
    expect(res.body).toContain('Acme College &middot; via AssessIQ');
    expect(res.body).toContain('"issuedBy":{"@type":"Organization","name":"Acme College"}');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(getTenantLogoMeta).toHaveBeenCalledWith('22222222-2222-2222-2222-222222222222');
  });

  it('shows the name only when the tenant has no logo', async () => {
    getTenantLogoMeta.mockResolvedValue(null);
    const res = await get(`/verify/${CREDENTIAL_ID}`);
    expect(res.body).not.toContain('<img');
    expect(res.body).toContain('Acme College &middot; via AssessIQ');
  });

  it('still renders when the logo read fails', async () => {
    getTenantLogoMeta.mockRejectedValue(new Error('db down'));
    const res = await get(`/verify/${CREDENTIAL_ID}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('<img');
  });
});

describe('OG image logo', () => {
  it('SVG embeds the logo as a data URI image in a 240x96 plate at top-right', async () => {
    getTenantLogoBytes.mockResolvedValue({ mime: 'image/png', bytes: PNG_BYTES, sha256: 'x' });
    const res = await get(`/verify/${CREDENTIAL_ID}/og.svg`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`<image x="908" y="68" width="224" height="80"`);
    expect(res.body).toContain(`href="${DATA_URI}"`);
    expect(res.body).toContain('<rect x="900" y="60" width="240" height="96"');
  });

  it('SVG shows the organisation name text', async () => {
    getTenantLogoBytes.mockResolvedValue(null);
    const res = await get(`/verify/${CREDENTIAL_ID}/og.svg`);
    expect(res.body).toContain('>Acme College</text>');
  });

  it('SVG has no <image> without a logo', async () => {
    getTenantLogoBytes.mockResolvedValue(null);
    const res = await get(`/verify/${CREDENTIAL_ID}/og.svg`);
    expect(res.body).not.toContain('<image');
  });

  it('PNG still rasterises with a logo embedded', async () => {
    getTenantLogoBytes.mockResolvedValue({ mime: 'image/png', bytes: PNG_BYTES, sha256: 'x' });
    const res = await get(`/verify/${CREDENTIAL_ID}/og.png`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload.subarray(0, 4).toString('hex')).toBe('89504e47');
  });
});

describe('certificate PDF template logo', () => {
  const QR = 'data:image/png;base64,AAAA';
  const URL_ = 'https://assessiq.test/verify/AIQ-2026-05-ABCD12';

  it('embeds the data URI logo, 18 mm high top-left', () => {
    const html = renderCertificateHtml(buildCert(), QR, URL_, 'Acme College', DATA_URI);
    expect(html).toContain(`<img class="tenant-logo" src="${DATA_URI}"`);
    expect(html).toContain('height: 18mm');
    expect(html).toContain('Issued via AssessIQ');
  });

  it('has no tenant logo without one, or with an unsafe value', () => {
    expect(renderCertificateHtml(buildCert(), QR, URL_, 'Acme College')).not.toContain('<img class="tenant-logo"');
    expect(
      renderCertificateHtml(buildCert(), QR, URL_, 'Acme College', 'data:image/svg+xml;base64,AAAA'),
    ).not.toContain('<img class="tenant-logo"');
  });

  it('has no signature rule, but still shows the issuer name under the footer', () => {
    const html = renderCertificateHtml(buildCert(), QR, URL_, 'Acme College');
    expect(html).not.toContain('sign-line');
    expect(html).toContain('<div class="sign-label">Acme College</div>');
    expect(html).toContain('Issued via AssessIQ');
  });
});
