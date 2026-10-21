/** Camera line on the invitation and the reminder: shown only when cameraRequired is true. Pure render. */
import { describe, it, expect } from 'vitest';
import { renderTemplate } from '../email/render.js';

const base = {
  candidateName: 'Priya',
  assessmentName: 'SOC L1',
  invitationLink: 'https://assessiq.test/take/abc',
  expiresAt: '2026-11-01T00:00:00.000Z',
  tenantName: 'Wipro',
};
const LINE = 'This test uses your camera.';

describe.each(['invitation_candidate', 'invitation_reminder'] as const)('%s camera line', (name) => {
  it('true shows the line, the readiness text and the take link in html and text', () => {
    const r = renderTemplate(name, { ...base, cameraRequired: true });
    for (const out of [r.html, r.text]) {
      expect(out).toContain(LINE);
      expect(out).toContain('Check your camera early on the readiness page:');
      expect(out).toContain('You will be asked to agree before the test starts.');
    }
    expect(r.html).toContain('href="https://assessiq.test/take/abc"');
    expect(r.text).toContain('https://assessiq.test/take/abc');
  });
  it.each([false, undefined])('%s hides the line', (v) => {
    const r = renderTemplate(name, v === undefined ? base : { ...base, cameraRequired: v });
    expect(r.html).not.toContain('your camera');
    expect(r.text).not.toContain('your camera');
  });
});
