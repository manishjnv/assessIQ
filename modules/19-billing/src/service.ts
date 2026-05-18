// AssessIQ — modules/19-billing/src/service.ts
//
// Business logic layer for usage metering and plan management.
// Pure-function helpers (computeUsage) are DB-free and unit-testable.

import type { PoolClient } from 'pg';
import { withTenant, getPool } from '@assessiq/tenancy';
import { streamLogger, NotFoundError, ValidationError, AppError } from '@assessiq/core';
import { auditInTx } from '@assessiq/audit-log';
import {
  insertBillingEvent,
  insertDefaultFreePlan,
  getPlan,
  countBillingEvents,
  getAllTenantUsageRaw,
  getTenantPlanRow,
  countTenantBillingEvents,
  getRecentBillingEvents,
  getAllBillingEventsForExport,
  updateTenantPlanRow,
  insertEntitlement,
  revokeEntitlement as revokeEntitlementRow,
  listEntitlements,
  getTenantTier,
  getPackDomain,
  listActiveEntitlements,
  getTenantContentScopes,
} from './repository.js';
import type {
  BillingUsage,
  PlanTier,
  UsageStatus,
  TenantUsageRow,
  TenantBillingDetail,
  UpdateTenantPlanPatch,
  UpdateTenantPlanResult,
  TenantEntitlement,
  EntitlementScopeType,
  GrantEntitlementInput,
} from './types.js';

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

// ---------------------------------------------------------------------------
// A2 — system-role transaction helper
// Mirrors the pattern in apps/api/src/routes/admin-super.ts:289-326.
// Caller must use this for all cross-tenant billing reads/writes so they
// operate under assessiq_system (BYPASSRLS).
// ---------------------------------------------------------------------------

/**
 * Open a pool client, BEGIN, SET LOCAL ROLE assessiq_system, run fn, COMMIT.
 * On error: ROLLBACK (swallow rollback error) + rethrow. Always release.
 *
 * Mirrors admin-super.ts GET /tenants transaction shape exactly.
 */
async function withSystemTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE assessiq_system');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// A2 — cross-tenant usage (super-admin)
// ---------------------------------------------------------------------------

/**
 * Fetch a usage summary for ALL tenants (super-admin).
 *
 * Runs under assessiq_system (BYPASSRLS) via withSystemTx.
 */
export async function getAllTenantUsage(): Promise<TenantUsageRow[]> {
  return withSystemTx(async (client) => {
    const rows = await getAllTenantUsageRaw(client);
    return rows.map((r) => {
      const tier = r.tier as PlanTier;
      const { remaining, overage, status } = computeUsage(tier, r.included_credits, r.used);
      return {
        tenant_id: r.tenant_id,
        tier,
        included_credits: r.included_credits,
        used: r.used,
        remaining,
        overage,
        status,
      };
    });
  });
}

/**
 * Fetch the full billing detail for a single tenant (super-admin billing drawer).
 *
 * Throws NotFoundError if no plan row exists for the tenant.
 */
export async function getTenantBillingDetail(tenantId: string): Promise<TenantBillingDetail> {
  return withSystemTx(async (client) => {
    const plan = await getTenantPlanRow(client, tenantId);
    if (plan === null) {
      throw new NotFoundError(`No billing plan found for tenant ${tenantId}`, {
        details: { code: 'PLAN_NOT_FOUND', tenantId },
      });
    }

    const used = await countTenantBillingEvents(client, tenantId);
    const recentEvents = await getRecentBillingEvents(client, tenantId);

    const tier = plan.tier as PlanTier;
    const { remaining, overage, status } = computeUsage(tier, plan.included_credits, used);

    return {
      tenant_id: tenantId,
      tier,
      included_credits: plan.included_credits,
      status: plan.status as 'active' | 'suspended',
      cycle_start: plan.cycle_start instanceof Date
        ? plan.cycle_start.toISOString()
        : String(plan.cycle_start),
      used,
      remaining,
      overage,
      usage_status: status,
      recent_events: recentEvents,
    };
  });
}

/**
 * Generate a CSV export of all billing events for a tenant.
 *
 * Returns a RFC4180-safe CSV string (header + rows). Values are UUIDs/enums/
 * timestamps — no embedded commas or quotes expected, but all fields are
 * quote-wrapped defensively for correctness.
 */
export async function getTenantBillingEventsCsv(tenantId: string): Promise<string> {
  const events = await withSystemTx((client) =>
    getAllBillingEventsForExport(client, tenantId),
  );

  const escape = (v: string): string => `"${v.replace(/"/g, '""')}"`;

  const header = 'id,attempt_id,event_type,occurred_at';
  const lines = events.map((e) =>
    [
      escape(e.id),
      escape(e.attempt_id),
      escape(e.event_type),
      escape(e.occurred_at instanceof Date ? e.occurred_at.toISOString() : String(e.occurred_at)),
    ].join(','),
  );

  return [header, ...lines].join('\r\n');
}

// ---------------------------------------------------------------------------
// A2 — plan mutation (super-admin)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// B1 — entitlement service
// All mutations use the EXACT two-role same-tx pattern from updateTenantPlan:
//   own client → BEGIN → SET LOCAL ROLE assessiq_system (BYPASSRLS write)
//   → mutate row → SET LOCAL ROLE assessiq_app + set_config(current_tenant)
//   → auditInTx → COMMIT. Same tx = mutation + audit are atomic.
// ---------------------------------------------------------------------------

const VALID_SCOPE_TYPES: ReadonlySet<string> = new Set(['domain', 'pack']);

/**
 * Grant a scope entitlement to a tenant.
 *
 * Idempotent: granting an already-active entitlement updates granted_at/by.
 * Re-granting a previously-revoked entitlement reactivates it.
 *
 * Throws ValidationError (INVALID_SCOPE) if scopeType is not 'domain'|'pack'
 * or if scopeId is an empty string.
 */
export async function grantEntitlement(
  actorUserId: string,
  tenantId: string,
  input: GrantEntitlementInput,
): Promise<{ tenant_id: string; scope_type: EntitlementScopeType; scope_id: string; status: 'active'; auditId: string }> {
  if (!VALID_SCOPE_TYPES.has(input.scopeType)) {
    throw new ValidationError(
      `scopeType must be one of domain|pack`,
      { details: { code: 'INVALID_SCOPE', received: input.scopeType } },
    );
  }
  if (
    typeof input.scopeId !== 'string' ||
    input.scopeId.trim().length === 0 ||
    input.scopeId.trim().length > 256
  ) {
    throw new ValidationError(
      `scopeId must be a non-empty string of at most 256 characters`,
      { details: { code: 'INVALID_SCOPE', received: input.scopeId } },
    );
  }

  const scopeType = input.scopeType as EntitlementScopeType;
  const scopeId = input.scopeId.trim();

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Phase A — system role: tenant_entitlements has no UPDATE/DELETE RLS
    // policy, so INSERT/UPDATE require BYPASSRLS (assessiq_system).
    await client.query('SET LOCAL ROLE assessiq_system');

    const { id: entitlementId } = await insertEntitlement(client, tenantId, scopeType, scopeId, actorUserId);

    // Phase B — app role + tenant GUC: put auditInTx in the context its
    // contract requires. Same transaction → mutation + audit are atomic.
    await client.query('SET LOCAL ROLE assessiq_app');
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);

    const auditRow = await auditInTx(client, {
      action: 'tenant.entitlement_granted',
      actorKind: 'user',
      actorUserId,
      tenantId,
      entityType: 'tenant_entitlement',
      entityId: tenantId,
      after: { scope_type: scopeType, scope_id: scopeId, status: 'active', entitlement_id: entitlementId },
    });

    await client.query('COMMIT');

    return { tenant_id: tenantId, scope_type: scopeType, scope_id: scopeId, status: 'active', auditId: auditRow.id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Revoke an active scope entitlement from a tenant.
 *
 * Throws NotFoundError (ENTITLEMENT_NOT_FOUND) if no active entitlement
 * exists for the given tenant + scope. In that case NO audit row is written
 * and NO row is changed — no-op must not produce an audit trail.
 *
 * Throws ValidationError (INVALID_SCOPE) on bad input.
 */
export async function revokeEntitlement(
  actorUserId: string,
  tenantId: string,
  input: GrantEntitlementInput,
): Promise<{ tenant_id: string; scope_type: EntitlementScopeType; scope_id: string; status: 'revoked'; auditId: string }> {
  if (!VALID_SCOPE_TYPES.has(input.scopeType)) {
    throw new ValidationError(
      `scopeType must be one of domain|pack`,
      { details: { code: 'INVALID_SCOPE', received: input.scopeType } },
    );
  }
  if (
    typeof input.scopeId !== 'string' ||
    input.scopeId.trim().length === 0 ||
    input.scopeId.trim().length > 256
  ) {
    throw new ValidationError(
      `scopeId must be a non-empty string of at most 256 characters`,
      { details: { code: 'INVALID_SCOPE', received: input.scopeId } },
    );
  }

  const scopeType = input.scopeType as EntitlementScopeType;
  const scopeId = input.scopeId.trim();

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Phase A — system role: BYPASSRLS required for the UPDATE.
    await client.query('SET LOCAL ROLE assessiq_system');

    const revoked = await revokeEntitlementRow(client, tenantId, scopeType, scopeId, actorUserId);

    if (revoked === null) {
      // Nothing was active to revoke — throw BEFORE writing any audit row.
      // ROLLBACK here is a no-op (no writes yet) but keeps the pattern clean.
      await client.query('ROLLBACK');
      throw new NotFoundError(
        `No active entitlement found for tenant ${tenantId} scope ${scopeType}:${scopeId}`,
        { details: { code: 'ENTITLEMENT_NOT_FOUND', tenantId, scopeType, scopeId } },
      );
    }

    // Phase B — app role + tenant GUC: auditInTx in its required context.
    await client.query('SET LOCAL ROLE assessiq_app');
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);

    const auditRow = await auditInTx(client, {
      action: 'tenant.entitlement_revoked',
      actorKind: 'user',
      actorUserId,
      tenantId,
      entityType: 'tenant_entitlement',
      entityId: tenantId,
      after: { scope_type: scopeType, scope_id: scopeId, status: 'revoked', entitlement_id: revoked.id },
    });

    await client.query('COMMIT');

    return { tenant_id: tenantId, scope_type: scopeType, scope_id: scopeId, status: 'revoked', auditId: auditRow.id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * List all entitlements for a tenant (super-admin path).
 *
 * Uses withSystemTx (assessiq_system / BYPASSRLS) to read across tenant
 * boundaries without needing app.current_tenant set. Returns all statuses
 * (active + revoked) so the super-admin UI can show history.
 */
export async function listTenantEntitlements(tenantId: string): Promise<TenantEntitlement[]> {
  return withSystemTx((client) => listEntitlements(client, tenantId));
}

/**
 * List the distinct content scopes (domains + packs) visible for a tenant.
 *
 * Used by the super-admin billing drawer to populate the Grant scope_id
 * dropdown instead of a free-text input. Runs under assessiq_system
 * (BYPASSRLS) via withSystemTx — same cross-tenant read pattern as
 * listTenantEntitlements.
 */
export async function listTenantContentScopes(
  tenantId: string,
): Promise<{ domains: string[]; packs: Array<{ id: string; name: string; domain: string }> }> {
  return withSystemTx((client) => getTenantContentScopes(client, tenantId));
}

// ---------------------------------------------------------------------------
// B2 — server-authoritative publish-time entitlement enforcement
// ---------------------------------------------------------------------------

/**
 * Assert that the assessment's question pack is entitled for the tenant.
 *
 * This is the SERVER-AUTHORITATIVE publish-time entitlement gate (B2).
 * It MUST be called on every transition into status='published':
 *   - publishAssessment  (draft → published)
 *   - reopenAssessment   (closed → published)
 *
 * CONTRACT (locked B1↔B2 spec):
 *   A pack is entitled iff its pack_id ∈ active tenant_entitlements with
 *   scope_type='pack' OR its domain (question_packs.domain TEXT) ∈ active
 *   tenant_entitlements with scope_type='domain'.
 *
 * BYPASS: tier === 'internal' → return immediately (operator tenants are
 *   exempt from entitlement checks). This is the ONLY bypass. A missing
 *   tenant_plans row (tier === null) does NOT bypass — fail-closed ensures a
 *   planless tenant cannot publish (data-integrity gap must be surfaced, not
 *   silently allowed).
 *
 * TRANSACTION: runs inside the caller's existing withTenant() tx. All three
 *   repo reads (getTenantTier, getPackDomain, listActiveEntitlements) run under
 *   assessiq_app + app.current_tenant, so RLS SELECT policies apply and scope
 *   every read to the calling tenant's own rows. No new tx or role switch needed.
 *
 * THROWS: AppError(msg, 'NOT_ENTITLED', 403, { details: { code, pack_id, domain } })
 *   if the pack is not entitled.
 */
export async function assertPublishEntitled(
  client: PoolClient,
  tenantId: string,
  packId: string,
): Promise<void> {
  // Step 1 — tier check: internal tenants bypass entitlement enforcement.
  // null tier = no plan row = NOT a bypass (fail-closed).
  const tier = await getTenantTier(client, tenantId);
  if (tier === 'internal') {
    return;
  }

  // Step 2 — look up the pack's domain (may be null if pack not found or
  // not visible under RLS). A null domain means "no domain match possible"
  // but does NOT fail the check on its own — the pack_id scope may still match.
  const domain = await getPackDomain(client, packId);

  // Step 3 — fetch all active entitlements for the tenant.
  const ents = await listActiveEntitlements(client, tenantId);

  // Step 4 — OR rule: entitled if ANY active entitlement matches pack_id
  // (scope_type='pack') OR matches domain (scope_type='domain', domain non-null).
  const entitled = ents.some(
    (e) =>
      (e.scope_type === 'pack' && e.scope_id === packId) ||
      (e.scope_type === 'domain' && domain !== null && e.scope_id === domain),
  );

  if (!entitled) {
    throw new AppError(
      `This assessment's question pack is not entitled for your plan (pack ${packId}${domain ? `, domain ${domain}` : ''}). Contact your platform operator to enable it.`,
      'NOT_ENTITLED',
      403,
      { details: { code: 'NOT_ENTITLED', pack_id: packId, domain } },
    );
  }
}

/**
 * List active entitlements for the authenticated tenant's own context
 * (company-admin path).
 *
 * Uses withTenant(tenantId) so RLS is fully enforced — the SELECT policy on
 * tenant_entitlements limits rows to the current tenant. Returns only
 * status='active' rows (activeOnly: true) since company admins have no need
 * to see revoked history.
 */
export async function getCompanyEntitlements(tenantId: string): Promise<TenantEntitlement[]> {
  return withTenant(tenantId, (c) => listEntitlements(c, tenantId, { activeOnly: true }));
}

const VALID_TIERS: ReadonlySet<string> = new Set(['free', 'pro', 'enterprise', 'internal']);

/**
 * Update a tenant's billing plan (tier + included_credits).
 *
 * Validation rules:
 *   - tier must be one of free|pro|enterprise|internal
 *   - includedCredits must be null or integer >= 0
 *   - tier === 'internal' ⇒ credits are unlimited (null). If the caller omits
 *     includedCredits while switching to internal, it is coerced to null
 *     (internal is definitionally unlimited — don't force the caller to send
 *     an explicit null just to change tier). An EXPLICIT non-null
 *     includedCredits together with tier==='internal' is a contradiction → 400.
 *   - tier !== 'internal' ⇒ credits must NOT be null (a finite tier needs a
 *     finite allowance; there is no sensible default, so the caller must set it).
 *
 * TWO-ROLE TRANSACTION (deliberately NOT the generic withSystemTx):
 *   `tenant_plans` has SELECT+INSERT RLS policies only — NO UPDATE policy by
 *   A1 design — so the UPDATE itself MUST run under assessiq_system (BYPASSRLS).
 *   But `auditInTx` writes audit_log, whose INSERT RLS policy is
 *   `tenant_id = current_setting('app.current_tenant')` and whose documented
 *   contract (modules/14-audit-log/src/audit.ts) requires the caller to be
 *   under assessiq_app + app.current_tenant — exactly how the reviewed
 *   precedent `updateAiGenerateMode` (@assessiq/tenancy) calls it. So within
 *   ONE transaction we: (a) SET LOCAL ROLE assessiq_system for the lock+UPDATE,
 *   then (b) SET LOCAL ROLE assessiq_app + set_config('app.current_tenant')
 *   for auditInTx. Same tx ⇒ UPDATE+audit stay atomic; the audit row is
 *   written in exactly the role/GUC context audit.ts mandates (so it survives
 *   a future assessiq_system BYPASSRLS downgrade and matches the precedent).
 */
export async function updateTenantPlan(
  actorUserId: string,
  tenantId: string,
  patch: UpdateTenantPlanPatch,
): Promise<UpdateTenantPlanResult> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Phase A — system role: tenant_plans has no UPDATE RLS policy (A1),
    // so the lock + UPDATE require BYPASSRLS.
    await client.query('SET LOCAL ROLE assessiq_system');

    // 1. Lock the row
    const planRow = await getTenantPlanRow(client, tenantId, true);
    if (planRow === null) {
      throw new NotFoundError(`No billing plan found for tenant ${tenantId}`, {
        details: { code: 'PLAN_NOT_FOUND', tenantId },
      });
    }

    const prevTier = planRow.tier as PlanTier;
    const prevCredits = planRow.included_credits;

    // 2. Compute next values
    const nextTier: PlanTier = (patch.tier !== undefined ? patch.tier : prevTier);
    let nextCredits: number | null =
      'includedCredits' in patch ? (patch.includedCredits ?? null) : prevCredits;

    // internal is definitionally unlimited: coerce omitted credits to null on
    // the transition to internal so `{ tier: 'internal' }` alone works. An
    // EXPLICIT non-null includedCredits with internal still falls through to
    // the contradiction check below (kept as a 400 — operator-mistake guard).
    if (nextTier === 'internal' && !('includedCredits' in patch)) {
      nextCredits = null;
    }

    // 3. Validate
    if (!VALID_TIERS.has(nextTier)) {
      throw new ValidationError(`tier must be one of free|pro|enterprise|internal`, {
        details: { code: 'INVALID_TIER', received: nextTier },
      });
    }
    if (nextCredits !== null && (!Number.isInteger(nextCredits) || nextCredits < 0)) {
      throw new ValidationError(
        `includedCredits must be null or a non-negative integer`,
        { details: { code: 'INVALID_CREDITS', received: nextCredits } },
      );
    }
    if (nextTier === 'internal' && nextCredits !== null) {
      throw new ValidationError(
        `internal tier requires includedCredits to be null (unlimited)`,
        { details: { code: 'INTERNAL_REQUIRES_NULL_CREDITS' } },
      );
    }
    if (nextTier !== 'internal' && nextCredits === null) {
      throw new ValidationError(
        `non-internal tiers require a finite includedCredits value`,
        { details: { code: 'FINITE_TIER_REQUIRES_CREDITS' } },
      );
    }

    // 4. UPDATE (still under assessiq_system)
    const { updated_at } = await updateTenantPlanRow(client, tenantId, nextTier, nextCredits);

    // Phase B — app role + tenant GUC: put auditInTx in exactly the context
    // its contract (audit.ts) and the reviewed updateAiGenerateMode precedent
    // require. Same transaction ⇒ the UPDATE above and this audit are atomic.
    await client.query('SET LOCAL ROLE assessiq_app');
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);

    // 5. Audit (same tx — atomicity invariant; rollback reverts the UPDATE)
    const auditRow = await auditInTx(client, {
      action: 'tenant.plan_updated',
      actorKind: 'user',
      actorUserId,
      tenantId,
      entityType: 'tenant_plan',
      entityId: tenantId,
      after: {
        tier: nextTier,
        included_credits: nextCredits,
        previous_tier: prevTier,
        previous_included_credits: prevCredits,
      },
    });

    await client.query('COMMIT');

    return {
      tenant_id: tenantId,
      tier: nextTier,
      included_credits: nextCredits,
      previous: { tier: prevTier, included_credits: prevCredits },
      updatedAt: updated_at instanceof Date ? updated_at.toISOString() : String(updated_at),
      auditId: auditRow.id,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
