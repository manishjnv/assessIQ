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
import type { TenantPlanRow, TenantUsageRow, BillingEventRow, TenantEntitlement, EntitlementScopeType } from './types.js';

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

// ---------------------------------------------------------------------------
// B1 — tenant_entitlements repository
// All functions accept a PoolClient so the caller controls the transaction
// boundary (critical for the two-role same-tx atomicity invariant).
// ---------------------------------------------------------------------------

/**
 * Insert (or re-activate) a tenant entitlement.
 *
 * ON CONFLICT DO UPDATE reactivates a previously-revoked row — idempotent:
 *   grant(active)   → no-op (already active, granted_at/granted_by updated)
 *   grant(revoked)  → reactivates: status='active', clears revoke fields
 *
 * Returns the row id.
 */
export async function insertEntitlement(
  client: PoolClient,
  tenantId: string,
  scopeType: EntitlementScopeType,
  scopeId: string,
  grantedBy: string | null,
): Promise<{ id: string }> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO tenant_entitlements (tenant_id, scope_type, scope_id, granted_by, status)
     VALUES ($1, $2, $3, $4, 'active')
     ON CONFLICT (tenant_id, scope_type, scope_id) DO UPDATE
       SET status     = 'active',
           granted_by = EXCLUDED.granted_by,
           granted_at = now(),
           revoked_by = NULL,
           revoked_at = NULL
     RETURNING id`,
    [tenantId, scopeType, scopeId, grantedBy],
  );
  // INSERT ... RETURNING always returns a row (conflict or not).
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`insertEntitlement: no row returned for tenant ${tenantId} scope ${scopeType}:${scopeId}`);
  }
  return row;
}

/**
 * Revoke an active tenant entitlement.
 *
 * Only updates rows where status = 'active'. Returns the row id if a row was
 * updated, or null if nothing was active to revoke (caller throws NotFoundError).
 */
export async function revokeEntitlement(
  client: PoolClient,
  tenantId: string,
  scopeType: EntitlementScopeType,
  scopeId: string,
  revokedBy: string,
): Promise<{ id: string } | null> {
  const result = await client.query<{ id: string }>(
    `UPDATE tenant_entitlements
     SET status     = 'revoked',
         revoked_by = $4,
         revoked_at = now()
     WHERE tenant_id  = $1
       AND scope_type = $2
       AND scope_id   = $3
       AND status     = 'active'
     RETURNING id`,
    [tenantId, scopeType, scopeId, revokedBy],
  );
  return result.rows[0] ?? null;
}

/**
 * List entitlements for a tenant.
 *
 * opts.activeOnly = true → only status='active' rows (company-side read path).
 * opts.activeOnly = false / omitted → all rows (super-admin read path).
 *
 * Ordered by scope_type ASC, scope_id ASC for stable rendering.
 */
export async function listEntitlements(
  client: PoolClient,
  tenantId: string,
  opts?: { activeOnly?: boolean },
): Promise<TenantEntitlement[]> {
  const where = opts?.activeOnly
    ? `WHERE tenant_id = $1 AND status = 'active'`
    : `WHERE tenant_id = $1`;

  const result = await client.query<{
    id: string;
    tenant_id: string;
    scope_type: string;
    scope_id: string;
    status: string;
    granted_at: Date;
    granted_by: string | null;
  }>(
    `SELECT id, tenant_id, scope_type, scope_id, status, granted_at, granted_by
     FROM tenant_entitlements
     ${where}
     ORDER BY scope_type ASC, scope_id ASC`,
    [tenantId],
  );

  return result.rows.map((r) => ({
    id: r.id,
    tenant_id: r.tenant_id,
    scope_type: r.scope_type as EntitlementScopeType,
    scope_id: r.scope_id,
    status: r.status as 'active' | 'revoked',
    granted_at: r.granted_at instanceof Date ? r.granted_at.toISOString() : String(r.granted_at),
    granted_by: r.granted_by,
  }));
}

// ---------------------------------------------------------------------------
// B2 — publish-time entitlement enforcement helpers
// All three functions run inside the caller's existing withTenant transaction
// (assessiq_app + app.current_tenant set). RLS SELECT policies apply:
//   - tenant_plans:       tenant_isolation_select (own row only)
//   - question_packs:     tenant_isolation         (own rows only)
//   - tenant_entitlements: tenant_isolation_select  (own rows only)
// No system role is needed — these are read-only lookups in the tenant's own
// data. The defense-in-depth tenant_id=$1 on listActiveEntitlements mirrors
// the existing listEntitlements pattern.
// ---------------------------------------------------------------------------

/**
 * Fetch the billing tier for a tenant.
 *
 * Returns the tier string (e.g. 'free'|'pro'|'enterprise'|'internal') or null
 * if no tenant_plans row exists. null means "no plan" — callers treat this as
 * fail-closed (NOT a bypass).
 *
 * Runs under the caller's withTenant tx (RLS SELECT policy scopes to own row).
 */
export async function getTenantTier(
  client: PoolClient,
  tenantId: string,
): Promise<string | null> {
  const result = await client.query<{ tier: string }>(
    `SELECT tier FROM tenant_plans WHERE tenant_id = $1`,
    [tenantId],
  );
  return result.rows[0]?.tier ?? null;
}

/**
 * Fetch the domain TEXT field for a question pack.
 *
 * Returns the domain string or null if no pack row is found (FK gap, wrong
 * tenant, or pack archived/not visible). null means "domain unknown" — the
 * entitlement check continues (pack_id scope can still match); callers do NOT
 * throw solely because domain is null.
 *
 * Runs under the caller's withTenant tx (RLS scopes to own packs).
 */
export async function getPackDomain(
  client: PoolClient,
  packId: string,
): Promise<string | null> {
  const result = await client.query<{ domain: string }>(
    `SELECT domain FROM question_packs WHERE id = $1`,
    [packId],
  );
  return result.rows[0]?.domain ?? null;
}

/**
 * List active entitlements for a tenant.
 *
 * Returns scope_type + scope_id for every status='active' row. The explicit
 * tenant_id=$1 filter is defense-in-depth (RLS already scopes to the current
 * tenant, but a double filter mirrors the B1 listEntitlements pattern and
 * guards against any future RLS misconfiguration).
 *
 * Runs under the caller's withTenant tx.
 */
export async function listActiveEntitlements(
  client: PoolClient,
  tenantId: string,
): Promise<Array<{ scope_type: string; scope_id: string }>> {
  const result = await client.query<{ scope_type: string; scope_id: string }>(
    `SELECT scope_type, scope_id
     FROM tenant_entitlements
     WHERE status = 'active'
       AND tenant_id = $1`,
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
