import { describe, expect, it } from 'vitest';
import { TRY_DESCRIPTION, TRY_TITLE, assertTryHead, renderTryHtml } from './tryHead';

import index from '../../index.html?raw';

describe('/try prerendered head (Z-32)', () => {
  it('renders title, description, canonical and og tags into the static html', () => {
    const html = renderTryHtml(index);
    expect(() => assertTryHead(html)).not.toThrow();
    expect(html).toContain('<div id="root">');
  });
  it('describes the free tests (Mock and Real), not the old sample assessment, within 50-160 chars', () => {
    expect(TRY_TITLE).toMatch(/Mock or Real/);
    expect(TRY_DESCRIPTION).not.toMatch(/sample assessment|nothing is stored/i);
    expect(TRY_DESCRIPTION.length).toBeGreaterThanOrEqual(50);
    expect(TRY_DESCRIPTION.length).toBeLessThanOrEqual(160);
  });
  it('the shared index.html fails the check', () => {
    expect(() => assertTryHead(index)).toThrow(/\/try head check failed/);
  });
});
