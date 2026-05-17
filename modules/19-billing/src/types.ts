// AssessIQ — modules/19-billing/src/types.ts
//
// Public types for the billing / usage-metering module (A1 phase).
// Consumed by routes.ts, service.ts, and the admin dashboard.

export type PlanTier = 'free' | 'pro' | 'enterprise' | 'internal';

export interface TenantPlanRow {
  tenant_id: string;
  tier: PlanTier;
  included_credits: number | null;
  status: 'active' | 'suspended';
}

/**
 * Soft-enforcement status.
 *
 * - 'ok'        usage < 80% of included credits
 * - 'warn'      usage >= 80% but < 100% of included credits
 * - 'over'      usage >= 100% of included credits (overage accruing)
 * - 'unlimited' plan has included_credits = NULL (internal tier)
 */
export type UsageStatus = 'ok' | 'warn' | 'over' | 'unlimited';

export interface BillingUsage {
  tier: PlanTier;
  included_credits: number | null;
  used: number;
  remaining: number | null;  // null => unlimited
  overage: number;           // 0 when unlimited or under
  status: UsageStatus;
}
