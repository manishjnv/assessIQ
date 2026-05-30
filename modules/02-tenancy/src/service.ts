import { NotFoundError, ConflictError, ValidationError, streamLogger, uuidv7 } from "@assessiq/core";
import { withTenant } from "./with-tenant.js";
import { getPool } from "./pool.js";
import * as repo from "./repository.js";
import type { Tenant, TenantSettings } from "./types.js";
import { auditInTx } from "@assessiq/audit-log";

const log = streamLogger('app');

export async function getTenantById(tenantId: string): Promise<Tenant> {
  const tenant = await withTenant(tenantId, async (client) => {
    return repo.findTenantById(client, tenantId);
  });
  if (tenant === null) {
    throw new NotFoundError(`tenant not found: ${tenantId}`);
  }
  return tenant;
}

// Slug lookup happens BEFORE tenant context is set (auth/login path needs
// to resolve tenant id from a slug query param). It bypasses RLS via the
// `assessiq_system` role inside an explicit transaction — same pattern as
// `apiKeys.authenticate` in @assessiq/auth. The system role is BYPASSRLS,
// so the slug lookup returns the tenant row regardless of current_tenant.
//
// Returns null on miss; throws on DB failure. Callers (Google SSO start,
// invitation accept) gate on null → AuthnError("unknown tenant"). When
// 14-audit-log lands in Phase 3, every system-role read will write an
// audit entry; for Phase 0 the operational JSONL log captures the call.
//
// SET LOCAL ROLE must be inside BEGIN/COMMIT (transaction-scoped). Outside
// a transaction it's a no-op + warning.
export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE assessiq_system");
    const tenant = await repo.findTenantBySlug(client, slug);
    await client.query("COMMIT");
    return tenant;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // Secondary rollback failure — connection is likely dead. Swallow and
      // re-throw the original error so the caller sees the real cause.
    });
    throw err;
  } finally {
    client.release();
  }
}

export async function updateTenantSettings(
  tenantId: string,
  patch: Parameters<typeof repo.updateTenantSettingsRow>[1],
  actorUserId?: string,
): Promise<TenantSettings> {
  // Do NOT log the patch contents at INFO — TenantSettings JSONB may include
  // tenant-private branding URLs, webhook URLs, etc. CLAUDE.md hard rule #4.
  log.info({ tenantId }, "updateTenantSettings");
  return withTenant(tenantId, async (client) => {
    // Pre-read for before state (G3.D atomicity: read + write + audit in one tx).
    // FOR UPDATE locks the row to prevent TOCTOU race between the pre-read and the UPDATE.
    const before = await repo.findTenantSettings(client, true);
    const updated = await repo.updateTenantSettingsRow(client, patch);
    // Audit INSERT in the SAME transaction (atomicity via auditInTx).
    // If this throws, withTenant rolls back the UPDATE.
    await auditInTx(client, {
      tenantId,
      actorKind: actorUserId ? "user" : "system",
      ...(actorUserId !== undefined ? { actorUserId } : {}),
      action: "tenant.settings.updated",
      entityType: "tenant_settings",
      entityId: tenantId,
      ...(before !== null ? { before: before as unknown as Record<string, unknown> } : {}),
      after: patch as unknown as Record<string, unknown>,
    });
    return updated;
  });
}

/**
 * Enumerate every active tenant id. Used by apps/worker's BullMQ cron
 * processors to drive per-tenant boundary advancement and timer sweep.
 *
 * Bypasses RLS via the `assessiq_system` BYPASSRLS role inside an explicit
 * transaction — same pattern as `getTenantBySlug`. The worker MUST see all
 * tenants regardless of any prior `app.current_tenant` GUC state.
 *
 * 'suspended' tenants are excluded — there's no benefit to advancing
 * boundaries or auto-submitting attempts for a tenant whose admins can no
 * longer log in. Per-tenant cron skipping is faster than a global skip-list.
 */
export async function listActiveTenantIds(): Promise<string[]> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE assessiq_system");
    const result = await client.query<{ id: string }>(
      `SELECT id FROM tenants WHERE status = 'active' ORDER BY id ASC`,
    );
    await client.query("COMMIT");
    return result.rows.map((r) => r.id);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // Secondary rollback failure — connection is likely dead. Swallow and
      // re-throw the original error so the caller sees the real cause.
    });
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Super-admin-only: create a new tenant (provisioning → caller flips active).
// ---------------------------------------------------------------------------
//
// C2 of the super-admin-onboarding contract.
//
// Design invariants (must not be relaxed):
//   1. System-role transaction is MINIMAL — only tenants + tenant_settings.
//      No user rows, no role rows, no taxonomy. All those come from the caller
//      (C4 route) using explicit withTenant(newTenantId) cross-tenant writes.
//   2. Tenant status starts at 'provisioning'. The caller flips it to 'active'
//      ONLY after all post-create steps (seed + invite) succeed. Orphan tenants
//      stay 'provisioning' indefinitely — they are queryable and retryable.
//   3. Slug uniqueness is enforced at the DB level (UNIQUE constraint on tenants.slug).
//      A collision surfaces as ConflictError (409) so the caller can show a clean
//      error without exposing DB internals.
//   4. The system-role BYPASSRLS path is REQUIRED: there is no app.current_tenant
//      context for a brand-new tenant. SET LOCAL ROLE assessiq_system lets us
//      INSERT into tenants (a globally-visible table) and tenant_settings (which
//      has an RLS policy requiring current_tenant match — the bypass avoids that).

export interface CreateTenantInput {
  name: string;
  slug: string;
  domain?: string;
}

export interface CreateTenantResult {
  tenantId: string;
}

export async function createTenant(
  input: CreateTenantInput,
  _createdBySuperAdminUserId: string,
): Promise<CreateTenantResult> {
  log.info({ slug: input.slug, name: input.name }, "createTenant: provisioning");

  const tenantId = uuidv7();

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // assessiq_system is BYPASSRLS — required because no app.current_tenant
    // exists yet for a brand-new tenant. This section is deliberately minimal:
    // only tenants + tenant_settings. See design invariant #1 above.
    await client.query("SET LOCAL ROLE assessiq_system");

    // INSERT tenant at status='provisioning'. Slug collision → ConflictError.
    try {
      await client.query(
        `INSERT INTO tenants (id, slug, name, domain, status)
         VALUES ($1, $2, $3, $4, 'provisioning')`,
        [tenantId, input.slug, input.name, input.domain ?? null],
      );
    } catch (err: unknown) {
      // PostgreSQL unique_violation = code '23505'.
      const pg = err as { code?: string };
      if (pg.code === "23505") {
        throw new ConflictError(`slug '${input.slug}' is already taken`, {
          details: { code: "TENANT_SLUG_CONFLICT", slug: input.slug },
        });
      }
      throw err;
    }

    // INSERT tenant_settings (FK NOT NULL — must exist immediately after tenant).
    await client.query(
      `INSERT INTO tenant_settings (tenant_id) VALUES ($1)`,
      [tenantId],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // Secondary rollback failure — connection likely dead; swallow.
    });
    throw err;
  } finally {
    client.release();
  }

  log.info({ tenantId, slug: input.slug }, "createTenant: provisioning complete");
  return { tenantId };
}

// ---------------------------------------------------------------------------
// Super-admin-only: flip tenant status from 'provisioning' to 'active'.
// ---------------------------------------------------------------------------
//
// Called by the C4 route after seedTenantTaxonomy + inviteUser both succeed.
// Uses the system-role path (same pattern as createTenant) because the
// sessions table and tenant_settings RLS policies require app.current_tenant
// to match the row's tenant_id — which is fine for tenant's OWN rows but here
// we're doing a targeted UPDATE by tenant id, so we use system role for clarity.

export async function activateTenant(tenantId: string): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE assessiq_system");
    await client.query(
      `UPDATE tenants SET status = 'active', updated_at = now() WHERE id = $1`,
      [tenantId],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  log.info({ tenantId }, "activateTenant: tenant is now active");
}

// ---------------------------------------------------------------------------
// Super-admin-only: tenant lifecycle transitions (suspend / resume / archive / unarchive).
// ---------------------------------------------------------------------------
//
// Design: all four functions share the same atomic pattern:
//   1. withTenant(tenantId) — pins RLS to the TARGET tenant so the
//      SELECT … FOR UPDATE + UPDATE execute under the correct scope.
//   2. Read current status (FOR UPDATE to prevent TOCTOU race).
//   3. No-op check: if already in target state, return early with noOp=true.
//      No audit row, no session revocation.
//   4. Wrong-direction check: throw ConflictError(INVALID_LIFECYCLE_TRANSITION)
//      with the list of allowed source states so the API can return a clean 409.
//   5. UPDATE tenants.status.
//   6. auditInTx inside the SAME transaction — scoped to actorTenantId (the
//      platform tenant). This is intentional: the actor is a super_admin whose
//      audit context lives in the platform tenant. The target tenant's own
//      audit trail does not include super-admin lifecycle gestures (only tenant-
//      internal events). This matches the createCompany pattern at admin-super.ts:240.
//   7. Commit (withTenant handles this).
//   8. Return { tenantId, slug, previousStatus, newStatus, auditId, noOp }.
//
// The slug is fetched inside the same transaction (step 2 reads it alongside
// status) so the caller can include it in the response without an extra query.
//
// Session revocation and logLifecycleEvent are intentionally NOT called here —
// those side-effects belong in the API handler layer (admin-super.ts) so the
// service layer remains pure DB + audit.

export interface TenantLifecycleResult {
  tenantId: string;
  slug: string;
  previousStatus: string;
  newStatus: string;
  auditId: string | null;
  noOp: boolean;
}

interface TenantStatusSlugRow {
  status: string;
  slug: string;
}

async function performLifecycleTransition(
  tenantId: string,
  actorUserId: string,
  actorTenantId: string,
  reason: string | undefined,
  action: "tenant.suspended" | "tenant.resumed" | "tenant.archived" | "tenant.unarchived",
  targetStatus: "active" | "suspended" | "archived",
  allowedSourceStatuses: ReadonlyArray<string>,
  noOpStatus: string,
): Promise<TenantLifecycleResult> {
  return withTenant(tenantId, async (client) => {
    // Read current status + slug, lock the row to prevent TOCTOU races.
    const selectResult = await client.query<TenantStatusSlugRow>(
      `SELECT status, slug FROM tenants WHERE id = $1 FOR UPDATE`,
      [tenantId],
    );
    const row = selectResult.rows[0];
    if (row === undefined) {
      throw new NotFoundError(`tenant not found: ${tenantId}`, {
        details: { code: "TENANT_NOT_FOUND", tenantId },
      });
    }

    const previousStatus = row.status;
    const slug = row.slug;

    // Idempotent no-op: already at target state.
    if (previousStatus === noOpStatus) {
      return { tenantId, slug, previousStatus, newStatus: previousStatus, auditId: null, noOp: true };
    }

    // Wrong-direction: source state not in allowed set.
    if (!allowedSourceStatuses.includes(previousStatus)) {
      throw new ConflictError(
        `tenant cannot transition from '${previousStatus}' to '${targetStatus}'`,
        {
          details: {
            code: "INVALID_LIFECYCLE_TRANSITION",
            currentStatus: previousStatus,
            allowedStatuses: allowedSourceStatuses,
          },
        },
      );
    }

    // Apply the status UPDATE.
    await repo.setTenantStatus(client, tenantId, targetStatus);

    // Audit row written inside the same transaction, scoped to the TARGET
    // tenant. The audit_log INSERT policy (0050_audit_log.sql) requires
    // `tenant_id = current_setting('app.current_tenant')`; since withTenant
    // pinned the RLS context to the target, the audit row must live in the
    // target's audit log. Cross-tenant super-admin investigations remain
    // efficient via the existing actor_user_id index (no second row needed
    // in the platform tenant). actorTenantId stays on the function signature
    // for API stability and is preserved in the audit row's `after.actor_tenant`
    // jsonb field for forensic clarity.
    //
    // This matches the updateAiGenerateMode auditInTx pattern (super-admin
    // mutates a different tenant; audit goes to that target tenant).
    const auditRow = await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId,
      action,
      entityType: "tenant",
      entityId: tenantId,
      before: { status: previousStatus },
      after: {
        status: targetStatus,
        previous_status: previousStatus,
        reason: reason ?? null,
        actor_tenant: actorTenantId,
      },
    });

    return { tenantId, slug, previousStatus, newStatus: targetStatus, auditId: auditRow.id, noOp: false };
  });
}

/**
 * Suspend a tenant: active → suspended.
 * Idempotent if already suspended. Throws ConflictError on wrong-direction.
 */
export async function suspendTenant(
  tenantId: string,
  actorUserId: string,
  actorTenantId: string,
  reason?: string,
): Promise<TenantLifecycleResult> {
  log.info({ tenantId, actorUserId }, "suspendTenant: starting");
  const result = await performLifecycleTransition(
    tenantId, actorUserId, actorTenantId, reason,
    "tenant.suspended", "suspended", ["active"], "suspended",
  );
  if (!result.noOp) {
    log.warn({ tenantId, previousStatus: result.previousStatus, reason }, "suspendTenant: tenant suspended");
  } else {
    log.info({ tenantId }, "suspendTenant: no-op (already suspended)");
  }
  return result;
}

/**
 * Resume a tenant: suspended → active.
 * Idempotent if already active. Throws ConflictError on wrong-direction.
 */
export async function resumeTenant(
  tenantId: string,
  actorUserId: string,
  actorTenantId: string,
  reason?: string,
): Promise<TenantLifecycleResult> {
  log.info({ tenantId, actorUserId }, "resumeTenant: starting");
  const result = await performLifecycleTransition(
    tenantId, actorUserId, actorTenantId, reason,
    "tenant.resumed", "active", ["suspended"], "active",
  );
  if (!result.noOp) {
    log.info({ tenantId, previousStatus: result.previousStatus }, "resumeTenant: tenant resumed");
  } else {
    log.info({ tenantId }, "resumeTenant: no-op (already active)");
  }
  return result;
}

/**
 * Archive a tenant: active|suspended → archived.
 * Idempotent if already archived. Throws ConflictError on wrong-direction.
 */
export async function archiveTenant(
  tenantId: string,
  actorUserId: string,
  actorTenantId: string,
  reason?: string,
): Promise<TenantLifecycleResult> {
  log.info({ tenantId, actorUserId }, "archiveTenant: starting");
  const result = await performLifecycleTransition(
    tenantId, actorUserId, actorTenantId, reason,
    "tenant.archived", "archived", ["active", "suspended"], "archived",
  );
  if (!result.noOp) {
    log.warn({ tenantId, previousStatus: result.previousStatus, reason }, "archiveTenant: tenant archived");
  } else {
    log.info({ tenantId }, "archiveTenant: no-op (already archived)");
  }
  return result;
}

/**
 * Unarchive a tenant: archived → active.
 * Idempotent if already active. Throws ConflictError on wrong-direction.
 */
export async function unarchiveTenant(
  tenantId: string,
  actorUserId: string,
  actorTenantId: string,
  reason?: string,
): Promise<TenantLifecycleResult> {
  log.info({ tenantId, actorUserId }, "unarchiveTenant: starting");
  const result = await performLifecycleTransition(
    tenantId, actorUserId, actorTenantId, reason,
    "tenant.unarchived", "active", ["archived"], "active",
  );
  if (!result.noOp) {
    log.info({ tenantId, previousStatus: result.previousStatus }, "unarchiveTenant: tenant unarchived");
  } else {
    log.info({ tenantId }, "unarchiveTenant: no-op (already active)");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Super-admin-only: per-tenant AI generation mode flip.
// ---------------------------------------------------------------------------
//
// This is intentionally isolated from `updateTenantSettings` / `updateTenantSettingsRow`.
// That pair allows tenant admins to change their own settings; `ai_generate_mode` is
// excluded from its patch Pick<> and MUST NOT be added there.
//
// Key atomicity guarantee: the UPDATE and the audit_log INSERT run inside the
// SAME withTenant transaction via auditInTx. If the audit write fails, the
// UPDATE rolls back. This satisfies the CLAUDE.md hard rule on audit atomicity.

export interface UpdateAiGenerateModeResult {
  tenantId: string;
  ai_generate_mode: "omnibus" | "sharded" | null;
  previous: "omnibus" | "sharded" | null;
  updatedAt: Date;
  auditId: string;
}

/**
 * Flip `tenant_settings.ai_generate_mode` for a target tenant.
 *
 * Must be called by a super_admin only — the API handler enforces the role gate
 * before calling this function. This service method performs no auth checks itself
 * (service layer is below the auth boundary per module conventions).
 *
 * @param superAdminUserId  UUID of the super_admin making the change (for audit record).
 * @param targetTenantId    UUID of the tenant whose mode is being changed.
 * @param newMode           "omnibus" | "sharded" | null (null = use global env var).
 */
export async function updateAiGenerateMode(
  superAdminUserId: string,
  targetTenantId: string,
  newMode: "omnibus" | "sharded" | null,
): Promise<UpdateAiGenerateModeResult> {
  log.info({ targetTenantId, newMode }, "updateAiGenerateMode");

  return await withTenant(targetTenantId, async (client) => {
    // 1. Read current value so the audit row captures before state.
    const current = await repo.findTenantSettings(client);
    if (current === null) {
      throw new NotFoundError(`tenant_settings not found for tenant ${targetTenantId}`);
    }
    const previous = current.ai_generate_mode;

    // 2. Dedicated single-column UPDATE — deliberately NOT routed through
    //    updateTenantSettingsRow to keep the super-admin path isolated.
    //    No WHERE tenant_id filter: RLS (via withTenant) scopes the UPDATE
    //    to the current tenant's single row. Same anti-pattern note as
    //    repository.ts lines 82-88.
    const updateResult = await client.query<{ ai_generate_mode: string | null; updated_at: Date }>(
      `UPDATE tenant_settings
       SET ai_generate_mode = $1, updated_at = now()
       RETURNING ai_generate_mode, updated_at`,
      [newMode],
    );
    const updatedRow = updateResult.rows[0];
    if (updatedRow === undefined) {
      throw new NotFoundError(`tenant_settings row missing after UPDATE for tenant ${targetTenantId}`);
    }

    // 3. Audit INSERT in the SAME transaction (atomicity via auditInTx).
    //    If this throws, the outer try/catch in withTenant rolls back the UPDATE.
    const auditRow = await auditInTx(client, {
      tenantId: targetTenantId,
      actorKind: "user",
      actorUserId: superAdminUserId,
      action: "tenant_settings.ai_generate_mode.updated",
      entityType: "tenant_settings",
      entityId: targetTenantId,
      before: { ai_generate_mode: previous },
      after: { ai_generate_mode: newMode },
    });

    return {
      tenantId: targetTenantId,
      ai_generate_mode: (updatedRow.ai_generate_mode as "omnibus" | "sharded" | null) ?? null,
      previous,
      updatedAt: updatedRow.updated_at,
      auditId: auditRow.id,
    };
  });
}

// ---------------------------------------------------------------------------
// Tenant-admin: per-tenant DPDP retention window flip.
// ---------------------------------------------------------------------------
//
// Mirrors updateAiGenerateMode: intentionally isolated from
// updateTenantSettings / updateTenantSettingsRow. The patch Pick<> in the
// generic update path MUST NOT include retention_days; this is the only
// path that may mutate it. Tenant admins are the DPDP data fiduciary for
// their own candidates per the SKILL.md S2/S3-lite auth-gate decision.
//
// Range constraint (1–3650) is enforced both at the SQL level (CHECK in
// migration 0103) AND here at the service boundary so bad input surfaces
// as a typed ValidationError before reaching Postgres.
//
// Atomicity: UPDATE + auditInTx in the same withTenant transaction.

export interface UpdateRetentionDaysResult {
  tenantId: string;
  retention_days: number;
  previous: number;
  updatedAt: Date;
  auditId: string;
}

const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3650;

export async function updateRetentionDays(
  adminUserId: string,
  targetTenantId: string,
  newRetentionDays: number,
): Promise<UpdateRetentionDaysResult> {
  if (!Number.isInteger(newRetentionDays)) {
    throw new ValidationError("retention_days must be an integer", {
      details: { code: "INVALID_RETENTION_DAYS", received: newRetentionDays },
    });
  }
  if (newRetentionDays < MIN_RETENTION_DAYS || newRetentionDays > MAX_RETENTION_DAYS) {
    throw new ValidationError(
      `retention_days must be between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}`,
      {
        details: {
          code: "RETENTION_DAYS_OUT_OF_RANGE",
          min: MIN_RETENTION_DAYS,
          max: MAX_RETENTION_DAYS,
          received: newRetentionDays,
        },
      },
    );
  }

  log.info({ targetTenantId, newRetentionDays }, "updateRetentionDays");

  return await withTenant(targetTenantId, async (client) => {
    const current = await repo.findTenantSettings(client);
    if (current === null) {
      throw new NotFoundError(`tenant_settings not found for tenant ${targetTenantId}`);
    }
    const previous = current.retention_days;

    if (previous === newRetentionDays) {
      // Idempotent no-op — still emit an audit row so the no-op intent is
      // observable in the forensic chain.
      const auditRow = await auditInTx(client, {
        tenantId: targetTenantId,
        actorKind: "user",
        actorUserId: adminUserId,
        action: "tenant_settings.retention_days.updated",
        entityType: "tenant_settings",
        entityId: targetTenantId,
        before: { retention_days: previous },
        after: { retention_days: newRetentionDays, noOp: true },
      });
      return {
        tenantId: targetTenantId,
        retention_days: previous,
        previous,
        updatedAt: current.updated_at,
        auditId: auditRow.id,
      };
    }

    const updateResult = await client.query<{ retention_days: number | string; updated_at: Date }>(
      `UPDATE tenant_settings
         SET retention_days = $1, updated_at = now()
       RETURNING retention_days, updated_at`,
      [newRetentionDays],
    );
    const updatedRow = updateResult.rows[0];
    if (updatedRow === undefined) {
      throw new NotFoundError(
        `tenant_settings row missing after UPDATE for tenant ${targetTenantId}`,
      );
    }
    const updatedValue =
      typeof updatedRow.retention_days === "number"
        ? updatedRow.retention_days
        : Number.parseInt(String(updatedRow.retention_days), 10);

    const auditRow = await auditInTx(client, {
      tenantId: targetTenantId,
      actorKind: "user",
      actorUserId: adminUserId,
      action: "tenant_settings.retention_days.updated",
      entityType: "tenant_settings",
      entityId: targetTenantId,
      before: { retention_days: previous },
      after: { retention_days: updatedValue },
    });

    return {
      tenantId: targetTenantId,
      retention_days: updatedValue,
      previous,
      updatedAt: updatedRow.updated_at,
      auditId: auditRow.id,
    };
  });
}
