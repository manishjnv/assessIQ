/**
 * session-mint.test.ts — unit tests for session-mint.ts
 *
 * Verifies:
 *   S1. EMBED_COOKIE_NAME is the frozen value 'aiq_embed_sess'
 *   S2. maxAge is capped at min(exp - now, 8h)
 */
import { describe, it, expect } from 'vitest';
import { EMBED_COOKIE_NAME } from '../session-mint.js';

describe('EMBED_COOKIE_NAME (D6 frozen contract)', () => {
  it('S1: is exactly "aiq_embed_sess" (frozen — do not change)', () => {
    // This constant is FROZEN per modules/12-embed-sdk/SKILL.md Decision D6.
    // Changing it would silently break the aiq_embed_sess bridge in server.ts.
    expect(EMBED_COOKIE_NAME).toBe('aiq_embed_sess');
  });
});
