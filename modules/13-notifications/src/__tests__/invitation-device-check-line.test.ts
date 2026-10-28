/** Z-154: the invitation carries one line that links to the public device check (/check). Pure render. */
import { describe, it, expect } from 'vitest';
import { config } from '@assessiq/core';
import { renderTemplate } from '../email/render.js';

const base = {
  candidateName: 'Priya',
  assessmentName: 'SOC L1',
  invitationLink: 'https://assessiq.test/take/abc',
  expiresAt: '2026-11-01T00:00:00.000Z',
  tenantName: 'Wipro',
};
const LINE = 'Test your device before the exam:';

describe('invitation_candidate device check line', () => {
  it('html and text both carry the line and the /check link', () => {
    const r = renderTemplate('invitation_candidate', base);
    const link = new URL('/check', config.ASSESSIQ_BASE_URL).toString();
    expect(r.html).toContain(LINE);
    expect(r.text).toContain(`${LINE} ${link}`);
    expect(r.html).toContain(`href="${link}"`);
    expect(r.html).toContain('target="_blank"');
  });

  it('UAT 2026-10-29: Test your device is a button and comes before the Start your assessment button', () => {
    const r = renderTemplate('invitation_candidate', base);
    const device = r.html.indexOf('>Test your device<');
    const start = r.html.indexOf('Start your assessment');
    expect(device).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(device);
    expect(r.text.indexOf('/check')).toBeLessThan(r.text.indexOf('Start your assessment:'));
  });

  it('the device check line shows with and without the camera line', () => {
    const r = renderTemplate('invitation_candidate', { ...base, cameraRequired: true });
    expect(r.html).toContain(LINE);
    expect(r.text).toContain(LINE);
  });
});
