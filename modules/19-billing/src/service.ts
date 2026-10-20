// AssessIQ — modules/19-billing/src/service.ts
//
// Business logic layer for usage metering and plan management.
// Pure-function helpers (computeUsage) are DB-free and unit-testable.

import type { PoolClient } from 'pg';
import { withTenant, withSystemRole } from '@assessiq/tenancy';
import { streamLogger, NotFoundError, ValidationError, AppError, config } from '@assessiq/core';
import { auditInTx } from '@assessiq/audit-log';
import {
  insertBillingEvent,
  insertAiAnswerEvent,
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
  countCandidatesEver,
  recordCandidateCounted,
  countAiAttemptsEver,
  getPackEntitlementInfo,
  listActiveEntitlements,
  getTenantContentScopes,
  getPlatformTenantId,
  listAvailablePlatformSets,
  findClonesBySource,
} from './repository.js';
import {
  burnCredits,
  readCreditBalance,
  insertCreditGrant,
  insertFreeMonthlyGrant,
  refillFreeMonthlyAll,
  expireCreditGrants,
  listGrantsAndBurns,
  listLowBalanceCandidates,
  insertLowBalanceNotices,
  listTenantAdminEmails,
} from './credit-repository.js';
import { GRANT_VALIDITY_MONTHS, LOW_BALANCE_LEVELS } from './burn-rates.js';
import type {
  CreditBalance,
  CreditGrantView,
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
  AvailableSet,
} from './types.js';

const log = streamLogger('billing');

/** Default credit allowance for newly-provisioned free-tier tenants. */
export const DEFAULT_FREE_CREDITS = 250;

/**
 * FU-A9 (2026-10-06): AI-evaluated answers included per month, from the tier
 * table in docs/plans/PRICING_TIERS_2026-10-06.md (Starter 20, Growth 500,
 * Enterprise custom = no cap recorded, internal unlimited). A constant, not a
 * column: the tier contents live in that doc; a per-tenant override is FU-A7
 * territory (contract terms) and is not built.
 */
export const TIER_AI_ANSWERS_INCLUDED: Record<PlanTier, number | null> = {
  free: 20,
  pro: 500,
  enterprise: null,
  internal: null,
};

/**
 * FU-A2: start of the current monthly window for a cycle_start anchor.
 * Mirrors the SQL in repository.ts (cycle_start + whole months elapsed, month
 * end clamped like Postgres). PURE — unit-tested in compute-usage.test.ts.
 */
export function cycleWindowStart(cycleStart: Date, now: Date = new Date()): Date {
  const addMonths = (d: Date, n: number): Date => {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + n;
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  };
  let n = 0;
  if (now.getTime() < cycleStart.getTime()) return cycleStart;
  while (addMonths(cycleStart, n + 1).getTime() <= now.getTime()) n++;
  return addMonths(cycleStart, n);
}

/**
 * FU-A4: record one "AI-evaluated answer" event. Called by 07 admin-accept in
 * the SAME transaction as the gradings insert (one row per accepted AI grading;
 * re-accepts are idempotent). Same no-try/catch rule as recordGradedAttempt:
 * any db error rolls the accept back with it.
 */
export async function recordAiAnswerEvaluated(
  client: PoolClient,
  tenantId: string,
  attemptId: string,
  questionId: string,
): Promise<void> {
  await insertAiAnswerEvent(client, tenantId, attemptId, questionId);
}

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
  // Z-93: burn ledger credits in the SAME tx. Never throws on a low balance.
  await burnCredits(client, tenantId, attemptId);
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
  await withTenant(tenantId, (c) => provisionDefaultPlanInTx(c, tenantId, includedCredits));
}

/**
 * Client-taking inner step of provisionDefaultPlan (same two inserts, same order, no
 * behaviour change). Z-71 self-serve sign-up calls it on its own system-role client so the
 * Free plan and the monthly credit grant commit or roll back with the new tenant.
 */
export async function provisionDefaultPlanInTx(
  client: PoolClient,
  tenantId: string,
  includedCredits = DEFAULT_FREE_CREDITS,
): Promise<void> {
  await insertDefaultFreePlan(client, tenantId, includedCredits);
  await insertFreeMonthlyGrant(client, tenantId);
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
    const meters = await countBillingEvents(c, tenantId);
    const used = meters.used;

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

    const aiIncluded = plan?.ai_answers_included_override ?? TIER_AI_ANSWERS_INCLUDED[tier];
    return {
      tier,
      tier_limits: TIER_LIMITS[tier],
      tiers_enforced: config.PLAN_TIERS_ENFORCED,
      included_credits: includedCredits,
      used,
      remaining,
      overage,
      status,
      cycle_window_start:
        meters.cycle_window_start instanceof Date ? meters.cycle_window_start.toISOString() : null,
      ai_answers_used: meters.ai_used,
      ai_answers_included: aiIncluded,
      ai_answers_remaining: aiIncluded === null ? null : aiIncluded - meters.ai_used,
      credits: await readCreditBalance(c, tenantId, meters.ai_used, plan !== null && includedCredits === null),
    } satisfies BillingUsage;
  });
}

// ---------------------------------------------------------------------------
// A2 — system-role transaction helper
// Mirrors the pattern in apps/api/src/routes/admin-super.ts:289-326.
// Caller must use this for all cross-tenant billing reads/writes so they
// operate under assessiq_system (BYPASSRLS).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// A2 — cross-tenant usage (super-admin)
// ---------------------------------------------------------------------------

/**
 * Fetch a usage summary for ALL tenants (super-admin).
 *
 * Runs under assessiq_system (BYPASSRLS) via withSystemRole.
 */
export async function getAllTenantUsage(): Promise<TenantUsageRow[]> {
  return withSystemRole("cross-tenant usage summary (super-admin)", async (client) => {
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
        ai_answers_used: r.ai_used,
        ai_answers_included: TIER_AI_ANSWERS_INCLUDED[tier],
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
  return withSystemRole("cross-tenant billing detail (super-admin)", async (client) => {
    const plan = await getTenantPlanRow(client, tenantId);
    if (plan === null) {
      throw new NotFoundError(`No billing plan found for organisation ${tenantId}`, {
        details: { code: 'PLAN_NOT_FOUND', tenantId },
      });
    }

    const meters = await countTenantBillingEvents(client, tenantId);
    const used = meters.used;
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
      cycle_window_start:
        meters.cycle_window_start instanceof Date ? meters.cycle_window_start.toISOString() : null,
      used,
      remaining,
      overage,
      usage_status: status,
      ai_answers_used: meters.ai_used,
      ai_answers_included: plan.ai_answers_included_override ?? TIER_AI_ANSWERS_INCLUDED[tier],
      recent_events: recentEvents,
    };
  });
}

/** Always-quoted CSV cell with the formula-injection guard (RV77): a leading = + - @ tab CR gets an apostrophe. */
export function csvQuote(v: string): string {
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Generate a CSV export of all billing events for a tenant.
 *
 * Returns a RFC4180-safe CSV string (header + rows). Values are UUIDs/enums/
 * timestamps — no embedded commas or quotes expected, but all fields are
 * quote-wrapped defensively for correctness.
 */
export async function getTenantBillingEventsCsv(tenantId: string): Promise<string> {
  const events = await withSystemRole("cross-tenant billing events export (super-admin)", (client) =>
    getAllBillingEventsForExport(client, tenantId),
  );

  const escape = csvQuote;

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
  // Domain scope_ids are canonical lowercase slugs (matching the `domains`
  // table and platform pack.domain, which the licensing catalog compares by
  // exact string). Normalize to lowercase so grants/revokes always align with
  // the canonical slug and an API caller can't drift to 'SOC'-style values that
  // silently match no platform set. Pack scope_ids are UUIDs — left as-is.
  const scopeId =
    scopeType === 'domain' ? input.scopeId.trim().toLowerCase() : input.scopeId.trim();

  return withSystemRole("tenant entitlement grant", async (client) => {
    // Phase A — system role: tenant_entitlements has no UPDATE/DELETE RLS
    // policy, so INSERT/UPDATE require BYPASSRLS (assessiq_system).

    const { id: entitlementId } = await insertEntitlement(client, tenantId, scopeType, scopeId, actorUserId);

    // Phase B — app role + tenant GUC: put auditInTx in the context its
    // contract requires. Same transaction → mutation + audit are atomic.
    // system read, then tenant-scoped write under assessiq_app in the same tx
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

    return { tenant_id: tenantId, scope_type: scopeType, scope_id: scopeId, status: 'active', auditId: auditRow.id };
  });
}

/**
 * Revoke an active scope entitlement from a tenant.
 *
 * Throws NotFoundError (ENTITLEMENT_NOT_FOUND) if no active entitlement
 * exists for the given tenant + scope. In that case NO audit row is written
 * and NO row is changed — no-op must not produce an audit trail.
 *
 * Also archives the tenant's cloned packs of the scope (same tx). Re-grant does
 * NOT un-archive them. Throws ValidationError (INVALID_SCOPE) on bad input.
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
  // Domain scope_ids are canonical lowercase slugs (matching the `domains`
  // table and platform pack.domain, which the licensing catalog compares by
  // exact string). Normalize to lowercase so grants/revokes always align with
  // the canonical slug and an API caller can't drift to 'SOC'-style values that
  // silently match no platform set. Pack scope_ids are UUIDs — left as-is.
  const scopeId =
    scopeType === 'domain' ? input.scopeId.trim().toLowerCase() : input.scopeId.trim();

  return withSystemRole("tenant entitlement revoke", async (client) => {
    // Phase A — system role: BYPASSRLS required for the UPDATE.

    const revoked = await revokeEntitlementRow(client, tenantId, scopeType, scopeId, actorUserId);

    if (revoked === null) {
      // Nothing was active to revoke — throw BEFORE writing any audit row
      // (withSystemRole rolls back on throw).
      throw new NotFoundError(
        `No active entitlement found for organisation ${tenantId} scope ${scopeType}:${scopeId}`,
        { details: { code: 'ENTITLEMENT_NOT_FOUND', tenantId, scopeType, scopeId } },
      );
    }

    // Archive the tenant's clones of this scope in the SAME tx (clone-on-grant
    // design, Phase 4 revoke). Runs under system role (cross-row UPDATE with a
    // join to the platform source pack). Never deletes content; attempts
    // snapshot their questions so in-flight attempts are unaffected.
    // ponytail: SQL lives here, not in 04 clone.ts — 19 does not depend on 04.
    const archived = (
      await client.query<{ id: string; source_pack_id: string }>(
        `UPDATE question_packs c
            SET status = 'archived', updated_at = now()
           FROM question_packs s
          WHERE c.tenant_id = $1 AND c.status <> 'archived'
            AND s.id = c.source_pack_id
            AND (($2::text = 'domain' AND s.domain = $3::text)
              OR ($2::text = 'pack' AND (s.id::text = $3::text OR c.id::text = $3::text)))
          RETURNING c.id, c.source_pack_id`,
        [tenantId, scopeType, scopeId],
      )
    ).rows;

    // Phase B — app role + tenant GUC: auditInTx in its required context.
    // system read, then tenant-scoped write under assessiq_app in the same tx
    await client.query('SET LOCAL ROLE assessiq_app');
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);

    if (archived.length > 0) {
      await auditInTx(client, {
        action: 'tenant.pack_clone_archived',
        actorKind: 'user',
        actorUserId,
        tenantId,
        entityType: 'tenant_entitlement',
        entityId: tenantId,
        after: {
          scope_type: scopeType,
          scope_id: scopeId,
          source_pack_ids: [...new Set(archived.map((r) => r.source_pack_id))],
          archived_clone_ids: archived.map((r) => r.id),
          archived_count: archived.length,
        },
      });
    }

    const auditRow = await auditInTx(client, {
      action: 'tenant.entitlement_revoked',
      actorKind: 'user',
      actorUserId,
      tenantId,
      entityType: 'tenant_entitlement',
      entityId: tenantId,
      after: { scope_type: scopeType, scope_id: scopeId, status: 'revoked', entitlement_id: revoked.id },
    });

    return { tenant_id: tenantId, scope_type: scopeType, scope_id: scopeId, status: 'revoked', auditId: auditRow.id };
  });
}

/**
 * List all entitlements for a tenant (super-admin path).
 *
 * Uses withSystemRole (assessiq_system / BYPASSRLS) to read across tenant
 * boundaries without needing app.current_tenant set. Returns all statuses
 * (active + revoked) so the super-admin UI can show history.
 */
export async function listTenantEntitlements(tenantId: string): Promise<TenantEntitlement[]> {
  return withSystemRole("cross-tenant entitlement list (super-admin)", (client) => listEntitlements(client, tenantId));
}

/**
 * List the grantable content scopes (domains + packs) for the super-admin
 * billing drawer, for granting to `tenantId`.
 *
 * The grantable catalog is the PLATFORM library (shared, same for every
 * tenant) — canonical domain slugs + published platform sets — NOT the target
 * tenant's own packs. Reading the target tenant's packs (the prior behavior)
 * leaked non-canonical free-text domains like 'SOC' into the dropdown that
 * never matched the lowercase platform slugs at license-resolution time.
 *
 * Scopes already granted (active) to this tenant are filtered out so the drawer
 * only offers new grants. Runs under assessiq_system (BYPASSRLS) via
 * withSystemRole — same cross-tenant read pattern as listTenantEntitlements.
 */
export async function listTenantContentScopes(
  tenantId: string,
): Promise<{ domains: string[]; packs: Array<{ id: string; name: string; domain: string }> }> {
  return withSystemRole("platform content scopes read for entitlement grants", async (client) => {
    const platformTenantId = await getPlatformTenantId(client);
    if (platformTenantId === null) return { domains: [], packs: [] };

    const catalog = await getTenantContentScopes(client, platformTenantId);

    const active = await listEntitlements(client, tenantId, { activeOnly: true });
    const grantedDomains = new Set(
      active.filter((e) => e.scope_type === 'domain').map((e) => e.scope_id),
    );
    const grantedPacks = new Set(
      active.filter((e) => e.scope_type === 'pack').map((e) => e.scope_id),
    );
    return {
      domains: catalog.domains.filter((d) => !grantedDomains.has(d)),
      packs: catalog.packs.filter((p) => !grantedPacks.has(p.id)),
    };
  });
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

  // Step 2 — look up the pack's domain + clone lineage (both may be null if the
  // pack row isn't visible under RLS). A null domain just means "no domain match
  // possible"; a pack_id / source_pack_id scope may still match.
  const { domain, source_pack_id: sourcePackId } = await getPackEntitlementInfo(client, packId);

  // Step 3 — fetch all active entitlements for the tenant.
  const ents = await listActiveEntitlements(client, tenantId);

  // Step 4 — OR rule: entitled if ANY active entitlement matches
  //   - scope_type='pack' on this pack id OR its source_pack_id — the clone-on-use
  //     lineage: a pack license granted on the SOURCE platform pack covers the
  //     clone the company materialised from it (clone.source_pack_id = source).
  //     source_pack_id is only ever written by the system-role clone engine, so
  //     it cannot be forged by a tenant to bypass this gate; OR
  //   - scope_type='domain' on the pack's domain (non-null).
  const entitled = ents.some(
    (e) =>
      (e.scope_type === 'pack' &&
        (e.scope_id === packId || (sourcePackId !== null && e.scope_id === sourcePackId))) ||
      (e.scope_type === 'domain' && domain !== null && e.scope_id === domain),
  );

  if (!entitled) {
    throw new AppError(
      `This assessment's question set is not entitled for your plan (question set ${packId}${domain ? `, subject ${domain}` : ''}). Contact your platform operator to enable it.`,
      'NOT_ENTITLED',
      403,
      { details: { code: 'NOT_ENTITLED', pack_id: packId, domain } },
    );
  }
}

/**
 * Step 2 — assert a tenant is licensed for a SOURCE platform-library pack
 * BEFORE clone-on-use materialises it.
 *
 * Distinct from assertPublishEntitled: that gate checks the company's OWN
 * (cloned) pack at publish time; THIS check runs at assessment-creation time
 * against the platform SOURCE pack, before any clone exists. Runs under
 * assessiq_system (BYPASSRLS) because it reads the platform tenant's pack while
 * resolving the calling tenant's licenses.
 *
 * Licensed iff tier='internal' (bypass) OR an active entitlement matches the
 * source pack id (scope_type='pack') OR the source pack's domain
 * (scope_type='domain'). This is a UX/early gate; the AUTHORITATIVE control
 * remains assertPublishEntitled at publish time (so a license revoked between
 * clone-on-use and publish still blocks the assessment from going live).
 *
 * THROWS AppError('NOT_LICENSED', 403) when not licensed.
 */
export async function assertLicensedForSourcePack(
  tenantId: string,
  sourcePackId: string,
): Promise<void> {
  await withSystemRole("platform pack licensing check on clone", async (client) => {
    const tier = await getTenantTier(client, tenantId);
    if (tier === 'internal') return;

    const { domain } = await getPackEntitlementInfo(client, sourcePackId);
    const ents = await listEntitlements(client, tenantId, { activeOnly: true });
    const licensed = ents.some(
      (e) =>
        (e.scope_type === 'pack' && e.scope_id === sourcePackId) ||
        (e.scope_type === 'domain' && domain !== null && e.scope_id === domain),
    );
    if (!licensed) {
      throw new AppError(
        `Your organisation is not licensed for this question set. Contact your platform operator to enable it.`,
        'NOT_LICENSED',
        403,
        { details: { code: 'NOT_LICENSED', source_pack_id: sourcePackId, domain } },
      );
    }
  });
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

// ---------------------------------------------------------------------------
// FU-A3 (2026-10-06) — tierAllows helper + display-name map
//
// Mechanism only: no route calls this yet (FU-A5 wires the route gates).
// Minimum-tier table mirrors docs/plans/PRICING_TIERS_2026-10-06.md § "Tier
// contents" — keep both in sync if the table changes.
// ---------------------------------------------------------------------------

/** Display names shown in the UI. DB values stay free/pro/enterprise/internal
 * (no schema change) — this is purely a presentation mapping (FU-A3). */
export const TIER_DISPLAY_NAMES: Record<PlanTier, string> = {
  free: 'Starter',
  pro: 'Growth',
  enterprise: 'Enterprise',
  internal: 'Internal',
};

/** Gated features from the tier table. Each maps to the lowest PlanTier that
 * includes it; 'internal' always passes (same bypass rule as assertPublishEntitled). */
export type TierFeature =
  | 'certificates'
  | 'webhooks'
  | 'api_keys'
  | 'embed'
  | 'audit_viewer'
  | 'cohort_analytics_full'
  | 'own_email_sender'
  | 'question_upload';

const TIER_RANK: Record<PlanTier, number> = { free: 0, pro: 1, enterprise: 2, internal: 3 };

const FEATURE_MIN_TIER: Record<TierFeature, PlanTier> = {
  certificates: 'free', // owner 2026-10-19: Free plan has certificates (no Trial mark)
  webhooks: 'pro',
  api_keys: 'enterprise',
  embed: 'enterprise',
  audit_viewer: 'enterprise',
  cohort_analytics_full: 'pro',
  own_email_sender: 'enterprise',
  question_upload: 'pro', // EXP-17: organisation question upload
};

/**
 * Does this tenant's plan tier include `feature`? Fail-closed: a tenant with
 * no plan row (tier === null) does NOT get the feature — mirrors
 * assertPublishEntitled's fail-closed rule, not a bypass.
 *
 * Mechanism only (FU-A3) — no caller wires this into a route gate yet; that
 * is FU-A5, which also decides the 403 shape per feature.
 */
export async function tierAllows(tenantId: string, feature: TierFeature): Promise<boolean> {
  const tierRaw = await withTenant(tenantId, (c) => getTenantTier(c, tenantId));
  if (tierRaw === null) return false;
  // tenant_plans.tier is DB CHECK-constrained to PlanTier's 4 values.
  const tier = tierRaw as PlanTier;
  if (tier === 'internal') return true;
  return TIER_RANK[tier] >= TIER_RANK[FEATURE_MIN_TIER[feature]];
}

// ---------------------------------------------------------------------------
// PT1 / PT-4 — plan-tier gates and limits (docs/plans/PRICING_TIERS_2026-10-06.md)
//
// Everything below is a no-op while PLAN_TIERS_ENFORCED is false (default).
// Credits are NOT gated inside the grade transaction (billing there must never
// block completion); the hard cap is checked at invite time instead.
// ---------------------------------------------------------------------------

/**
 * Per-tier limits. null = no limit. pro/enterprise/internal are uncapped.
 * Free plan (owner 2026-10-19, docs/design/2026-10-20-free-tier-limits.md):
 * 5 sample sets, 5 candidates in total, 5 AI-graded attempts in total, hard stop
 * at 100 % of the 250 credits. per_drive_candidates stays 200 (never reached while
 * max_candidates_total is 5; kept so the PT-4 tests and gate keep their meaning).
 */
export const TIER_LIMITS: Record<
  PlanTier,
  {
    licensed_packs: number | null;
    per_drive_candidates: number | null;
    max_candidates_total: number | null;
    ai_attempts_total: number | null;
    overage_hard_cap_ratio: number | null;
  }
> = {
  free: { licensed_packs: 5, per_drive_candidates: 200, max_candidates_total: 5, ai_attempts_total: 5, overage_hard_cap_ratio: 1.0 },
  pro: { licensed_packs: null, per_drive_candidates: null, max_candidates_total: null, ai_attempts_total: null, overage_hard_cap_ratio: null },
  enterprise: { licensed_packs: null, per_drive_candidates: null, max_candidates_total: null, ai_attempts_total: null, overage_hard_cap_ratio: null },
  internal: { licensed_packs: null, per_drive_candidates: null, max_candidates_total: null, ai_attempts_total: null, overage_hard_cap_ratio: null },
};

export type TierDenialCode = 'TIER_NOT_INCLUDED' | 'TIER_LIMIT_REACHED' | 'CREDITS_HARD_CAP' | 'AI_GRADING_DISABLED';

/** 403 for a tier gate or limit; `details.code` mirrors the error code. */
export function tierDenial(
  message: string,
  code: TierDenialCode,
  details: { tier: PlanTier | null; feature?: string; limit?: number; current?: number },
): AppError {
  return new AppError(message, code, 403, { details: { code, ...details } });
}

async function readTier(tenantId: string): Promise<PlanTier | null> {
  const raw = await withTenant(tenantId, (c) => getTenantTier(c, tenantId));
  return raw === null ? null : (raw as PlanTier);
}

/** Throw TIER_NOT_INCLUDED when the tenant's tier lacks `feature`. No-op when not enforced. */
export async function assertTierAllows(tenantId: string, feature: TierFeature): Promise<void> {
  if (!config.PLAN_TIERS_ENFORCED) return;
  if (await tierAllows(tenantId, feature)) return;
  throw tierDenial(
    `Your plan does not include this feature (${feature}). Contact your platform operator to upgrade.`,
    'TIER_NOT_INCLUDED',
    { tier: await readTier(tenantId), feature },
  );
}

/** Throw TIER_LIMIT_REACHED when `current` has reached the tier limit. No-op when off or unlimited. */
export async function assertTierLimit(
  tenantId: string,
  kind: 'licensed_packs' | 'per_drive_candidates',
  current: number,
): Promise<void> {
  if (!config.PLAN_TIERS_ENFORCED) return;
  const tier = (await readTier(tenantId)) ?? 'free'; // missing plan row = free, same fallback as getUsage
  const limit = TIER_LIMITS[tier][kind];
  if (limit === null || current < limit) return;
  throw tierDenial(
    `Your plan allows at most ${limit} for ${kind.replace(/_/g, ' ')}. Contact your platform operator to upgrade.`,
    'TIER_LIMIT_REACHED',
    { tier, feature: kind, limit, current },
  );
}

/**
 * Free plan: throw TIER_LIMIT_REACHED when the tenant would exceed its total
 * candidate cap. Counts every candidate user row ever created in the tenant
 * (soft-deleted and erased tombstones stay counted, so delete-and-re-add cannot
 * reset the cap). Runs under withTenant, so RLS applies. No-op when off/unlimited.
 */
export async function assertCandidateTotalCap(tenantId: string, adding = 1): Promise<void> {
  if (!config.PLAN_TIERS_ENFORCED) return;
  if (!tenantId) throw new ValidationError('tenantId is required for the candidate cap');
  const tier = (await readTier(tenantId)) ?? 'free'; // missing plan row = free
  const limit = TIER_LIMITS[tier].max_candidates_total;
  if (limit === null) return;
  const current = await withTenant(tenantId, (c) => countCandidatesEver(c, tenantId));
  if (current + adding <= limit) return;
  throw tierDenial(
    `Your plan allows at most ${limit} candidates in total. Contact your platform operator to upgrade.`,
    'TIER_LIMIT_REACHED',
    { tier, feature: 'max_candidates_total', limit, current },
  );
}

/**
 * Race-safe candidate cap (migration 0222). Call INSIDE the transaction (`client`) that creates
 * the candidate user or invitation: a refusal throws, the transaction rolls back, and neither a
 * user row nor a counted row survives. An already-counted user id does not count twice.
 * No-op while the flag is off or the tier has no total cap.
 */
export async function countCandidateOrRefuse(client: PoolClient, tenantId: string, userId: string): Promise<void> {
  if (!config.PLAN_TIERS_ENFORCED) return;
  if (!tenantId) throw new ValidationError('tenantId is required for the candidate cap');
  const tier = ((await getTenantTier(client, tenantId)) as PlanTier | null) ?? 'free'; // missing plan row = free
  const limit = TIER_LIMITS[tier].max_candidates_total;
  if (limit === null) return;
  const current = await recordCandidateCounted(client, tenantId, userId);
  if (current <= limit) return;
  throw tierDenial(
    `Your plan allows at most ${limit} candidates in total. Contact your platform operator to upgrade.`,
    'TIER_LIMIT_REACHED',
    { tier, feature: 'max_candidates_total', limit, current: current - 1 },
  );
}

/**
 * Free plan: a role change must not reset the candidate count (gate finding, 2026-10-19).
 * Promoting a candidate would drop the count; demoting an admin adds a candidate. So on a
 * capped tier a candidate cannot change role, and a change TO candidate counts as one new
 * candidate. No-op when the flag is off or the tier is uncapped.
 */
export async function assertCandidateRoleChange(tenantId: string, userId: string, newRole: string): Promise<void> {
  if (!config.PLAN_TIERS_ENFORCED) return;
  if (!tenantId) throw new ValidationError('tenantId is required for the candidate cap');
  const tier = (await readTier(tenantId)) ?? 'free';
  const limit = TIER_LIMITS[tier].max_candidates_total;
  if (limit === null) return;
  const cur = await withTenant(tenantId, async (c) => {
    const r = await c.query<{ role: string }>('SELECT role FROM users WHERE id = $1 AND tenant_id = $2', [userId, tenantId]);
    return r.rows[0]?.role ?? null;
  });
  if (cur === null || cur === newRole) return;
  if (cur === 'candidate') {
    throw tierDenial(
      'On your plan a candidate cannot change role. Contact your platform operator to upgrade.',
      'TIER_LIMIT_REACHED',
      { tier, feature: 'max_candidates_total', limit },
    );
  }
  if (newRole === 'candidate') await assertCandidateTotalCap(tenantId, 1);
}

/**
 * Free plan: block a new AI-graded attempt. `attemptId` (optional) is the attempt
 * being graded; an attempt that already counts (re-run) never adds to the total.
 * Order: FREE_PLAN_AI_DISABLED kill switch (free tier only), then the
 * ai_attempts_total cap. Paid tiers (null cap) are never blocked. No-op when off.
 * The per-tenant AI pause is a separate gate inside 07-ai-grading.
 */
export async function assertAiAttemptAllowed(tenantId: string, attemptId?: string): Promise<void> {
  if (!config.PLAN_TIERS_ENFORCED) return;
  if (!tenantId) throw new ValidationError('tenantId is required for the AI attempt cap');
  const tier = (await readTier(tenantId)) ?? 'free'; // missing plan row = free
  if (tier === 'free' && config.FREE_PLAN_AI_DISABLED) {
    throw tierDenial(
      'AI grading is switched off for the Free plan. Contact your platform operator.',
      'AI_GRADING_DISABLED',
      { tier, feature: 'ai_attempts_total' },
    );
  }
  const limit = TIER_LIMITS[tier].ai_attempts_total;
  if (limit === null) return;
  const current = await withTenant(tenantId, (c) => countAiAttemptsEver(c, tenantId, attemptId ?? null));
  if (current < limit) return;
  throw tierDenial(
    `Your plan allows at most ${limit} AI-graded attempts in total. Contact your platform operator to upgrade.`,
    'TIER_LIMIT_REACHED',
    { tier, feature: 'ai_attempts_total', limit, current },
  );
}

/** Throw CREDITS_HARD_CAP when used >= included * ratio (Free: 100 %). No-op when off or uncapped. */
export async function assertCreditsUnderHardCap(tenantId: string): Promise<void> {
  if (!config.PLAN_TIERS_ENFORCED) return;
  const { tier, included_credits, used, credits } = await getUsage(tenantId);
  // Z-93: a free tenant with ledger grants is capped by its balance, not the legacy meter.
  if (tier === 'free' && included_credits !== null && credits.has_grants) {
    if (credits.balance > 0) return;
    throw tierDenial(
      'Your plan has reached its credit limit. Contact your platform operator to upgrade or add credits.',
      'CREDITS_HARD_CAP',
      { tier, limit: 0, current: 0 },
    );
  }
  const ratio = TIER_LIMITS[tier].overage_hard_cap_ratio;
  // included <= 0 (incl. the missing-plan fallback) is not a cap: 120 % of nothing must not read as "limit reached".
  if (ratio === null || included_credits === null || included_credits <= 0) return;
  const cap = included_credits * ratio;
  if (used < cap) return;
  throw tierDenial(
    'Your plan has reached its credit limit. Contact your platform operator to upgrade or add credits.',
    'CREDITS_HARD_CAP',
    { tier, limit: Math.floor(cap), current: used },
  );
}

/** Tier, its limits and whether they are enforced (read-only helper for callers). */
export async function getTierLimits(
  tenantId: string,
): Promise<{ tier: PlanTier | null; limits: (typeof TIER_LIMITS)[PlanTier] | null; enforced: boolean }> {
  const tier = await readTier(tenantId);
  return { tier, limits: tier === null ? null : TIER_LIMITS[tier], enforced: config.PLAN_TIERS_ENFORCED };
}

// ---------------------------------------------------------------------------
// Step 2 — "Available sets" catalog (standing license + clone-on-use)
// ---------------------------------------------------------------------------

/**
 * List the published platform-library sets a tenant is licensed for — the
 * "Available sets" catalog the company picks from when authoring an assessment.
 *
 * A domain license surfaces ALL current AND future published sets in that
 * domain (the catalog reflects the live library); a pack license surfaces one
 * set. Metadata only — no question content is read here. Each entry flags
 * whether it has already been materialised into this tenant (clone-on-use) and
 * whether a newer source version is available (re-sync hint).
 *
 * Runs under assessiq_system (BYPASSRLS) so it can resolve the platform tenant's
 * packs while reading THIS tenant's licenses + clones. The license filter is in
 * SQL (listAvailablePlatformSets), so an unlicensed set is never returned.
 */
export async function listAvailableSetsForTenant(tenantId: string): Promise<AvailableSet[]> {
  return withSystemRole("platform sets read filtered by tenant entitlements", async (client) => {
    const platformTenantId = await getPlatformTenantId(client);
    // No platform library, or the caller IS the platform tenant (it owns the
    // library — it has no "available sets" to consume): nothing to list.
    if (platformTenantId === null || platformTenantId === tenantId) return [];

    const ents = await listEntitlements(client, tenantId, { activeOnly: true });
    const domainSlugs = ents.filter((e) => e.scope_type === 'domain').map((e) => e.scope_id);
    const packIds = ents.filter((e) => e.scope_type === 'pack').map((e) => e.scope_id);
    if (domainSlugs.length === 0 && packIds.length === 0) return [];

    const sets = await listAvailablePlatformSets(client, platformTenantId, domainSlugs, packIds);
    if (sets.length === 0) return [];

    const clones = await findClonesBySource(client, tenantId, sets.map((s) => s.id));
    const cloneBySource = new Map(clones.map((c) => [c.source_pack_id, c]));

    return sets.map((s) => {
      const clone = cloneBySource.get(s.id);
      return {
        source_pack_id: s.id,
        name: s.name,
        domain: s.domain,
        source_version: s.version,
        question_count: s.question_count,
        level_count: s.level_count,
        cloned: clone !== undefined,
        cloned_pack_id: clone?.id ?? null,
        update_available:
          clone !== undefined && clone.source_version !== null && clone.source_version < s.version,
      };
    });
  });
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
 * TWO-ROLE TRANSACTION (deliberately NOT the plain withSystemRole):
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
  return withSystemRole("tenant plan update", async (client) => {
    // Phase A — system role: tenant_plans has no UPDATE RLS policy (A1),
    // so the lock + UPDATE require BYPASSRLS.

    // 1. Lock the row
    const planRow = await getTenantPlanRow(client, tenantId, true);
    if (planRow === null) {
      throw new NotFoundError(`No billing plan found for organisation ${tenantId}`, {
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
    const nextOverride: number | null =
      'aiAnswersIncludedOverride' in patch
        ? (patch.aiAnswersIncludedOverride ?? null)
        : (planRow.ai_answers_included_override ?? null);
    if (nextOverride !== null && (!Number.isInteger(nextOverride) || nextOverride < 0 || nextOverride > 1_000_000)) {
      throw new ValidationError(
        `aiAnswersIncludedOverride must be null or an integer from 0 to 1000000`,
        { details: { code: 'INVALID_AI_ANSWERS_OVERRIDE', received: nextOverride } },
      );
    }
    const { updated_at } = await updateTenantPlanRow(client, tenantId, nextTier, nextCredits, nextOverride);

    // Phase B — app role + tenant GUC: put auditInTx in exactly the context
    // its contract (audit.ts) and the reviewed updateAiGenerateMode precedent
    // require. Same transaction ⇒ the UPDATE above and this audit are atomic.
    // system read, then tenant-scoped write under assessiq_app in the same tx
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
        ai_answers_included_override: nextOverride,
        previous_ai_answers_override: planRow.ai_answers_included_override ?? null,
      },
    });

    return {
      tenant_id: tenantId,
      tier: nextTier,
      included_credits: nextCredits,
      previous: { tier: prevTier, included_credits: prevCredits },
      updatedAt: updated_at instanceof Date ? updated_at.toISOString() : String(updated_at),
      auditId: auditRow.id,
    };
  });
}

// ---------------------------------------------------------------------------
// Z-93 — credit ledger service
// ---------------------------------------------------------------------------

/** Ledger balance for a tenant (tenant-scoped via withTenant). */
export async function getCreditBalance(tenantId: string): Promise<CreditBalance> {
  return (await getUsage(tenantId)).credits;
}

export interface GrantCreditsInput {
  source: 'purchase' | 'bonus' | 'pilot';
  credits: number;
  expiresAt?: Date;
  expiresInMonths?: number;
  invoiceRef?: string;
  note?: string;
}

/**
 * Super-admin offline grant (Z-79). Two-role tx like updateTenantPlan: insert under
 * the system role, then audit under assessiq_app + tenant GUC in the SAME tx.
 */
export async function grantCredits(
  tenantId: string,
  input: GrantCreditsInput,
  actorUserId: string,
): Promise<{ id: string; expires_at: string; auditId: string }> {
  if (!['purchase', 'bonus', 'pilot'].includes(input.source)) {
    throw new ValidationError('source must be purchase, bonus or pilot', { details: { code: 'INVALID_SOURCE' } });
  }
  if (!Number.isInteger(input.credits) || input.credits < 1 || input.credits > 1_000_000) {
    throw new ValidationError('credits must be an integer from 1 to 1000000', { details: { code: 'INVALID_CREDITS' } });
  }
  const months = input.expiresInMonths ?? GRANT_VALIDITY_MONTHS;
  if (!Number.isInteger(months) || months < 1 || months > 120) {
    throw new ValidationError('expiresInMonths must be an integer from 1 to 120', { details: { code: 'INVALID_EXPIRY' } });
  }
  return withSystemRole('super-admin credit grant', async (client) => {
    const plan = await getTenantPlanRow(client, tenantId);
    if (plan === null) {
      throw new NotFoundError(`No billing plan found for organisation ${tenantId}`, {
        details: { code: 'PLAN_NOT_FOUND', tenantId },
      });
    }
    const row = await insertCreditGrant(client, tenantId, {
      source: input.source,
      credits: input.credits,
      expiresInMonths: months,
      expiresAt: input.expiresAt ?? null,
      invoiceRef: input.invoiceRef ?? null,
      note: input.note ?? null,
      createdBy: actorUserId,
    });
    await client.query('SET LOCAL ROLE assessiq_app');
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    const audit = await auditInTx(client, {
      action: 'billing.credits_granted',
      actorKind: 'user',
      actorUserId,
      tenantId,
      entityType: 'credit_grant',
      entityId: row.id,
      after: { source: input.source, credits: input.credits, invoice_ref: input.invoiceRef ?? null, expires_at: row.expires_at },
    });
    return {
      id: row.id,
      expires_at: row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
      auditId: audit.id,
    };
  });
}

/** Super-admin view: all grants (incl. expired) and burn totals. */
export async function listTenantCredits(
  tenantId: string,
): Promise<{ grants: CreditGrantView[]; burns: CreditBalance['burn_by_type'] }> {
  return withSystemRole('super-admin credit ledger read', (client) => listGrantsAndBurns(client, tenantId));
}

/** Monthly job: free tenants get exactly FREE_MONTHLY_CREDITS (no rollover). Non-AI. */
export async function refillFreeMonthlyCredits(): Promise<{ zeroed: number; granted: number }> {
  return withSystemRole('free monthly credit refill', (client) => refillFreeMonthlyAll(client));
}

/** Daily job: zero the remaining credits of expired grants. Non-AI. */
export async function expireCredits(): Promise<number> {
  return withSystemRole('credit grant expiry sweep', (client) => expireCreditGrants(client));
}

/** What the worker passes in so billing does not import the notifications module. */
export type LowBalanceSender = (m: { to: string; tenantId: string; remaining: number; level: number }) => Promise<void>;

/**
 * Z-96 daily job (non-AI): tell the tenant admins when the balance falls to <= 20 percent and
 * <= 10 percent of the largest unexpired grant. One email per level per grant, ever.
 * Per tenant, in ONE transaction: insert the notice rows first (unique guard, concurrent ticks
 * block then skip), send, write the audit row. If the send fails for every admin (or there is
 * no admin) the transaction rolls back, so the notice is not final and the next tick retries.
 * Jumping straight past 20 to 10 records both levels but sends one email (level 10).
 * ponytail: sends inside the transaction (one open connection per tenant at a time); at-least-once
 * if the commit fails after the send.
 */
export async function sendCreditLowBalanceNotices(send: LowBalanceSender): Promise<{ checked: number; notified: number; failed: number }> {
  const candidates = await withSystemRole('credit low-balance scan', (client) => listLowBalanceCandidates(client));
  let notified = 0;
  let failed = 0;
  for (const c of candidates) {
    const crossed = LOW_BALANCE_LEVELS.filter((lvl) => c.balance * 100 <= c.largest * lvl);
    if (crossed.length === 0) continue;
    try {
      const did = await withSystemRole('credit low-balance notice', async (client) => {
        const fresh = await insertLowBalanceNotices(client, c.tenant_id, c.grant_id, crossed);
        if (fresh.length === 0) return false;
        const level = Math.min(...fresh);
        const admins = await listTenantAdminEmails(client, c.tenant_id);
        await client.query('SET LOCAL ROLE assessiq_app');
        await client.query("SELECT set_config('app.current_tenant', $1, true)", [c.tenant_id]);
        await auditInTx(client, {
          action: 'billing.credit_low_balance_notice',
          actorKind: 'system',
          tenantId: c.tenant_id,
          entityType: 'credit_grant',
          entityId: c.grant_id,
          after: { level, remaining: c.balance, largest_grant: c.largest, recipients: admins.length },
        });
        // Audit first: if it throws the whole tx rolls back before any mail is queued (no daily duplicate).
        let sent = 0;
        for (const to of admins) {
          try {
            await send({ to, tenantId: c.tenant_id, remaining: c.balance, level });
            sent += 1;
          } catch (err) {
            log.warn({ err, tenantId: c.tenant_id }, 'credit_low_balance.email_failed');
          }
        }
        if (sent === 0) throw new Error('credit low-balance: no admin email was sent');
        return true;
      });
      if (did) notified += 1;
    } catch (err) {
      failed += 1;
      log.warn({ err, tenantId: c.tenant_id }, 'credit_low_balance.tenant_failed');
    }
  }
  return { checked: candidates.length, notified, failed };
}
