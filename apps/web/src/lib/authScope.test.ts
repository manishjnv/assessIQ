/**
 * Unit tests for the Phase D auth-scope helper (apps/web/src/lib/authScope.ts).
 * Pure logic — single-shot read+clear, scope parsing, audience-tuned copy.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readAuthScopeOnce, authScopeCopy } from './authScope';

beforeEach(() => {
  sessionStorage.clear();
});

describe('readAuthScopeOnce', () => {
  it('returns the stashed scope AND clears the key (single-shot)', () => {
    sessionStorage.setItem('aiq.lastAuthScope', JSON.stringify({ scope: 'tenant' }));
    expect(readAuthScopeOnce()).toBe('tenant');
    expect(sessionStorage.getItem('aiq.lastAuthScope')).toBeNull();
    // A second read finds nothing — the banner shows exactly once.
    expect(readAuthScopeOnce()).toBeNull();
  });

  it('reads the "user" scope', () => {
    sessionStorage.setItem('aiq.lastAuthScope', JSON.stringify({ scope: 'user' }));
    expect(readAuthScopeOnce()).toBe('user');
  });

  it('returns null when nothing is stashed', () => {
    expect(readAuthScopeOnce()).toBeNull();
  });

  it('returns null (and clears) on an unrecognised scope', () => {
    sessionStorage.setItem('aiq.lastAuthScope', JSON.stringify({ scope: 'bogus' }));
    expect(readAuthScopeOnce()).toBeNull();
    expect(sessionStorage.getItem('aiq.lastAuthScope')).toBeNull();
  });

  it('returns null on malformed JSON (never throws)', () => {
    sessionStorage.setItem('aiq.lastAuthScope', 'not-json{');
    expect(readAuthScopeOnce()).toBeNull();
  });
});

describe('authScopeCopy', () => {
  it('admin tenant copy is operator-facing', () => {
    const c = authScopeCopy('tenant', 'admin');
    expect(c.title).toBe("Your organisation's access is paused.");
    expect(c.body).toMatch(/administrator/i);
  });

  it('candidate tenant copy points at the assessment administrator', () => {
    const c = authScopeCopy('tenant', 'candidate');
    expect(c.title).toBe("Your organisation's access is paused.");
    expect(c.body).toMatch(/assessment administrator/i);
  });

  it('admin user copy = account disabled', () => {
    expect(authScopeCopy('user', 'admin').title).toBe('Your account has been disabled.');
  });

  it('candidate user copy = access removed (calmer)', () => {
    expect(authScopeCopy('user', 'candidate').title).toBe('Your access has been removed.');
  });
});
