// Z-189: the printed issued date is the Indian calendar day, not the server (UTC) day.
import { describe, expect, it } from 'vitest';

import { renderCertificateHtml } from '../pdf/template.js';
import type { Certificate } from '../types.js';

function html(issued_at: string): string {
  const cert = {
    tier: 'completion',
    display_name: 'Jane Smith',
    course_title: 'AI Fundamentals',
    level: 'L1',
    credential_id: 'AIQ-2026-05-ABCD12',
    issued_at,
    revoked_at: null,
  } as unknown as Certificate;
  return renderCertificateHtml(cert, 'data:image/png;base64,AAAA', 'https://assessiq.in/verify/x');
}

describe('certificate PDF issued date (Z-189)', () => {
  it('shows the next Indian day when the UTC instant is late evening', () => {
    // 2026-11-01 20:00 UTC is 2026-11-02 01:30 IST.
    expect(html('2026-11-01T20:00:00Z')).toContain('Issued <b>November 2, 2026</b>');
  });

  it('keeps the same day when UTC and India share the date', () => {
    expect(html('2026-05-11T12:00:00Z')).toContain('Issued <b>May 11, 2026</b>');
  });
});
