// PT1 / PT-4 — pure tests for plan-tier gates and limits (no DB).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { cfg, tierRef, usageRef } = vi.hoisted(() => ({
  cfg: { PLAN_TIERS_ENFORCED: true },
  tierRef: { value: 'free' as string | null },
  usageRef: { included: 100 as number | null, used: 0 },
}));

vi.mock('@assessiq/core', async (orig) => ({
  ...(await orig<typeof import('@assessiq/core')>()),
  config: cfg,
}));
vi.mock('@assessiq/tenancy', async (orig) => ({
  ...(await orig<typeof import('@assessiq/tenancy')>()),
  withTenant: async (_t: string, fn: (c: unknown) => unknown) => fn({}),
}));
vi.mock('../repository.js', async (orig) => ({
  ...(await orig<typeof import('../repository.js')>()),
  getTenantTier: async () => tierRef.value,
  getPlan: async () =>
    tierRef.value === null
      ? null
      : { tier: tierRef.value, included_credits: usageRef.included, status: 'active', ai_answers_included_override: null },
  countBillingEvents: async () => ({ used: usageRef.used, ai_used: 0, cycle_window_start: null }),
}));

import {
  assertTierAllows,
  assertTierLimit,
  assertCreditsUnderHardCap,
  getTierLimits,
  TIER_LIMITS,
  type TierFeature,
} from '../service.js';

const MIN: Record<TierFeature, 'free' | 'pro' | 'enterprise'> = {
  certificates: 'pro',
  webhooks: 'pro',
  cohort_analytics_full: 'pro',
  api_keys: 'enterprise',
  embed: 'enterprise',
  audit_viewer: 'enterprise',
  own_email_sender: 'enterprise',
};
const ORDER = ['free', 'pro', 'enterprise', 'internal'];

beforeEach(() => {
  cfg.PLAN_TIERS_ENFORCED = true;
  tierRef.value = 'free';
  usageRef.included = 100;
  usageRef.used = 0;
});

describe('assertTierAllows', () => {
  for (const [feature, min] of Object.entries(MIN) as [TierFeature, string][]) {
    for (const tier of ORDER) {
      const allowed = tier === 'internal' || ORDER.indexOf(tier) >= ORDER.indexOf(min);
      it(`${feature} on ${tier} is ${allowed ? 'allowed' : 'blocked'}`, async () => {
        tierRef.value = tier;
        const p = assertTierAllows('t', feature);
        if (allowed) await expect(p).resolves.toBeUndefined();
        else await expect(p).rejects.toMatchObject({ code: 'TIER_NOT_INCLUDED', status: 403 });
      });
    }
  }
  it('blocks a tenant with no plan row (fail-closed)', async () => {
    tierRef.value = null;
    await expect(assertTierAllows('t', 'webhooks')).rejects.toMatchObject({ code: 'TIER_NOT_INCLUDED' });
  });
  it('is a no-op when not enforced', async () => {
    cfg.PLAN_TIERS_ENFORCED = false;
    await expect(assertTierAllows('t', 'embed')).resolves.toBeUndefined();
  });
});

describe('assertTierLimit', () => {
  it('free: 1 pack ok, 2 packs blocked', async () => {
    await expect(assertTierLimit('t', 'licensed_packs', 1)).resolves.toBeUndefined();
    await expect(assertTierLimit('t', 'licensed_packs', 2)).rejects.toMatchObject({ code: 'TIER_LIMIT_REACHED' });
  });
  it('free: 199 ok, 200 blocked for candidates per drive', async () => {
    await expect(assertTierLimit('t', 'per_drive_candidates', 199)).resolves.toBeUndefined();
    await expect(assertTierLimit('t', 'per_drive_candidates', 200)).rejects.toMatchObject({ code: 'TIER_LIMIT_REACHED' });
  });
  it('missing plan row is treated as free (not fail-open)', async () => {
    tierRef.value = null;
    await expect(assertTierLimit('t', 'licensed_packs', 2)).rejects.toMatchObject({ code: 'TIER_LIMIT_REACHED' });
  });
  it('pro has no limit', async () => {
    tierRef.value = 'pro';
    await expect(assertTierLimit('t', 'licensed_packs', 999)).resolves.toBeUndefined();
  });
  it('no-op when not enforced', async () => {
    cfg.PLAN_TIERS_ENFORCED = false;
    await expect(assertTierLimit('t', 'licensed_packs', 99)).resolves.toBeUndefined();
  });
});

describe('assertCreditsUnderHardCap', () => {
  it('free: blocked at 120 % of included, ok just below', async () => {
    usageRef.used = 119;
    await expect(assertCreditsUnderHardCap('t')).resolves.toBeUndefined();
    usageRef.used = 120;
    await expect(assertCreditsUnderHardCap('t')).rejects.toMatchObject({ code: 'CREDITS_HARD_CAP' });
  });
  it('included credits of 0 (missing-plan fallback) is not a cap', async () => {
    usageRef.included = 0;
    usageRef.used = 5;
    await expect(assertCreditsUnderHardCap('t')).resolves.toBeUndefined();
  });
  it('pro is never capped', async () => {
    tierRef.value = 'pro';
    usageRef.used = 10_000;
    await expect(assertCreditsUnderHardCap('t')).resolves.toBeUndefined();
  });
  it('no-op when not enforced', async () => {
    cfg.PLAN_TIERS_ENFORCED = false;
    usageRef.used = 10_000;
    await expect(assertCreditsUnderHardCap('t')).resolves.toBeUndefined();
  });
});

describe('getTierLimits', () => {
  it('returns tier, limits and the flag', async () => {
    expect(await getTierLimits('t')).toEqual({ tier: 'free', limits: TIER_LIMITS.free, enforced: true });
  });
});
