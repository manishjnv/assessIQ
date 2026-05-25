// modules/04-question-bank/src/platform-domains.ts
//
// Platform domain management (super-admin) + cross-tenant propagation.
//
// The platform master tenant (slug='platform') holds the canonical domain
// taxonomy. A super-admin can create / archive / reactivate a PLATFORM domain;
// each mutation is mirrored into every company tenant so the whole fleet shares
// one consistent domain set. Provenance (`domains.source`, migration 0091)
// keeps these operations from ever touching a tenant-LOCAL domain:
//
//   - create   → INSERT (source='platform') into the platform tenant + every
//                other tenant; ON CONFLICT (tenant_id, slug) DO NOTHING skips any
//                tenant that already has the slug (including a tenant-local one).
//   - archive  → flip status across rows WHERE slug=$ AND source='platform'.
//   - reactivate → same, status back to 'active'.
//
// CATALOG-ONLY semantics (decided 2026-05-25): archiving a platform domain
// removes it from selection dropdowns (which all filter status='active') and
// makes it non-grantable going forward, but does NOT revoke existing
// tenant_entitlements for that domain and does NOT untag existing packs /
// questions. Entitlements are decoupled from domain status by design (the
// publish/license gates compare slug strings and never JOIN `domains`), so this
// function never writes to the billing/access path. Reversible via reactivate.
//
// Cross-tenant writes run under SET LOCAL ROLE assessiq_system (BYPASSRLS); the
// audit row is written in the assessiq_app role + app.current_tenant GUC, in the
// SAME transaction, mirroring billing/service.ts grantEntitlement exactly (G3.D
// atomic-audit invariant). These are super-admin platform operations — the route
// layer (apps/api admin-super.ts) applies the super_admin + fresh-MFA gate.

import { ConflictError, NotFoundError, ValidationError, uuidv7 } from "@assessiq/core";
import { getPool } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import type { PoolClient } from "pg";

export interface PlatformDomainRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  display_order: number;
  source: string;
}

// UUID validator for the :id path param (defence-in-depth; route also validates).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Slug helper — identical to handlers/admin-domains.ts slugFromName (kept local
// so this file has no cross-import; the two must stay in sync).
function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

/** Resolve the platform (master-library) tenant id by its well-known slug. */
async function getPlatformTenantId(client: PoolClient): Promise<string | null> {
  const res = await client.query<{ id: string }>(
    `SELECT id FROM tenants WHERE slug = 'platform' LIMIT 1`,
  );
  return res.rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// READ — list the platform domain library (ALL statuses, for the management UI)
// ---------------------------------------------------------------------------

/**
 * List the platform master tenant's domains, every status (active + archived +
 * legacy inactive), so the super-admin UI can show the full library and offer
 * reactivate. Runs under assessiq_system (BYPASSRLS) — no app.current_tenant
 * needed. Returns [] if the platform tenant does not exist (fresh DB).
 */
export async function listPlatformDomains(): Promise<PlatformDomainRow[]> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE assessiq_system");
    const platformTenantId = await getPlatformTenantId(client);
    if (platformTenantId === null) {
      await client.query("COMMIT");
      return [];
    }
    const res = await client.query<PlatformDomainRow>(
      `SELECT id, slug, name, description, status, display_order, source
         FROM domains
        WHERE tenant_id = $1
        ORDER BY display_order ASC, slug ASC`,
      [platformTenantId],
    );
    await client.query("COMMIT");
    return res.rows;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// CREATE — new platform domain + propagate to every company tenant
// ---------------------------------------------------------------------------

export interface CreatePlatformDomainInput {
  name: string;
  description?: string;
}

export type CreatePlatformDomainOutput = PlatformDomainRow & { propagatedTenants: number };

/**
 * Create a platform domain and propagate it to every non-platform tenant.
 *
 * - slug = server-generated kebab-case(name); a duplicate platform slug → 409.
 * - The platform row is the canonical record (RETURNING-ed for the response).
 * - Propagation INSERT skips any tenant that already has the slug (ON CONFLICT),
 *   so a tenant-local domain on the same slug is preserved (source stays 'tenant').
 * - One audit row (domain.created) in the same transaction.
 */
export async function createPlatformDomain(
  actorUserId: string,
  input: CreatePlatformDomainInput,
): Promise<CreatePlatformDomainOutput> {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new ValidationError("name must not be empty", {
      details: { code: "MISSING_REQUIRED", field: "name" },
    });
  }
  if (name.length > 200) {
    throw new ValidationError("name must not exceed 200 characters", {
      details: { code: "INVALID_PARAM", field: "name" },
    });
  }
  const slug = slugFromName(name);
  if (slug.length === 0) {
    throw new ValidationError("name must contain at least one alphanumeric character", {
      details: { code: "INVALID_PARAM", field: "name" },
    });
  }

  const id = uuidv7();
  const description = input.description ?? null;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE assessiq_system");

    const platformTenantId = await getPlatformTenantId(client);
    if (platformTenantId === null) {
      throw new NotFoundError("platform tenant not found", {
        details: { code: "PLATFORM_TENANT_MISSING" },
      });
    }

    // Canonical platform row — display_order = MAX+1 within the platform tenant.
    const orderRes = await client.query<{ max: number | null }>(
      "SELECT MAX(display_order) AS max FROM domains WHERE tenant_id = $1",
      [platformTenantId],
    );
    const nextOrder = (orderRes.rows[0]?.max ?? 0) + 1;

    let domainRow: PlatformDomainRow;
    try {
      const res = await client.query<PlatformDomainRow>(
        `INSERT INTO domains (id, tenant_id, slug, name, description, source, status, display_order)
         VALUES ($1, $2, $3, $4, $5, 'platform', 'active', $6)
         RETURNING id, slug, name, description, status, display_order, source`,
        [id, platformTenantId, slug, name, description, nextOrder],
      );
      domainRow = res.rows[0]!;
    } catch (err: unknown) {
      if (
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: string }).code === "23505"
      ) {
        throw new ConflictError(`A platform domain with slug '${slug}' already exists.`, {
          details: { code: "DOMAIN_SLUG_EXISTS", slug },
        });
      }
      throw err;
    }

    // Propagate to every NON-platform tenant. Per-tenant display_order = MAX+1.
    // ON CONFLICT skips a tenant that already has the slug — a tenant-local
    // domain on the same slug is left untouched (its source stays 'tenant').
    const propRes = await client.query(
      `INSERT INTO domains (tenant_id, slug, name, description, source, status, display_order)
       SELECT t.id, $2, $3, $4, 'platform', 'active',
              COALESCE((SELECT MAX(d.display_order) FROM domains d WHERE d.tenant_id = t.id), 0) + 1
         FROM tenants t
        WHERE t.id <> $1
       ON CONFLICT (tenant_id, slug) DO NOTHING`,
      [platformTenantId, slug, name, description],
    );
    const propagatedTenants = propRes.rowCount ?? 0;

    // Audit in the assessiq_app role + tenant GUC context (auditInTx contract).
    await client.query("SET LOCAL ROLE assessiq_app");
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [platformTenantId]);
    await auditInTx(client, {
      action: "domain.created",
      actorKind: "user",
      actorUserId,
      tenantId: platformTenantId,
      entityType: "domain",
      entityId: domainRow.id,
      after: {
        slug,
        name,
        source: "platform",
        status: "active",
        propagated_tenants: propagatedTenants,
      },
    });

    await client.query("COMMIT");
    return { ...domainRow, propagatedTenants };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// ARCHIVE / REACTIVATE — flip status across all platform-origin copies
// ---------------------------------------------------------------------------

export type PlatformDomainStatus = "active" | "archived";

export type SetPlatformDomainStatusOutput = PlatformDomainRow & { affectedRows: number };

/**
 * Archive ('archived') or reactivate ('active') a platform domain and propagate
 * the status to every platform-origin copy of that slug across all tenants.
 *
 * - `domainId` MUST be a row in the platform tenant — passing a tenant-local
 *   domain id returns 404 (DOMAIN_NOT_FOUND). This is the guard that stops a
 *   super-admin from archiving a single tenant's local domain through this path.
 * - Propagation matches `slug = $ AND source = 'platform'`, so tenant-local
 *   domains sharing the slug are never touched.
 * - CATALOG-ONLY: no entitlement writes, no content untagging.
 * - One audit row (domain.archived | domain.reactivated) in the same transaction.
 */
export async function setPlatformDomainStatus(
  actorUserId: string,
  domainId: string,
  status: PlatformDomainStatus,
): Promise<SetPlatformDomainStatusOutput> {
  if (!UUID_RE.test(domainId)) {
    throw new ValidationError("domainId must be a valid UUID", {
      details: { code: "INVALID_PARAM", field: "id" },
    });
  }
  if (status !== "active" && status !== "archived") {
    throw new ValidationError('status must be "active" or "archived"', {
      details: { code: "INVALID_STATUS", received: status },
    });
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE assessiq_system");

    const platformTenantId = await getPlatformTenantId(client);
    if (platformTenantId === null) {
      throw new NotFoundError("platform tenant not found", {
        details: { code: "PLATFORM_TENANT_MISSING" },
      });
    }

    // Lock + verify the target is a PLATFORM domain (lives in the platform tenant
    // AND source='platform'). FOR UPDATE matches the tenant-rename pattern.
    const found = await client.query<{ slug: string; source: string }>(
      `SELECT slug, source FROM domains
        WHERE id = $1 AND tenant_id = $2
        FOR UPDATE`,
      [domainId, platformTenantId],
    );
    const target = found.rows[0];
    if (target === undefined || target.source !== "platform") {
      throw new NotFoundError("platform domain not found", {
        details: { code: "DOMAIN_NOT_FOUND", id: domainId },
      });
    }
    const slug = target.slug;

    // Flip status across every platform-origin copy of this slug (incl. the
    // platform row itself). Tenant-local rows (source='tenant') are untouched.
    const updRes = await client.query<PlatformDomainRow>(
      `UPDATE domains
          SET status = $1, updated_at = now()
        WHERE slug = $2 AND source = 'platform'`,
      [status, slug],
    );
    const affectedRows = updRes.rowCount ?? 0;

    // Re-read the canonical platform row for the response.
    const after = await client.query<PlatformDomainRow>(
      `SELECT id, slug, name, description, status, display_order, source
         FROM domains
        WHERE id = $1 AND tenant_id = $2`,
      [domainId, platformTenantId],
    );
    const domainRow = after.rows[0]!;

    // Audit in the assessiq_app role + tenant GUC context (auditInTx contract).
    await client.query("SET LOCAL ROLE assessiq_app");
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [platformTenantId]);
    await auditInTx(client, {
      action: status === "archived" ? "domain.archived" : "domain.reactivated",
      actorKind: "user",
      actorUserId,
      tenantId: platformTenantId,
      entityType: "domain",
      entityId: domainId,
      after: { slug, status, affected_rows: affectedRows },
    });

    await client.query("COMMIT");
    return { ...domainRow, affectedRows };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
