/**
 * origin-csp.test.ts — unit tests for origin-verifier.ts and csp-builder.ts
 *
 * These are pure unit tests with no DB or Redis dependency.
 */
import { describe, it, expect } from 'vitest';
import { buildEmbedCsp } from '../csp-builder.js';

// ---------------------------------------------------------------------------
// buildEmbedCsp
// ---------------------------------------------------------------------------
describe('buildEmbedCsp', () => {
  it('returns frame-ancestors for a valid https origin', () => {
    const csp = buildEmbedCsp(['https://app.example.com']);
    expect(csp).toBe("frame-ancestors https://app.example.com");
  });

  it('includes multiple valid origins', () => {
    const csp = buildEmbedCsp(['https://a.com', 'https://b.com:8443']);
    expect(csp).toContain('https://a.com');
    expect(csp).toContain('https://b.com:8443');
  });

  it("returns frame-ancestors 'none' for empty list", () => {
    const csp = buildEmbedCsp([]);
    expect(csp).toBe("frame-ancestors 'none'");
  });

  it('filters out origins that do not match the allowed scheme+host pattern', () => {
    // javascript: scheme should be filtered
    const csp = buildEmbedCsp(['javascript:alert(1)', 'https://safe.example.com']);
    expect(csp).not.toContain('javascript:');
    expect(csp).toContain('https://safe.example.com');
  });

  it('rejects wildcard * as origin', () => {
    const csp = buildEmbedCsp(['*']);
    // wildcard doesn't match scheme+host regex — filtered out, leaving 'none'
    expect(csp).toBe("frame-ancestors 'none'");
  });

  it('accepts http://localhost:3000 for dev usage', () => {
    const csp = buildEmbedCsp(['http://localhost:3000']);
    expect(csp).toContain('http://localhost:3000');
  });

  it('rejects origins with path components', () => {
    // /path is not part of scheme+host — filtered
    const csp = buildEmbedCsp(['https://app.example.com/embed']);
    expect(csp).toBe("frame-ancestors 'none'");
  });
});
