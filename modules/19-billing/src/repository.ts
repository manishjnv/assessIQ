// AssessIQ — modules/19-billing/src/repository.ts
//
// Low-level SQL layer for the billing module.
// All functions accept a PoolClient so the caller controls the transaction
// boundary (critical for the revenue-leak invariant — see service.ts).
//
// No try/catch here. Errors intentionally propagate so the enclosing
// withTenant transaction rolls back (mirrors the auditInTx pattern in
// modules/14-audit-log).

import type { PoolClient } from 'pg';
import type { TenantPlanRow } from './types.js';

/**
 * Record a graded-attempt billing event.
 *
 * ON CONFLICT DO NOTHING enforces idempotency — a re-grade of the same
 * (tenant_id, attempt_id) pair is silently skipped. The UNIQUE constraint
 * on billing_events is the authoritative guard.
 */
export async function insertBillingEvent(
  client: PoolClient,
  tenantId: string,
  attemptId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO billing_events (tenant_id, attempt_id, event_type)
     VALUES ($1, $2, 'assessment_graded')
     ON CONFLICT (tenant_id, attempt_id) DO NOTHING`,
    [tenantId, attemptId],
  );
}

/**
 * Provision a default free plan for a newly-created tenant.
 *
 * ON CONFLICT DO NOTHING makes this safe to call more than once
 * (e.g. if the provisioning hook is retried).
 */
export async function insertDefaultFreePlan(
  client: PoolClient,
  tenantId: string,
  includedCredits: number,
): Promise<void> {
  await client.query(
    `INSERT INTO tenant_plans (tenant_id, tier, included_credits)
     VALUES ($1, 'free', $2)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId, includedCredits],
  );
}

/**
 * Fetch the billing plan for a tenant.
 * Returns null if the tenant has no plan row (data-integrity gap — caller handles).
 */
export async function getPlan(
  client: PoolClient,
  tenantId: string,
): Promise<TenantPlanRow | null> {
  const result = await client.query<TenantPlanRow>(
    `SELECT tier, included_credits, status FROM tenant_plans WHERE tenant_id = $1`,
    [tenantId],
  );
  return result.rows[0] ?? null;
}

/**
 * Count billing events (graded attempts) for a tenant within the current cycle.
 * The simple COUNT(*) is intentional for A1 — cycle-window filtering is A2.
 */
export async function countBillingEvents(
  client: PoolClient,
  tenantId: string,
): Promise<number> {
  const result = await client.query<{ used: number }>(
    `SELECT COUNT(*)::int AS used FROM billing_events WHERE tenant_id = $1`,
    [tenantId],
  );
  return result.rows[0]?.used ?? 0;
}
