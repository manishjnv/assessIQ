// EXP-9 A5: Hindi text on the certificate. Fake fixtures only.
import { describe, expect, it } from 'vitest';

import { renderCertificateHtml } from '../pdf/template.js';
import type { Certificate } from '../types.js';

function html(display_name: string, course_title: string, org?: string): string {
  const cert = {
    tier: 'completion',
    display_name,
    course_title,
    level: 'L1',
    credential_id: 'AIQ-2026-05-ABCD12',
    issued_at: '2026-05-11T12:00:00Z',
    revoked_at: null,
  } as unknown as Certificate;
  return renderCertificateHtml(cert, 'data:image/png;base64,AAAA', 'https://assessiq.in/verify/x', org);
}

describe('certificate font stacks (EXP-9 A5)', () => {
  it('names Noto Sans Devanagari in the serif and sans stacks and keeps the Hindi text', () => {
    const out = html('नमूना विद्यार्थी', 'प्रमाणपत्र', 'श्री क्षत्रिय');
    expect(out).toContain("font-family: Newsreader, Georgia, 'Times New Roman', 'Noto Sans Devanagari', serif;");
    expect(out).toContain("font-family: Geist, Helvetica, Arial, 'Noto Sans Devanagari', sans-serif;");
    expect(out).toContain('नमूना विद्यार्थी');
    expect(out).toContain('श्री क्षत्रिय');
  });

  it('English-only output differs only in the font-family strings', () => {
    const out = html('Jane Smith', 'AI Fundamentals', 'Acme Ltd');
    expect(out.replaceAll(", 'Noto Sans Devanagari'", '')).toContain('font-family: Newsreader, Georgia');
    expect(out).toContain('Jane Smith');
  });
});
