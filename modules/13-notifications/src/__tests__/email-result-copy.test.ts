/**
 * Z-9 / Z-37: plain result email copy, one sign-off on every template, and
 * contrast of the outcome fills. No DB, no mocks: pure render.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderTemplate, OUTCOME_COLORS } from '../email/render.js';

const base = {
  candidateName: 'Priya Sharma',
  assessmentName: 'SOC Analyst L1',
  tenantName: 'Acme University',
  scoreText: '42 / 60 (70%)',
  resultText: 'Passed' as const,
  portalLink: 'https://assessiq.test/candidate/login?tenant=acme',
};
const fail = { ...base, resultText: 'Not passed' as const, scoreText: '20 / 60 (33.3%)' };

describe('result_released copy', () => {
  it('pass: subject says passed, outcome row first, then Score, Assessment, Organisation', () => {
    const r = renderTemplate('result_released', base);
    expect(r.subject).toBe('Your result for SOC Analyst L1: passed');
    expect(r.text).toContain('Well done, Priya Sharma. Acme University has released your result. You passed.');
    const i = (s: string): number => r.text.indexOf(s);
    expect(i('Result:')).toBeLessThan(i('Score:'));
    expect(i('Score:')).toBeLessThan(i('Assessment:'));
    expect(i('Assessment:')).toBeLessThan(i('Organisation:'));
    expect(r.html).toContain(`border-left:4px solid ${OUTCOME_COLORS.pass.bar}`);
    expect(r.html).toContain(OUTCOME_COLORS.pass.bg);
  });

  it('fail: neutral subject, plain lede, amber bar, never red or the pass-mark number', () => {
    const r = renderTemplate('result_released', fail);
    expect(r.subject).toBe('Your result for SOC Analyst L1');
    expect(r.text).toContain('Hi Priya Sharma. Your result for SOC Analyst L1 is ready. You did not reach the pass mark.');
    expect(r.text).toContain('Sign in to see where to improve.');
    expect(r.html).toContain(`border-left:4px solid ${OUTCOME_COLORS.fail.bar}`);
    expect(r.html).toContain('Not passed');
    expect(r.html.toLowerCase()).not.toMatch(/#dc2626|#ef4444|danger/);
  });

  it('no name: greeting is "Hello,"', () => {
    const { candidateName: _n, ...noName } = base;
    const r = renderTemplate('result_released', noName);
    expect(r.text.startsWith('Hello,')).toBe(true);
    expect(r.text).toContain('Well done. Acme University has released your result.');
    expect(r.text).not.toContain('Hi there');
  });

  it('certificate: link and next-step line only when one exists', () => {
    const w = renderTemplate('result_released', { ...base, certificateLink: 'https://assessiq.test/verify/AIQ-1' });
    expect(w.text).toContain('Your certificate is ready. Select the second link to view it.');
    expect(w.text).toContain('https://assessiq.test/verify/AIQ-1');
    const wo = renderTemplate('result_released', base);
    expect(wo.text).toContain('Your result and details are on your Results page.');
  });

  it('candidate text never uses banned words', () => {
    for (const v of [base, fail, { ...base, certificateLink: 'https://assessiq.test/verify/AIQ-1' }]) {
      const r = renderTemplate('result_released', v);
      expect(`${r.subject}\n${r.text}`.replace(/https?:\S+/g, '')).not.toMatch(/\b(token|magic link|company|test|exam)\b/i);
    }
  });
});

describe('invitation_candidate copy', () => {
  it('uses the organisation in the subject and active voice', () => {
    const r = renderTemplate('invitation_candidate', {
      candidateName: 'Priya',
      assessmentName: 'SOC L1',
      invitationLink: 'https://assessiq.test/i/abc',
      expiresAt: '2026-11-01T00:00:00.000Z',
      tenantName: 'Wipro',
    });
    expect(r.subject).toBe('Wipro invites you to take SOC L1');
    expect(r.text).toContain('Wipro invites you to take SOC L1.');
    expect(r.text).toContain('Start before 2026-11-01T00:00:00.000Z. After that the invitation stops working.');
    expect(r.text).not.toContain('has been invited');
  });
});

describe('sign-off', () => {
  it('every .txt template ends its body with the single sign-off line', () => {
    const dir = join(__dirname, '../email/templates');
    const files = readdirSync(dir).filter((f) => f.endsWith('.txt'));
    expect(files.length).toBe(13);
    for (const f of files) {
      const t = readFileSync(join(dir, f), 'utf8').replaceAll('\r\n', '\n');
      expect(t, f).toContain('\n— The AssessIQ team\n');
      expect(t, f).not.toMatch(/^Thanks,/m);
    }
  });
});

// WCAG 2.x relative luminance contrast.
function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('outcome fills contrast', () => {
  it('dark text (#0a0a0b) is at least 4.5:1 on both soft fills', () => {
    expect(ratio('#0a0a0b', OUTCOME_COLORS.pass.bg)).toBeGreaterThanOrEqual(4.5);
    expect(ratio('#0a0a0b', OUTCOME_COLORS.fail.bg)).toBeGreaterThanOrEqual(4.5);
  });
});
