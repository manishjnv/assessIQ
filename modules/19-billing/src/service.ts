// AssessIQ — modules/19-billing/src/service.ts
//
// Business logic layer for usage metering and plan management.
// Pure-function helpers (computeUsage) are DB-free and unit-testable.

import type { PoolClient } from 'pg';
import { withTenant } from '@assessiq/tenancy';
import { streamLogger } from '@assessiq/core';
import {
  insertBillingEvent,
  insertDefaultFreePlan,
  getPlan,
  countBillingEvents,
} from './repository.js';
import type { BillingUsage, PlanTier, UsageStatus } from './types.js';

const log = streamLogger('billing');

/** Default credit allowance for newly-provisioned free-tier tenants. */
export const DEFAULT_FREE_CREDITS = 25;

/**
 * Record a graded-attempt billing event.
 *
 * REVENUE-LEAK INVARIANT: called inside the SAME transaction as the
 * attempt→graded commit (mirrors auditInTx). The ON CONFLICT DO NOTHING
 * handles the ONLY benign error — a duplicate (re-grade/re-accept). Any
 * OTHER db error (FK, RLS deny, connection) intentionally propagates so
 * the enclosing withTenant ROLLBACK reverts the grade too — a graded
 * attempt with no billing row is a revenue leak.
 * DO NOT add a try/catch here.
 */
export async function recordGradedAttempt(
  client: PoolClient,
  tenantId: string,
  attemptId: string,
): Promise<void> {
  await insertBillingEvent(client, tenantId, attemptId);
}

/**
 * Provision a default free plan for a newly-created tenant.
 *
 * Called from the createCompany hook. Runs under the NEW tenant's context
 * via withTenant so the INSERT RLS WITH CHECK passes (tenant_id must equal
 * current_setting('app.current_tenant', true)::uuid).
 */
export async function provisionDefaultPlan(
  tenantId: string,
  includedCredits = DEFAULT_FREE_CREDITS,
): Promise<void> {
  await withTenant(tenantId, (c) =>
    insertDefaultFreePlan(c, tenantId, includedCredits),
  );
}

/**
 * Compute remaining/overage/status from plan data and usage count.
 *
 * PURE — no DB calls. Unit-testable without Docker.
 *
 * Status thresholds:
 *   - unlimited: included_credits === null
 *   - ok:        used / included_credits < 0.8
 *   - warn:      0.8 <= used / included_credits < 1.0
 *   - over:      used / included_credits >= 1.0
 *   - over:      included_credits === 0 (always over, avoids division by zero)
 */
export function computeUsage(
  _tier: PlanTier,
  includedCredits: number | null,
  used: number,
): { remaining: number | null; overage: number; status: UsageStatus } {
  if (includedCredits === null) {
    return { remaining: null, overage: 0, status: 'unlimited' };
  }

  const remaining = includedCredits - used;
  const overage = Math.max(0, used - includedCredits);
  const ratio =
    includedCredits === 0 ? Infinity : used / includedCredits;

  let status: UsageStatus;
  if (ratio >= 1) {
    status = 'over';
  } else if (ratio >= 0.8) {
    status = 'warn';
  } else {
    status = 'ok';
  }

  return { remaining, overage, status };
}

/**
 * Fetch the full billing usage picture for a tenant.
 *
 * If no plan row exists (data-integrity gap — every tenant should be
 * backfilled by 0080_billing_backfill.sql and provisioned on creation),
 * falls back to tier:'free'/includedCredits:0 which yields status:'over'
 * so the operator notices the missing row immediately.
 */
export async function getUsage(tenantId: string): Promise<BillingUsage> {
  return withTenant(tenantId, async (c) => {
    const plan = await getPlan(c, tenantId);
    const used = await countBillingEvents(c, tenantId);

    let tier: PlanTier;
    let includedCredits: number | null;

    if (!plan) {
      log.warn(
        { tenantId },
        'billing.getUsage: no plan row found — data-integrity gap; falling back to free/0 (status will be over)',
      );
      tier = 'free';
      includedCredits = 0;
    } else {
      tier = plan.tier;
      includedCredits = plan.included_credits;
    }

    const { remaining, overage, status } = computeUsage(
      tier,
      includedCredits,
      used,
    );

    return {
      tier,
      included_credits: includedCredits,
      used,
      remaining,
      overage,
      status,
    } satisfies BillingUsage;
  });
}
