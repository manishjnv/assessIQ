/** Z-15 (a): the fragment sign-in link survives rendering in the button (html) and the text body. */
import { describe, it, expect } from 'vitest';
import { renderTemplate } from '../email/render.js';

const link = 'https://assessiq.test/candidate/login/verify#token=' + 'ab'.repeat(32);

describe('result_released sign-in link', () => {
  it('keeps the #token= fragment link in html and txt', () => {
    const r = renderTemplate('result_released', {
      assessmentName: 'SOC Analyst L1',
      tenantName: 'Acme University',
      scoreText: '42 / 60 (70%)',
      resultText: 'Passed' as const,
      portalLink: link,
    });
    // html attribute values are escaped (= becomes &#x3D;), which browsers decode back.
    expect(r.html.replace(/&#x3D;/g, '=')).toContain(link);
    expect(r.text).toContain(link);
    expect(r.html).not.toContain('?token=');
  });
});
