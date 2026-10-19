// PT1 / PT-4 — pure tests for plan-tier gates and limits (no DB).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { cfg, tierRef, usageRef, countRef, roleRef, ledgerRef } = vi.hoisted(() => ({
  ledgerRef: { has: false, balance: 0 },
  cfg: { PLAN_TIERS_ENFORCED: true, FREE_PLAN_AI_DISABLED: false },
  tierRef: { value: 'free' as string | null },
  usageRef: { included: 100 as number | null, used: 0 },
  countRef: { candidates: 0, aiAttempts: 0 },
  roleRef: { value: 'candidate' as string | null },
}));

vi.mock('@assessiq/core', async (orig) => ({
  ...(await orig<typeof import('@assessiq/core')>()),
  config: cfg,
}));
vi.mock('@assessiq/tenancy', async (orig) => ({
  ...(await orig<typeof import('@assessiq/tenancy')>()),
  withTenant: async (_t: string, fn: (c: unknown) => unknown) =>
    fn({ query: async () => ({ rows: roleRef.value === null ? [] : [{ role: roleRef.value }] }) }),
}));
vi.mock('../repository.js', async (orig) => ({
  ...(await orig<typeof import('../repository.js')>()),
  getTenantTier: async () => tierRef.value,
  countCandidatesEver: async () => countRef.candidates,
  countAiAttemptsEver: async () => countRef.aiAttempts,
  getPlan: async () =>
    tierRef.value === null
      ? null
      : { tier: tierRef.value, included_credits: usageRef.included, status: 'active', ai_answers_included_override: null },
  countBillingEvents: async () => ({ used: usageRef.used, ai_used: 0, cycle_window_start: null }),
}));

vi.mock('../credit-repository.js', async (orig) => ({
  ...(await orig<typeof import('../credit-repository.js')>()),
  readCreditBalance: async () => ({
    unlimited: false, has_grants: ledgerRef.has, balance: ledgerRef.balance, next_expiry: null,
    grants: [], burn_by_type: { mock: 0, real: 0, real_camera: 0 }, ai_answers: 0,
  }),
}));

import {
  assertTierAllows,
  assertTierLimit,
  assertCreditsUnderHardCap,
  assertCandidateTotalCap,
  assertCandidateRoleChange,
  assertAiAttemptAllowed,
  getTierLimits,
  TIER_LIMITS,
  type TierFeature,
} from '../service.js';

const MIN: Record<TierFeature, 'free' | 'pro' | 'enterprise'> = {
  certificates: 'free',
  webhooks: 'pro',
  cohort_analytics_full: 'pro',
  api_keys: 'enterprise',
  embed: 'enterprise',
  audit_viewer: 'enterprise',
  own_email_sender: 'enterprise',
  question_upload: 'pro',
};
const ORDER = ['free', 'pro', 'enterprise', 'internal'];

beforeEach(() => {
  cfg.PLAN_TIERS_ENFORCED = true;
  cfg.FREE_PLAN_AI_DISABLED = false;
  tierRef.value = 'free';
  usageRef.included = 100;
  usageRef.used = 0;
  countRef.candidates = 0;
  countRef.aiAttempts = 0;
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
  it('free: 4 packs ok, 5 packs blocked', async () => {
    await expect(assertTierLimit('t', 'licensed_packs', 4)).resolves.toBeUndefined();
    await expect(assertTierLimit('t', 'licensed_packs', 5)).rejects.toMatchObject({ code: 'TIER_LIMIT_REACHED' });
  });
  it('free: 199 ok, 200 blocked for candidates per drive', async () => {
    await expect(assertTierLimit('t', 'per_drive_candidates', 199)).resolves.toBeUndefined();
    await expect(assertTierLimit('t', 'per_drive_candidates', 200)).rejects.toMatchObject({ code: 'TIER_LIMIT_REACHED' });
  });
  it('missing plan row is treated as free (not fail-open)', async () => {
    tierRef.value = null;
    await expect(assertTierLimit('t', 'licensed_packs', 5)).rejects.toMatchObject({ code: 'TIER_LIMIT_REACHED' });
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
  it('free: hard stop at 100 % of included, ok just below', async () => {
    usageRef.used = 99;
    await expect(assertCreditsUnderHardCap('t')).resolves.toBeUndefined();
    usageRef.used = 100;
    await expect(assertCreditsUnderHardCap('t')).rejects.toMatchObject({ code: 'CREDITS_HARD_CAP' });
  });
  it('included credits of 0 (missing-plan fallback) is not a cap', async () => {
    usageRef.included = 0;
    usageRef.used = 5;
    await expect(assertCreditsUnderHardCap('t')).resolves.toBeUndefined();
  });
  it('Z-93: free tenant with ledger grants is capped by its balance', async () => {
    ledgerRef.has = true;
    try {
      usageRef.used = 0;
      ledgerRef.balance = 0;
      await expect(assertCreditsUnderHardCap('t')).rejects.toMatchObject({ code: 'CREDITS_HARD_CAP' });
      ledgerRef.balance = 3;
      await expect(assertCreditsUnderHardCap('t')).resolves.toBeUndefined();
    } finally {
      ledgerRef.has = false;
    }
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

describe('assertCandidateTotalCap', () => {
  it('flag off: free tenant over the limit is not blocked', async () => {
    cfg.PLAN_TIERS_ENFORCED = false;
    countRef.candidates = 50;
    await expect(assertCandidateTotalCap('t', 10)).resolves.toBeUndefined();
  });
  it('flag on, free: 4 existing + 1 passes, 5 existing + 1 blocked', async () => {
    countRef.candidates = 4;
    await expect(assertCandidateTotalCap('t', 1)).resolves.toBeUndefined();
    countRef.candidates = 5;
    await expect(assertCandidateTotalCap('t', 1)).rejects.toMatchObject({ code: 'TIER_LIMIT_REACHED', status: 403 });
  });
  it('flag on, free: a bulk add that crosses the limit is blocked as a whole', async () => {
    countRef.candidates = 3;
    await expect(assertCandidateTotalCap('t', 2)).resolves.toBeUndefined();
    await expect(assertCandidateTotalCap('t', 3)).rejects.toMatchObject({ code: 'TIER_LIMIT_REACHED' });
  });
  it('pro, enterprise, internal are never blocked', async () => {
    countRef.candidates = 10_000;
    for (const tier of ['pro', 'enterprise', 'internal']) {
      tierRef.value = tier;
      await expect(assertCandidateTotalCap('t', 1)).resolves.toBeUndefined();
    }
  });
  it('missing plan row is treated as free', async () => {
    tierRef.value = null;
    countRef.candidates = 5;
    await expect(assertCandidateTotalCap('t', 1)).rejects.toMatchObject({ code: 'TIER_LIMIT_REACHED' });
  });
  it('empty tenant id is rejected, never read as zero', async () => {
    await expect(assertCandidateTotalCap('', 1)).rejects.toBeTruthy();
  });
});

describe('assertAiAttemptAllowed', () => {
  it('flag off: free tenant over the limit and kill switch on is not blocked', async () => {
    cfg.PLAN_TIERS_ENFORCED = false;
    cfg.FREE_PLAN_AI_DISABLED = true;
    countRef.aiAttempts = 50;
    await expect(assertAiAttemptAllowed('t')).resolves.toBeUndefined();
  });
  it('flag on, free: 4 used passes, 5 used blocked', async () => {
    countRef.aiAttempts = 4;
    await expect(assertAiAttemptAllowed('t', 'a1')).resolves.toBeUndefined();
    countRef.aiAttempts = 5;
    await expect(assertAiAttemptAllowed('t', 'a1')).rejects.toMatchObject({ code: 'TIER_LIMIT_REACHED', status: 403 });
  });
  it('kill switch blocks the free tier only', async () => {
    cfg.FREE_PLAN_AI_DISABLED = true;
    await expect(assertAiAttemptAllowed('t')).rejects.toMatchObject({ code: 'AI_GRADING_DISABLED', status: 403 });
    tierRef.value = 'pro';
    await expect(assertAiAttemptAllowed('t')).resolves.toBeUndefined();
  });
  it('pro, enterprise, internal are never blocked', async () => {
    countRef.aiAttempts = 10_000;
    for (const tier of ['pro', 'enterprise', 'internal']) {
      tierRef.value = tier;
      await expect(assertAiAttemptAllowed('t')).resolves.toBeUndefined();
    }
  });
  it('missing plan row is treated as free', async () => {
    tierRef.value = null;
    countRef.aiAttempts = 5;
    await expect(assertAiAttemptAllowed('t')).rejects.toMatchObject({ code: 'TIER_LIMIT_REACHED' });
  });
});

describe('getTierLimits', () => {
  it('returns tier, limits and the flag', async () => {
    expect(await getTierLimits('t')).toEqual({ tier: 'free', limits: TIER_LIMITS.free, enforced: true });
  });
});

describe('assertCandidateRoleChange (gate finding: a role flip must not reset the candidate cap)', () => {
  beforeEach(() => {
    roleRef.value = 'candidate';
  });
  it('flag off: no-op', async () => {
    cfg.PLAN_TIERS_ENFORCED = false;
    await expect(assertCandidateRoleChange('t', 'u', 'admin')).resolves.toBeUndefined();
  });
  it('free: a candidate cannot become an admin', async () => {
    await expect(assertCandidateRoleChange('t', 'u', 'admin')).rejects.toMatchObject({ code: 'TIER_LIMIT_REACHED' });
  });
  it('free: admin to candidate counts as one new candidate (blocked at the cap, allowed below)', async () => {
    roleRef.value = 'admin';
    countRef.candidates = 5;
    await expect(assertCandidateRoleChange('t', 'u', 'candidate')).rejects.toMatchObject({ code: 'TIER_LIMIT_REACHED' });
    countRef.candidates = 4;
    await expect(assertCandidateRoleChange('t', 'u', 'candidate')).resolves.toBeUndefined();
  });
  it('same role or unknown user: no-op', async () => {
    await expect(assertCandidateRoleChange('t', 'u', 'candidate')).resolves.toBeUndefined();
    roleRef.value = null;
    await expect(assertCandidateRoleChange('t', 'u', 'admin')).resolves.toBeUndefined();
  });
  it('pro tier is never blocked', async () => {
    tierRef.value = 'pro';
    await expect(assertCandidateRoleChange('t', 'u', 'admin')).resolves.toBeUndefined();
  });
});
