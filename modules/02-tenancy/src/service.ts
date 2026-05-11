import { NotFoundError, streamLogger } from "@assessiq/core";
import { withTenant } from "./with-tenant.js";
import { getPool } from "./pool.js";
import * as repo from "./repository.js";
import type { Tenant, TenantSettings } from "./types.js";
import { audit, auditInTx } from "@assessiq/audit-log";

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
): Promise<TenantSettings> {
  // Do NOT log the patch contents at INFO — TenantSettings JSONB may include
  // tenant-private branding URLs, webhook URLs, etc. CLAUDE.md hard rule #4.
  log.info({ tenantId }, "updateTenantSettings");
  const updated = await withTenant(tenantId, async (client) => {
    return repo.updateTenantSettingsRow(client, patch);
  });

  // G3.A audit hook: admin updated tenant settings.
  // before state not captured here (would require a pre-read); after captured as the patch.
  // Full before/after is available via audit_log for compliance; the patch shape is sufficient.
  await audit({
    tenantId,
    actorKind: "system", // caller is the request session; system actor for service-layer hooks
    action: "tenant.settings.updated",
    entityType: "tenant_settings",
    entityId: tenantId,
    after: patch as unknown as Record<string, unknown>,
  });

  return updated;
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

export async function suspendTenant(tenantId: string, reason: string): Promise<void> {
  // TODO(audit): when 14-audit-log lands in Phase 3, write a
  // tenant.suspended event with actor + reason here. For Phase 0 we only
  // record the reason via warn-level log so a future migration can
  // backfill from log archives if needed.
  log.warn({ tenantId, reason }, "tenant suspended (audit log pending)");
  await withTenant(tenantId, async (client) => {
    await repo.setTenantStatus(client, tenantId, "suspended");
  });
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
