/**
 * modules/13-notifications/src/__tests__/email-tenant-logo.test.ts
 *
 * Logo phase L3b: the shared email header renders the tenant logo when given the
 * app's own public logo URL, renders nothing extra otherwise, and the loader turns
 * the tenant logo metadata into a public URL (null on any failure).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildFromHeader } from '../email/from-header.js';

const { getTenantLogoMeta } = vi.hoisted(() => ({ getTenantLogoMeta: vi.fn() }));

vi.mock('@assessiq/core', async () => ({
  ...(await import('@assessiq/core/hash')),
  ...(await import('@assessiq/core/escape')),
  UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, // render.ts needs it (S12 trap: partial core mock)
  config: { NODE_ENV: 'test', ASSESSIQ_BASE_URL: 'https://assessiq.test', EMAIL_FROM: 'AssessIQ <noreply@test.assessiq.com>' },
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
const LOGO_600x200 = { url: URL_OK, width: 600, height: 200 };

describe('email header tenant logo', () => {
  it('renders org logo scaled to 48 px high, org name first, no AssessIQ wordmark in the header', async () => {
    const { renderTemplate } = await import('../email/render.js');
    const { html, text } = renderTemplate('result_released', VARS, { logo: LOGO_600x200 });
    expect(html).toContain(`src="${URL_OK}"`);
    expect(html).toContain('alt="Acme College logo"');
    expect(html).toContain('width="144" height="48"');
    expect(html).not.toContain('via AssessIQ');
    expect(text).not.toContain('tenant-logo');
  });

  it('keeps the old 120x48 box when the stored size is missing', async () => {
    const { renderTemplate } = await import('../email/render.js');
    const html = renderTemplate('result_released', VARS, { logo: { url: URL_OK, width: 0, height: 0 } }).html;
    expect(html).toContain('width="120" height="48"');
    expect(html).toContain('object-fit:contain');
  });

  it('shows the org name text when there is no logo, and no header row without a name', async () => {
    const { renderTemplate } = await import('../email/render.js');
    const named = renderTemplate('result_released', VARS).html;
    expect(named).not.toContain('<img');
    expect(named).toContain('>Acme College</td>');
    const bare = renderTemplate('admin_email_otp', { code: '123456', expires_minutes: 10 }).html;
    expect(bare).not.toContain('border-bottom:1px solid #e4e4e7;background:#ffffff');
  });

  it('drops a data URI, a foreign https URL and a URL with an extra query key', async () => {
    const { renderTemplate } = await import('../email/render.js');
    for (const bad of [
      'data:image/png;base64,AAAA',
      `https://evil.test/api/public/tenant-logo/${TENANT}?v=0123456789ab`,
      `${URL_OK}&x=1`,
      `${URL_OK}" onerror="x`,
    ]) {
      expect(renderTemplate('result_released', VARS, { logo: { ...LOGO_600x200, url: bad } }).html).not.toContain('<img');
    }
  });
});

describe('buildFromHeader', () => {
  it('uses the org name with via AssessIQ and the EMAIL_FROM address', () => {
    expect(buildFromHeader('Acme College')).toEqual({ name: 'Acme College via AssessIQ', address: 'noreply@test.assessiq.com' });
  });

  it('keeps commas, quotes and CR/LF inside one display name', () => {
    expect(buildFromHeader('Acme, "Ltd"\r\nBcc: x@evil.test')).toEqual({
      name: 'Acme, "Ltd" Bcc: x@evil.test via AssessIQ',
      address: 'noreply@test.assessiq.com',
    });
  });

  it('falls back to EMAIL_FROM when there is no org name', () => {
    expect(buildFromHeader(undefined)).toBe('AssessIQ <noreply@test.assessiq.com>');
    expect(buildFromHeader('  \n ')).toBe('AssessIQ <noreply@test.assessiq.com>');
  });
});

describe('loadTenantLogo', () => {
  beforeEach(async () => {
    getTenantLogoMeta.mockReset();
    (await import('../email/tenant-logo.js')).clearTenantLogoCache();
  });

  it('builds the public URL from the stored sha and caches it', async () => {
    getTenantLogoMeta.mockResolvedValue({ sha256: '0123456789abcdef'.repeat(4), width: 600, height: 200 });
    const { loadTenantLogo } = await import('../email/tenant-logo.js');
    expect(await loadTenantLogo(TENANT)).toEqual({ url: URL_OK, width: 600, height: 200 });
    await loadTenantLogo(TENANT);
    expect(getTenantLogoMeta).toHaveBeenCalledTimes(1);
  });

  it('returns null when there is no logo or the read fails', async () => {
    const { loadTenantLogo } = await import('../email/tenant-logo.js');
    getTenantLogoMeta.mockResolvedValueOnce(null);
    expect(await loadTenantLogo('t2')).toBeNull();
    getTenantLogoMeta.mockRejectedValueOnce(new Error('db down'));
    expect(await loadTenantLogo('t3')).toBeNull();
  });

  it('only candidate templates are branded', async () => {
    const { isCandidateBrandedTemplate } = await import('../email/tenant-logo.js');
    expect(isCandidateBrandedTemplate('result_released')).toBe(true);
    expect(isCandidateBrandedTemplate('evaluation_queue_alert')).toBe(false);
    expect(isCandidateBrandedTemplate('invitation_admin')).toBe(false);
  });
});
