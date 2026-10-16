import { describe, it, expect, vi, beforeEach } from 'vitest';

const { assertTierAllows, assertTierLimit, assertCreditsUnderHardCap, listInvitations, cfg } = vi.hoisted(() => ({
  assertTierAllows: vi.fn(),
  assertTierLimit: vi.fn(),
  assertCreditsUnderHardCap: vi.fn(),
  listInvitations: vi.fn(),
  cfg: { PLAN_TIERS_ENFORCED: true },
}));

vi.mock('@assessiq/billing', () => ({ assertTierAllows, assertTierLimit, assertCreditsUnderHardCap }));
vi.mock('@assessiq/assessment-lifecycle', () => ({ listInvitations }));
vi.mock('@assessiq/core', async (orig) => ({ ...(await orig<typeof import('@assessiq/core')>()), config: cfg }));

import { requireTier, assertInviteWithinTier } from '../../middleware/require-tier.js';

const call = (h: unknown, session?: { tenantId: string }) =>
  (h as (req: unknown, reply: unknown) => Promise<void>)({ session }, {});

beforeEach(() => {
  vi.resetAllMocks();
  cfg.PLAN_TIERS_ENFORCED = true;
});

describe('requireTier', () => {
  it('does nothing without a session', async () => {
    await call(requireTier('webhooks'));
    expect(assertTierAllows).not.toHaveBeenCalled();
  });
  it('checks the session tenant for the feature', async () => {
    await call(requireTier('embed'), { tenantId: 't1' });
    expect(assertTierAllows).toHaveBeenCalledWith('t1', 'embed');
  });
  it('propagates the 403 from the gate', async () => {
    assertTierAllows.mockRejectedValue(new Error('TIER_NOT_INCLUDED'));
    await expect(call(requireTier('embed'), { tenantId: 't1' })).rejects.toThrow('TIER_NOT_INCLUDED');
  });
});

describe('assertInviteWithinTier', () => {
  it('is a no-op when not enforced', async () => {
    cfg.PLAN_TIERS_ENFORCED = false;
    await assertInviteWithinTier('t1', 'a1', 5);
    expect(assertCreditsUnderHardCap).not.toHaveBeenCalled();
    expect(listInvitations).not.toHaveBeenCalled();
  });
  it('checks the credit cap then existing + new candidates against the drive limit', async () => {
    listInvitations.mockResolvedValue({ total: 150 });
    await assertInviteWithinTier('t1', 'a1', 50);
    expect(assertCreditsUnderHardCap).toHaveBeenCalledWith('t1');
    // 150 + 50 = 200 candidates is allowed: limit check sees 199 (throws only at >= 200)
    expect(assertTierLimit).toHaveBeenCalledWith('t1', 'per_drive_candidates', 199);
  });
});
