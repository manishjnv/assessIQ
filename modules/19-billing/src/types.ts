// AssessIQ — modules/19-billing/src/types.ts
//
// Public types for the billing / usage-metering module (A1 + A2 phases).
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

// ---------------------------------------------------------------------------
// A2 types — cross-tenant usage (super-admin) + billing detail
// ---------------------------------------------------------------------------

/** One row in the cross-tenant usage summary (super-admin GET /tenants). */
export interface TenantUsageRow {
  tenant_id: string;
  tier: PlanTier;
  included_credits: number | null;
  used: number;
  remaining: number | null;
  overage: number;
  status: UsageStatus;
}

/** Recent billing event (last 50 per tenant). */
export interface BillingEventRow {
  id: string;
  attempt_id: string;
  event_type: string;
  occurred_at: string; // ISO 8601
}

/** Full billing detail for a single tenant (super-admin billing drawer). */
export interface TenantBillingDetail {
  tenant_id: string;
  tier: PlanTier;
  included_credits: number | null;
  status: 'active' | 'suspended';
  cycle_start: string; // ISO 8601
  used: number;
  remaining: number | null;
  overage: number;
  usage_status: UsageStatus;
  recent_events: BillingEventRow[];
}

/** Patch input for updateTenantPlan. */
export interface UpdateTenantPlanPatch {
  tier?: PlanTier;
  includedCredits?: number | null;
}

/** Return shape of updateTenantPlan. */
export interface UpdateTenantPlanResult {
  tenant_id: string;
  tier: PlanTier;
  included_credits: number | null;
  previous: { tier: PlanTier; included_credits: number | null };
  updatedAt: string;
  auditId: string;
}

// ---------------------------------------------------------------------------
// B1 types — tenant entitlements
// ---------------------------------------------------------------------------

/** Scope type for an entitlement — 'domain' or 'pack'. */
export type EntitlementScopeType = 'domain' | 'pack';

/** A row from tenant_entitlements as returned by the service layer. */
export interface TenantEntitlement {
  id: string;
  tenant_id: string;
  scope_type: EntitlementScopeType;
  scope_id: string;
  status: 'active' | 'revoked';
  granted_at: string; // ISO 8601
  granted_by: string | null;
}

/** Input for grantEntitlement / revokeEntitlement. */
export interface GrantEntitlementInput {
  scopeType: EntitlementScopeType;
  scopeId: string;
}

// ---------------------------------------------------------------------------
// Step 2 types — "Available sets" catalog (standing license + clone-on-use)
// ---------------------------------------------------------------------------

/**
 * One published platform-library set a tenant is licensed for (by domain or
 * pack scope). Metadata only — no question content. `source_pack_id` is the
 * PLATFORM pack id; clone-on-use materialises it into the company tenant on
 * first use.
 */
export interface AvailableSet {
  source_pack_id: string;     // platform pack id
  name: string;
  domain: string;
  source_version: number;     // current platform pack version
  question_count: number;     // active questions in the platform set
  level_count: number;
  cloned: boolean;            // already materialised into this tenant?
  cloned_pack_id: string | null;
  update_available: boolean;  // cloned AND a newer source version exists
}
