import { NotFoundError, streamLogger } from "@assessiq/core";
import { withTenant } from "./with-tenant.js";
import * as repo from "./repository.js";
import type { Tenant, TenantSettings } from "./types.js";

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

export async function getTenantBySlug(_slug: string): Promise<Tenant> {
  // Slug lookup needs the tenant context to be set, but we don't know the
  // tenant id yet. Slug lookup is therefore a system-level read that bypasses
  // RLS — used at the auth/login path before tenant context is established.
  // See modules/02-tenancy/SKILL.md § System-level escapes for the full design.
  // For Phase 0, we don't yet have a withSystemRole helper; slug lookup is
  // exposed only for the test harness and the future sessionLoader. Document
  // this in the SKILL.md "Status" section.
  // TODO(phase-1): replace with withSystemRole(...) once 14-audit-log lands
  //                and we can audit every system-role read.
  throw new Error("getTenantBySlug requires withSystemRole — Phase 1 work");
}

export async function updateTenantSettings(
  tenantId: string,
  patch: Parameters<typeof repo.updateTenantSettingsRow>[1],
): Promise<TenantSettings> {
  // Do NOT log the patch contents at INFO — TenantSettings JSONB may include
  // tenant-private branding URLs, webhook URLs, etc. CLAUDE.md hard rule #4.
  log.info({ tenantId }, "updateTenantSettings");
  return withTenant(tenantId, async (client) => {
    return repo.updateTenantSettingsRow(client, patch);
  });
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
