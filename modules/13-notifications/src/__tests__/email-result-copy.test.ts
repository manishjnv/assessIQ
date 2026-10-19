/**
 * Z-9 / Z-37: plain result email copy, one sign-off on every template, and
 * contrast of the outcome fills. No DB, no mocks: pure render.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { feedbackSentence } from '@assessiq/core/feedback-copy';
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

  it('Z-44: a fail shows the shared feedback sentence for each level, none keeps the old line', () => {
    for (const level of ['right_wrong', 'with_expected_answer', 'with_ai_justification'] as const) {
      const r = renderTemplate('result_released', { ...fail, feedbackLevel: level });
      expect(r.text).toContain(feedbackSentence(level)!);
    }
    const none = renderTemplate('result_released', { ...fail, feedbackLevel: 'none' });
    expect(none.text).toContain('Sign in to see where to improve.');
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

describe('result_released pass mark and share links', () => {
  const cert = 'https://assessiq.test/verify/AIQ-1';
  it('shows a Pass mark row after Score in html and text', () => {
    const r = renderTemplate('result_released', { ...base, passMarkPct: 60 });
    expect(r.text).toContain('Score: 42 / 60 (70%)\nPass mark: 60%\nAssessment:');
    expect(r.html.indexOf('Pass mark')).toBeGreaterThan(r.html.indexOf('Score'));
    expect(r.html.indexOf('Pass mark')).toBeLessThan(r.html.indexOf('Assessment'));
    expect(renderTemplate('result_released', base).text).not.toContain('Pass mark');
  });
  it('no certificate: states the pass-mark rule (fail and pass), hides it without a mark', () => {
    const line = 'You earn a certificate when you pass. The pass mark is 60%.';
    expect(renderTemplate('result_released', { ...fail, passMarkPct: 60 }).text).toContain(line);
    expect(renderTemplate('result_released', { ...base, passMarkPct: 60 }).html).toContain(line);
    expect(renderTemplate('result_released', fail).text).not.toContain('You earn a certificate');
    expect(renderTemplate('result_released', { ...base, passMarkPct: 60, certificateLink: cert }).text).not.toContain(line);
  });
  it('certificate: LinkedIn, X, WhatsApp and copy-link in html and text, encoded', () => {
    const r = renderTemplate('result_released', { ...base, passMarkPct: 60, certificateLink: cert });
    const enc = encodeURIComponent(cert);
    const unesc = (h: string): string => h.replace(/&#x3D;/g, '=').replace(/&amp;/g, '&');
    for (const out of [unesc(r.html), r.text]) {
      expect(out).toContain(`https://www.linkedin.com/sharing/share-offsite/?url=${enc}`);
      expect(out).toContain(`https://twitter.com/intent/tweet?url=${enc}`);
      expect(out).toContain('https://wa.me/?text=');
    }
    expect(r.text).toContain(`Copy link: ${cert}`);
    expect(r.html).toContain(`Copy link: ${cert}`);
  });
  it('a non-https certificate link gets no share links', () => {
    const r = renderTemplate('result_released', { ...base, certificateLink: 'http://assessiq.test/verify/AIQ-1' });
    expect(r.text).not.toContain('LinkedIn');
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

  it('every HTML template whose .txt has the sign-off includes the shared footer that renders it', () => {
    const dir = join(__dirname, '../email/templates');
    const partial = readFileSync(join(__dirname, '../email/partials/email-footer-transactional.html'), 'utf8');
    expect(partial.split('— The AssessIQ team').length - 1).toBe(1);
    const names = readdirSync(dir).filter((f) => f.endsWith('.txt')).map((f) => f.replace(/\.txt$/, ''));
    const signed = names.filter((n) => readFileSync(join(dir, `${n}.txt`), 'utf8').includes('— The AssessIQ team'));
    expect(signed.length).toBe(13);
    for (const n of signed) {
      expect(readFileSync(join(dir, `${n}.html`), 'utf8'), n).toContain('{{> email-footer-transactional');
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
