/**
 * modules/13-notifications/src/__tests__/email-tenant-logo.test.ts
 *
 * Logo phase L3b: the shared email header renders the tenant logo when given the
 * app's own public logo URL, renders nothing extra otherwise, and the loader turns
 * the tenant logo metadata into a public URL (null on any failure).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getTenantLogoMeta } = vi.hoisted(() => ({ getTenantLogoMeta: vi.fn() }));

vi.mock('@assessiq/core', async () => ({
  ...(await import('@assessiq/core/hash')),
  ...(await import('@assessiq/core/escape')),
  UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, // render.ts needs it (S12 trap: partial core mock)
  config: { NODE_ENV: 'test', ASSESSIQ_BASE_URL: 'https://assessiq.test' },
  streamLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@assessiq/tenancy', () => ({
  getTenantLogoMeta: (...a: unknown[]) => getTenantLogoMeta(...a),
  tenantLogoUrl: (id: string, sha: string) => `/api/public/tenant-logo/${id}?v=${sha.slice(0, 12)}`,
}));

const VARS = {
  candidateName: 'Asha',
  assessmentName: 'SOC L1',
  tenantName: 'Acme College',
  scoreText: '8 / 10 (80%)',
  resultText: 'Passed',
  portalLink: 'https://assessiq.test/candidate/login?tenant=acme',
};
const TENANT = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const URL_OK = `https://assessiq.test/api/public/tenant-logo/${TENANT}?v=0123456789ab`;

describe('email header tenant logo', () => {
  it('renders the public logo URL, alt text and via AssessIQ caption', async () => {
    const { renderTemplate } = await import('../email/render.js');
    const { html, text } = renderTemplate('result_released', VARS, { logoUrl: URL_OK });
    expect(html).toContain(`src="${URL_OK}"`);
    expect(html).toContain('alt="Acme College logo"');
    expect(html).toContain('via AssessIQ');
    expect(text).not.toContain('tenant-logo');
  });

  it('renders no <img> when there is no logo', async () => {
    const { renderTemplate } = await import('../email/render.js');
    expect(renderTemplate('result_released', VARS).html).not.toContain('<img');
    expect(renderTemplate('result_released', VARS, { logoUrl: null }).html).not.toContain('<img');
  });

  it('drops a data URI, a foreign https URL and a URL with an extra query key', async () => {
    const { renderTemplate } = await import('../email/render.js');
    for (const bad of [
      'data:image/png;base64,AAAA',
      `https://evil.test/api/public/tenant-logo/${TENANT}?v=0123456789ab`,
      `${URL_OK}&x=1`,
      `${URL_OK}" onerror="x`,
    ]) {
      expect(renderTemplate('result_released', VARS, { logoUrl: bad }).html).not.toContain('<img');
    }
  });
});

describe('loadTenantLogoUrl', () => {
  beforeEach(async () => {
    getTenantLogoMeta.mockReset();
    (await import('../email/tenant-logo.js')).clearTenantLogoCache();
  });

  it('builds the public URL from the stored sha and caches it', async () => {
    getTenantLogoMeta.mockResolvedValue({ sha256: '0123456789abcdef'.repeat(4) });
    const { loadTenantLogoUrl } = await import('../email/tenant-logo.js');
    expect(await loadTenantLogoUrl(TENANT)).toBe(URL_OK);
    await loadTenantLogoUrl(TENANT);
    expect(getTenantLogoMeta).toHaveBeenCalledTimes(1);
  });

  it('returns null when there is no logo or the read fails', async () => {
    const { loadTenantLogoUrl } = await import('../email/tenant-logo.js');
    getTenantLogoMeta.mockResolvedValueOnce(null);
    expect(await loadTenantLogoUrl('t2')).toBeNull();
    getTenantLogoMeta.mockRejectedValueOnce(new Error('db down'));
    expect(await loadTenantLogoUrl('t3')).toBeNull();
  });

  it('only candidate templates are branded', async () => {
    const { isCandidateBrandedTemplate } = await import('../email/tenant-logo.js');
    expect(isCandidateBrandedTemplate('result_released')).toBe(true);
    expect(isCandidateBrandedTemplate('evaluation_queue_alert')).toBe(false);
    expect(isCandidateBrandedTemplate('invitation_admin')).toBe(false);
  });
});
