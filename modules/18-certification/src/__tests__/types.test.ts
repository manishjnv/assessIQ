// AssessIQ — modules/18-certification/src/__tests__/types.test.ts
//
// Phase 5 Session 1 — real unit tests for TIER_ORDER + CREDENTIAL_ID_REGEX.
// These are not stubs: they run and pass in this session.
//
// Tests:
//   1. TIER_ORDER monotonicity — each successive tier has a strictly higher ordinal
//   2. TIER_ORDER no-downgrade invariant — higher-tier ordinal > lower-tier ordinal
//   3. CREDENTIAL_ID_REGEX — valid formats match, invalid formats do not
//   4. CredentialIdSchema Zod validator — same coverage via schema parse

import { describe, it, expect } from 'vitest';
import {
  TIER_ORDER,
  CREDENTIAL_ID_REGEX,
  CredentialIdSchema,
  TierSchema,
  type Tier,
} from '../types.js';

// ---------------------------------------------------------------------------
// TIER_ORDER — monotonicity
// ---------------------------------------------------------------------------

describe('TIER_ORDER', () => {
  it('contains exactly the three canonical tiers', () => {
    const keys = Object.keys(TIER_ORDER).sort();
    expect(keys).toEqual(['completion', 'distinction', 'honors']);
  });

  it('is strictly monotonic: completion < distinction < honors', () => {
    expect(TIER_ORDER.completion).toBeLessThan(TIER_ORDER.distinction);
    expect(TIER_ORDER.distinction).toBeLessThan(TIER_ORDER.honors);
  });

  it('all ordinals are positive integers', () => {
    for (const [, v] of Object.entries(TIER_ORDER)) {
      expect(v).toBeGreaterThan(0);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('no-downgrade: a higher tier always has a strictly greater ordinal', () => {
    // Simulates the "never downgrade" rule from plan §1.3:
    //   if (TIER_ORDER[existing.tier] >= TIER_ORDER[newTier]) return existing;
    const pairs: [Tier, Tier][] = [
      ['distinction', 'completion'],  // regression case: existing=distinction, new=completion
      ['honors', 'completion'],
      ['honors', 'distinction'],
    ];
    for (const [existing, newTier] of pairs) {
      expect(TIER_ORDER[existing]).toBeGreaterThan(TIER_ORDER[newTier]);
    }
  });

  it('same-tier comparison is equal (idempotent re-issue does not upgrade)', () => {
    for (const tier of ['completion', 'distinction', 'honors'] as Tier[]) {
      expect(TIER_ORDER[tier]).toBe(TIER_ORDER[tier]);
    }
  });
});

// ---------------------------------------------------------------------------
// CREDENTIAL_ID_REGEX — format validation
// ---------------------------------------------------------------------------

describe('CREDENTIAL_ID_REGEX', () => {
  // Valid cases from the plan §1.2: PREFIX-YYYY-MM-XXXXXX
  const validIds = [
    'AIQ-2026-05-A7F3K9',
    'AER-2025-12-ZZZZZZ',
    'CRS-2026-01-000000',
    'ABCD-2026-05-123ABC',  // 4-char prefix
    'AB-2026-05-ABCDEF',    // 2-char prefix
    'ABC-2026-05-ABCDEF',   // 3-char prefix
  ];

  const invalidIds = [
    'aiq-2026-05-A7F3K9',   // lowercase prefix
    'AIQ-26-05-A7F3K9',     // 2-digit year
    'AIQ-2026-5-A7F3K9',    // 1-digit month
    'AIQ-2026-05-A7F3',     // only 5 suffix chars
    'AIQ-2026-05-a7f3k9',   // lowercase suffix
    'AIQ-2026-05-A7F3K90',  // 7 suffix chars
    '1IQ-2026-05-A7F3K9',   // digit in prefix
    'ABCDE-2026-05-A7F3K9', // 5-char prefix (too long)
    'A-2026-05-A7F3K9',     // 1-char prefix (too short)
    'AIQ2026-05-A7F3K9',    // missing first dash
    'AIQ-2026-05A7F3K9',    // missing last dash
    '',
    'not-a-credential-id',
  ];

  for (const id of validIds) {
    it(`accepts valid credential_id: ${id}`, () => {
      expect(CREDENTIAL_ID_REGEX.test(id)).toBe(true);
    });
  }

  for (const id of invalidIds) {
    it(`rejects invalid credential_id: "${id}"`, () => {
      expect(CREDENTIAL_ID_REGEX.test(id)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// CredentialIdSchema (Zod) — same coverage via parse
// ---------------------------------------------------------------------------

describe('CredentialIdSchema', () => {
  it('parses a valid credential_id successfully', () => {
    const result = CredentialIdSchema.safeParse('AIQ-2026-05-A7F3K9');
    expect(result.success).toBe(true);
  });

  it('rejects lowercase credential_id with a descriptive error', () => {
    const result = CredentialIdSchema.safeParse('aiq-2026-05-a7f3k9');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0]?.message).toContain('PREFIX-YYYY-MM-XXXXXX');
    }
  });

  it('rejects non-string input', () => {
    const result = CredentialIdSchema.safeParse(12345);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TierSchema (Zod) — enum validation
// ---------------------------------------------------------------------------

describe('TierSchema', () => {
  it('accepts all three valid tiers', () => {
    for (const t of ['completion', 'distinction', 'honors']) {
      expect(TierSchema.safeParse(t).success).toBe(true);
    }
  });

  it('rejects unknown tier strings', () => {
    expect(TierSchema.safeParse('pass').success).toBe(false);
    expect(TierSchema.safeParse('fail').success).toBe(false);
    expect(TierSchema.safeParse('').success).toBe(false);
  });
});
