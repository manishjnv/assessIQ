import { describe, expect, it } from 'vitest';
import { assertTryHead, renderTryHtml } from './tryHead';

import index from '../../index.html?raw';

describe('/try prerendered head (Z-32)', () => {
  it('renders title, description, canonical and og tags into the static html', () => {
    const html = renderTryHtml(index);
    expect(() => assertTryHead(html)).not.toThrow();
    expect(html).toContain('<div id="root">');
  });
  it('the shared index.html fails the check', () => {
    expect(() => assertTryHead(index)).toThrow(/\/try head check failed/);
  });
});
