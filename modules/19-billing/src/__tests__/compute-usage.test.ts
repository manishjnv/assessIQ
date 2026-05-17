// AssessIQ — modules/19-billing/src/__tests__/compute-usage.test.ts
//
// Pure unit tests for computeUsage(). No DB, no Docker, always runs.
//
// Coverage:
//   - NULL included_credits → 'unlimited', remaining=null, overage=0
//   - included_credits=0 → 'over' (avoids div-by-zero, always over)
//   - used < 80% of included → 'ok'
//   - used at 80% of included → 'warn'
//   - used between 80% and 99% → 'warn'
//   - used at exactly 100% → 'over', overage=0
//   - used > 100% → 'over', correct overage integer
//   - green/amber/red threshold boundaries (exact spec values)

import { describe, it, expect } from 'vitest';
import { computeUsage } from '../service.js';

// ---------------------------------------------------------------------------
// Unlimited (internal tier — NULL included_credits)
// ---------------------------------------------------------------------------

describe('computeUsage — unlimited (null included_credits)', () => {
  it('returns status unlimited, remaining null, overage 0 for null credits', () => {
    const result = computeUsage('internal', null, 0);
    expect(result.status).toBe('unlimited');
    expect(result.remaining).toBeNull();
    expect(result.overage).toBe(0);
  });

  it('returns unlimited even when used > 0', () => {
    const result = computeUsage('internal', null, 1000);
    expect(result.status).toBe('unlimited');
    expect(result.remaining).toBeNull();
    expect(result.overage).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Edge: included_credits = 0 → always over
// ---------------------------------------------------------------------------

describe('computeUsage — included_credits = 0', () => {
  it('returns over with overage=used when includedCredits=0 and used>0', () => {
    const result = computeUsage('free', 0, 1);
    expect(result.status).toBe('over');
    expect(result.overage).toBe(1);
  });

  it('returns over when includedCredits=0 and used=0 (ratio=Infinity)', () => {
    // 0 included and 0 used: ratio = Infinity → over
    const result = computeUsage('free', 0, 0);
    expect(result.status).toBe('over');
    expect(result.overage).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Default free tier: 25 credits
// ---------------------------------------------------------------------------

describe('computeUsage — free/25 tier', () => {
  it('status ok when used < 80% of 25 (used=0)', () => {
    const result = computeUsage('free', 25, 0);
    expect(result.status).toBe('ok');
    expect(result.remaining).toBe(25);
    expect(result.overage).toBe(0);
  });

  it('status ok at 79% (used=19, 19/25=0.76)', () => {
    const result = computeUsage('free', 25, 19);
    expect(result.status).toBe('ok');
    expect(result.remaining).toBe(6);
    expect(result.overage).toBe(0);
  });

  it('status warn at exactly 80% (used=20, 20/25=0.80)', () => {
    const result = computeUsage('free', 25, 20);
    expect(result.status).toBe('warn');
    expect(result.remaining).toBe(5);
    expect(result.overage).toBe(0);
  });

  it('status warn at 84% (used=21, 21/25=0.84)', () => {
    const result = computeUsage('free', 25, 21);
    expect(result.status).toBe('warn');
    expect(result.remaining).toBe(4);
    expect(result.overage).toBe(0);
  });

  it('status warn at 96% (used=24, 24/25=0.96)', () => {
    const result = computeUsage('free', 25, 24);
    expect(result.status).toBe('warn');
    expect(result.remaining).toBe(1);
    expect(result.overage).toBe(0);
  });

  it('status over at exactly 100% (used=25)', () => {
    const result = computeUsage('free', 25, 25);
    expect(result.status).toBe('over');
    expect(result.remaining).toBe(0);
    expect(result.overage).toBe(0);
  });

  it('status over at 104% (used=26), overage=1', () => {
    const result = computeUsage('free', 25, 26);
    expect(result.status).toBe('over');
    expect(result.remaining).toBe(-1);
    expect(result.overage).toBe(1);
  });

  it('status over at 200% (used=50), overage=25', () => {
    const result = computeUsage('free', 25, 50);
    expect(result.status).toBe('over');
    expect(result.remaining).toBe(-25);
    expect(result.overage).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// Larger credit pool (pro/enterprise) — verify thresholds scale correctly
// ---------------------------------------------------------------------------

describe('computeUsage — 100-credit plan', () => {
  it('ok at 79 used (79%)', () => {
    const result = computeUsage('pro', 100, 79);
    expect(result.status).toBe('ok');
  });

  it('warn at 80 used (80%)', () => {
    const result = computeUsage('pro', 100, 80);
    expect(result.status).toBe('warn');
  });

  it('warn at 99 used (99%)', () => {
    const result = computeUsage('pro', 100, 99);
    expect(result.status).toBe('warn');
    expect(result.overage).toBe(0);
  });

  it('over at 100 used (100%), overage=0', () => {
    const result = computeUsage('pro', 100, 100);
    expect(result.status).toBe('over');
    expect(result.overage).toBe(0);
  });

  it('over at 150 used (150%), overage=50', () => {
    const result = computeUsage('pro', 100, 150);
    expect(result.status).toBe('over');
    expect(result.overage).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// overage is never negative
// ---------------------------------------------------------------------------

describe('computeUsage — overage is always >= 0', () => {
  it('overage=0 when under quota', () => {
    const result = computeUsage('free', 25, 10);
    expect(result.overage).toBe(0);
  });

  it('overage=0 at exactly 100%', () => {
    const result = computeUsage('free', 25, 25);
    expect(result.overage).toBe(0);
  });

  it('overage is positive when over quota', () => {
    const result = computeUsage('free', 25, 30);
    expect(result.overage).toBeGreaterThan(0);
    expect(result.overage).toBe(5);
  });
});
