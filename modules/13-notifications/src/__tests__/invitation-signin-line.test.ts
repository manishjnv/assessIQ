/** UAT 2026-10-29 (Option A): the invitation carries the org code and a sign-in link with ?tenant=. Pure render. */
import { describe, it, expect } from 'vitest';
import { config } from '@assessiq/core';
import { renderTemplate } from '../email/render.js';

const base = {
  candidateName: 'Priya',
  assessmentName: 'SOC L1',
  invitationLink: 'https://assessiq.test/take/abc',
  expiresAt: 'Thu, 05 Nov 2026 16:14:36 GMT',
  tenantName: 'Wipro',
};

describe('invitation_candidate sign-in line', () => {
  it('with an org code: html and text carry the code and the ?tenant= link', () => {
    const r = renderTemplate('invitation_candidate', base, { orgCode: 'flux-point' });
    const link = new URL('/candidate/login?tenant=flux-point', config.ASSESSIQ_BASE_URL).toString();
    expect(r.html).toContain(`href="${link}"`);
    expect(r.html).toContain('Your organisation code:');
    expect(r.html).toContain('<strong style="color:#18181b">flux-point</strong>');
    expect(r.text).toContain(`See your results any time: ${link}`);
    expect(r.text).toContain('Your organisation code: flux-point');
  });

  it('without an org code: no sign-in line at all', () => {
    const r = renderTemplate('invitation_candidate', base);
    expect(r.html).not.toContain('Your organisation code');
    expect(r.text).not.toContain('Your organisation code');
    expect(r.html).not.toContain('/candidate/login');
  });

  it('the reminder does not get the line', () => {
    const r = renderTemplate('invitation_reminder', base, { orgCode: 'flux-point' });
    expect(r.html).not.toContain('Your organisation code');
  });
});
