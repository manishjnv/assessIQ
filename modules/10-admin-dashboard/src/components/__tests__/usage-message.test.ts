// AssessIQ — modules/10-admin-dashboard/src/components/__tests__/usage-message.test.ts
//
// Pure-unit tests for usageMessage() — no DOM, no DB, always runs.
// Covers all four CompanyUsage status values: ok / warn / over / unlimited.

import { describe, it, expect } from 'vitest';
import { usageMessage } from '../UsageBanner.js';
import type { CompanyUsage } from '../../api.js';

function makeUsage(overrides: Partial<CompanyUsage>): CompanyUsage {
  return {
    tier: 'free',
    included_credits: 25,
    used: 0,
    remaining: 25,
    overage: 0,
    status: 'ok',
    ...overrides,
  };
}

describe('usageMessage', () => {
  it('returns null for unlimited status', () => {
    const usage = makeUsage({
      tier: 'internal',
      included_credits: null,
      used: 0,
      remaining: null,
      overage: 0,
      status: 'unlimited',
    });
    expect(usageMessage(usage)).toBeNull();
  });

  it('returns ok text with muted colour for status ok', () => {
    const usage = makeUsage({ used: 10, remaining: 15, status: 'ok' });
    const result = usageMessage(usage);
    expect(result).not.toBeNull();
    expect(result?.text).toContain('10 of 25');
    expect(result?.color).toContain('muted');
  });

  it('returns warn text with amber colour and percentage for status warn', () => {
    const usage = makeUsage({ used: 20, remaining: 5, status: 'warn' });
    const result = usageMessage(usage);
    expect(result).not.toBeNull();
    expect(result?.text).toContain('20 of 25');
    expect(result?.text).toContain('80%');
    expect(result?.text).toContain('Contact your platform operator');
    expect(result?.color).toContain('warning');
  });

  it('returns over text with danger colour and overage count for status over', () => {
    const usage = makeUsage({ used: 30, remaining: -5, overage: 5, status: 'over' });
    const result = usageMessage(usage);
    expect(result).not.toBeNull();
    expect(result?.text).toContain('30 used');
    expect(result?.text).toContain('25 included');
    expect(result?.text).toContain('5 over');
    expect(result?.text).toContain('contact your platform operator');
    expect(result?.color).toContain('danger');
  });
});
