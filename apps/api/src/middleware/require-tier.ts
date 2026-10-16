import type { preHandlerHookHandler } from "fastify";
import { config } from "@assessiq/core";
import { listInvitations } from "@assessiq/assessment-lifecycle";
import {
  assertTierAllows,
  assertTierLimit,
  assertCreditsUnderHardCap,
  type TierFeature,
} from "@assessiq/billing";

/**
 * PT1 plan-tier gate. Runs AFTER the auth chain (needs req.session). Throws
 * 403 TIER_NOT_INCLUDED when the tenant's tier lacks `feature`; a no-op while
 * PLAN_TIERS_ENFORCED is false (assertTierAllows checks the flag).
 */
export function requireTier(feature: TierFeature): preHandlerHookHandler {
  return async (req) => {
    const tenantId = (req as unknown as { session?: { tenantId?: string } }).session?.tenantId;
    if (!tenantId) return; // auth chain already rejected
    await assertTierAllows(tenantId, feature);
  };
}

/**
 * PT1/PT-4 invite gate: Starter credit hard cap, then candidates-per-drive cap
 * (existing invitations for the assessment + `newCount`). No-op while not
 * enforced. Checked at invite time, never inside the grade transaction.
 * ponytail: the count includes revoked invitations; refine if Starter tenants complain.
 */
export async function assertInviteWithinTier(
  tenantId: string,
  assessmentId: string,
  newCount: number,
): Promise<void> {
  if (!config.PLAN_TIERS_ENFORCED) return;
  await assertCreditsUnderHardCap(tenantId);
  const { total } = await listInvitations(tenantId, assessmentId, { page: 1, pageSize: 1 });
  await assertTierLimit(tenantId, "per_drive_candidates", total + newCount - 1);
}
