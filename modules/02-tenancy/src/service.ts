import { NotFoundError, streamLogger } from "@assessiq/core";
import { withTenant } from "./with-tenant.js";
import { getPool } from "./pool.js";
import * as repo from "./repository.js";
import type { Tenant, TenantSettings } from "./types.js";
import { audit } from "@assessiq/audit-log";

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
