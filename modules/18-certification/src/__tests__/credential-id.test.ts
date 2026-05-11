// AssessIQ — modules/18-certification/src/__tests__/credential-id.test.ts
//
// Phase 5 Session 2 — unit tests for credential_id generation.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CREDENTIAL_PREFIX,
  generateCredentialId,
  isValidCredentialId,
} from '../credential-id.js';

describe('DEFAULT_CREDENTIAL_PREFIX', () => {
  it('is "AIQ"', () => {
    expect(DEFAULT_CREDENTIAL_PREFIX).toBe('AIQ');
  });
});

describe('generateCredentialId — format', () => {
  it('every ID in a batch of 50 matches the regex', () => {
    for (let i = 0; i < 50; i++) {
      const id = generateCredentialId();
      expect(isValidCredentialId(id), `iteration ${i}: ${id}`).toBe(true);
    }
  });

  it('honours an explicit prefix', () => {
    for (const prefix of ['AB', 'XYZ', 'WXYZ']) {
      const id = generateCredentialId(prefix);
      expect(id.startsWith(`${prefix}-`)).toBe(true);
      expect(isValidCredentialId(id)).toBe(true);
    }
  });

  it('throws on a prefix that is not 2-4 uppercase letters', () => {
    expect(() => generateCredentialId('A')).toThrow();
    expect(() => generateCredentialId('ABCDE')).toThrow();
    expect(() => generateCredentialId('abc')).toThrow();
    expect(() => generateCredentialId('A1B')).toThrow();
    expect(() => generateCredentialId('')).toThrow();
  });
});

describe('generateCredentialId — year/month encoding', () => {
  it('encodes 2026-01 correctly', () => {
    const id = generateCredentialId('AIQ', new Date(Date.UTC(2026, 0, 15)));
    expect(id.slice(0, 'AIQ-2026-01-'.length)).toBe('AIQ-2026-01-');
  });

  it('encodes 2026-12 correctly', () => {
    const id = generateCredentialId('AIQ', new Date(Date.UTC(2026, 11, 31)));
    expect(id.slice(0, 'AIQ-2026-12-'.length)).toBe('AIQ-2026-12-');
  });

  it('zero-pads single-digit months', () => {
    const id = generateCredentialId('AIQ', new Date(Date.UTC(2026, 2, 1))); // March
    expect(id.slice(0, 'AIQ-2026-03-'.length)).toBe('AIQ-2026-03-');
  });

  it('uses UTC, not local time', () => {
    // 2026-01-01 00:00 UTC === 2025-12-31 in many western zones.
    const id = generateCredentialId('AIQ', new Date(Date.UTC(2026, 0, 1, 0, 0, 0)));
    expect(id.slice(0, 'AIQ-2026-01-'.length)).toBe('AIQ-2026-01-');
  });
});

describe('generateCredentialId — uniqueness', () => {
  it('produces 1000 distinct IDs in a single batch (CSPRNG sanity)', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateCredentialId());
    }
    expect(ids.size).toBe(1000);
  });
});

describe('isValidCredentialId', () => {
  it('matches valid IDs', () => {
    expect(isValidCredentialId('AIQ-2026-05-A7F3K9')).toBe(true);
    expect(isValidCredentialId('AB-2025-12-ABCDEF')).toBe(true);
    expect(isValidCredentialId('ABCD-2026-01-000000')).toBe(true);
  });

  it('rejects shape violations', () => {
    expect(isValidCredentialId('aiq-2026-05-A7F3K9')).toBe(false); // lowercase prefix
    expect(isValidCredentialId('AIQ-2026-5-A7F3K9')).toBe(false); // 1-digit month
    expect(isValidCredentialId('AIQ-2026-05-A7F3K')).toBe(false); // 5-char suffix
    expect(isValidCredentialId('')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isValidCredentialId(123 as unknown as string)).toBe(false);
    expect(isValidCredentialId(null as unknown as string)).toBe(false);
    expect(isValidCredentialId(undefined as unknown as string)).toBe(false);
  });
});
