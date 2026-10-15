/**
 * RW-91: totp_reset_notice template render + sender vars. No DB, no SMTP.
 */
import { describe, it, expect } from 'vitest';
import { renderTemplate } from '../email/render.js';

const base = { recipientName: 'Asha', resetAt: 'Fri, 16 Oct 2026 10:00:00 GMT', resetBy: 'an administrator' };

describe('totp_reset_notice', () => {
  it('renders the subject, who (role), when and next step in both variants', () => {
    const r = renderTemplate('totp_reset_notice', base);
    expect(r.subject).toBe('Your two-factor sign-in was reset');
    for (const body of [r.html, r.text]) {
      expect(body).toContain('Asha');
      expect(body).toContain('an administrator');
      expect(body).toContain('16 Oct 2026 10:00:00 GMT');
      expect(body).toContain('set up two-factor again');
      expect(body).not.toContain('{{');
    }
  });

  it('rejects empty vars (closed schema)', () => {
    expect(() => renderTemplate('totp_reset_notice', { ...base, resetBy: '' })).toThrow();
    expect(() => renderTemplate('totp_reset_notice', { recipientName: 'A', resetAt: 'x' } as never)).toThrow();
  });
});
