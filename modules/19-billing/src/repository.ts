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
import type { TenantPlanRow, TenantUsageRow, BillingEventRow } from './types.js';

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

// ---------------------------------------------------------------------------
// A2 — cross-tenant (system-role) queries
// All called from within withSystemTx, which runs under assessiq_system
// (BYPASSRLS). No RLS context needed.
// ---------------------------------------------------------------------------

/**
 * Cross-tenant usage summary for all tenants.
 *
 * Left-joins billing_events to handle tenants with zero events.
 * Returns raw rows; caller maps through computeUsage for remaining/overage/status.
 */
export async function getAllTenantUsageRaw(
  client: PoolClient,
): Promise<Array<{ tenant_id: string; tier: string; included_credits: number | null; used: number }>> {
  const result = await client.query<{
    tenant_id: string;
    tier: string;
    included_credits: number | null;
    used: number;
  }>(
    `SELECT p.tenant_id, p.tier, p.included_credits,
            COALESCE(b.used, 0)::int AS used
     FROM tenant_plans p
     LEFT JOIN (
       SELECT tenant_id, COUNT(*) AS used
       FROM billing_events
       GROUP BY tenant_id
     ) b ON b.tenant_id = p.tenant_id`,
  );
  return result.rows;
}

/**
 * Fetch a single tenant's plan row.
 * Returns null if not found.
 * Used by getTenantBillingDetail + updateTenantPlan (the latter uses FOR UPDATE).
 */
export async function getTenantPlanRow(
  client: PoolClient,
  tenantId: string,
  forUpdate = false,
): Promise<{ tier: string; included_credits: number | null; status: string; cycle_start: Date } | null> {
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await client.query<{
    tier: string;
    included_credits: number | null;
    status: string;
    cycle_start: Date;
  }>(
    `SELECT tier, included_credits, status, cycle_start
     FROM tenant_plans WHERE tenant_id = $1${lockClause}`,
    [tenantId],
  );
  return result.rows[0] ?? null;
}

/**
 * Count billing events for a tenant (cross-tenant path).
 */
export async function countTenantBillingEvents(
  client: PoolClient,
  tenantId: string,
): Promise<number> {
  const result = await client.query<{ used: number }>(
    `SELECT COUNT(*)::int AS used FROM billing_events WHERE tenant_id = $1`,
    [tenantId],
  );
  return result.rows[0]?.used ?? 0;
}

/**
 * Fetch recent billing events for a tenant (last 50, desc).
 */
export async function getRecentBillingEvents(
  client: PoolClient,
  tenantId: string,
): Promise<BillingEventRow[]> {
  const result = await client.query<{
    id: string;
    attempt_id: string;
    event_type: string;
    occurred_at: Date;
  }>(
    `SELECT id, attempt_id, event_type, occurred_at
     FROM billing_events
     WHERE tenant_id = $1
     ORDER BY occurred_at DESC
     LIMIT 50`,
    [tenantId],
  );
  return result.rows.map((r) => ({
    id: r.id,
    attempt_id: r.attempt_id,
    event_type: r.event_type,
    occurred_at: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at),
  }));
}

/**
 * Fetch ALL billing events for a tenant (for CSV export).
 */
export async function getAllBillingEventsForExport(
  client: PoolClient,
  tenantId: string,
): Promise<Array<{ id: string; attempt_id: string; event_type: string; occurred_at: Date }>> {
  const result = await client.query<{
    id: string;
    attempt_id: string;
    event_type: string;
    occurred_at: Date;
  }>(
    `SELECT id, attempt_id, event_type, occurred_at
     FROM billing_events
     WHERE tenant_id = $1
     ORDER BY occurred_at DESC`,
    [tenantId],
  );
  return result.rows;
}

/**
 * UPDATE tenant_plans row (tier + included_credits).
 * Returns the updated_at timestamp.
 */
export async function updateTenantPlanRow(
  client: PoolClient,
  tenantId: string,
  tier: string,
  includedCredits: number | null,
): Promise<{ updated_at: Date }> {
  const result = await client.query<{ updated_at: Date }>(
    `UPDATE tenant_plans
     SET tier = $2, included_credits = $3, updated_at = now()
     WHERE tenant_id = $1
     RETURNING updated_at`,
    [tenantId, tier, includedCredits],
  );
  // Caller has already verified the row exists with FOR UPDATE, so this
  // should always return a row. Propagate if not.
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`updateTenantPlanRow: no row returned for tenant ${tenantId}`);
  }
  return row;
}
