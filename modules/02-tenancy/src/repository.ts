import type { PoolClient } from "pg";
import { NotFoundError } from "@assessiq/core";
import type { Tenant, TenantSettings } from "./types.js";

const TENANT_COLUMNS = `id, slug, name, domain, branding, status, created_at, updated_at`;

const SETTINGS_COLUMNS = `tenant_id, auth_methods, ai_grading_enabled, ai_model_tier, features, webhook_secret, data_region, ai_generate_mode, ai_grading_scope, retention_days, result_release_mode, result_release_auto_since, certificate_show_distinction, updated_at`;

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  domain: string | null;
  branding: unknown;
  status: string;
  created_at: Date;
  updated_at: Date;
}

interface SettingsRow {
  tenant_id: string;
  auth_methods: unknown;
  ai_grading_enabled: boolean;
  ai_model_tier: string;
  features: unknown;
  webhook_secret: string | null;
  data_region: string;
  ai_generate_mode: string | null;
  ai_grading_scope: string;
  retention_days: number | string;   // pg may return INT as number or string depending on version
  result_release_mode: string;
  result_release_auto_since: Date | null;
  certificate_show_distinction: boolean;
  updated_at: Date;
}

function mapTenantRow(row: TenantRow): Tenant {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    domain: row.domain,
    branding: (row.branding as Tenant["branding"]) ?? {},
    status: row.status as Tenant["status"],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapSettingsRow(row: SettingsRow): TenantSettings {
  return {
    tenant_id: row.tenant_id,
    auth_methods: (row.auth_methods as TenantSettings["auth_methods"]) ?? {},
    ai_grading_enabled: row.ai_grading_enabled,
    ai_model_tier: row.ai_model_tier as TenantSettings["ai_model_tier"],
    features: (row.features as Record<string, unknown>) ?? {},
    webhook_secret: row.webhook_secret,
    data_region: row.data_region,
    ai_generate_mode: (row.ai_generate_mode as TenantSettings["ai_generate_mode"]) ?? null,
    ai_grading_scope: row.ai_grading_scope === "none" ? "none" : "written",
    retention_days: typeof row.retention_days === "number"
      ? row.retention_days
      : Number.parseInt(String(row.retention_days), 10),
    result_release_mode: row.result_release_mode as TenantSettings["result_release_mode"],
    result_release_auto_since: row.result_release_auto_since,
    certificate_show_distinction: row.certificate_show_distinction,
    updated_at: row.updated_at,
  };
}

export async function findTenantById(client: PoolClient, id: string): Promise<Tenant | null> {
  const result = await client.query<TenantRow>(
    `SELECT ${TENANT_COLUMNS} FROM tenants WHERE id = $1 LIMIT 1`,
    [id],
  );
  const row = result.rows[0];
  return row !== undefined ? mapTenantRow(row) : null;
}

export async function findTenantBySlug(client: PoolClient, slug: string): Promise<Tenant | null> {
  const result = await client.query<TenantRow>(
    `SELECT ${TENANT_COLUMNS} FROM tenants WHERE slug = $1 LIMIT 1`,
    [slug],
  );
  const row = result.rows[0];
  return row !== undefined ? mapTenantRow(row) : null;
}

// NOTE on the absence of `WHERE tenant_id = $1` filters in tenant_settings
// queries below: the caller must have invoked these inside a `withTenant`
// transaction. RLS then scopes every query to the current tenant's row.
// Adding a WHERE tenant_id filter would mask RLS bugs (a misconfigured
// role with BYPASSRLS would still return the right row because of the
// WHERE — silent regression). CLAUDE.md anti-pattern, deliberate.
//
// `tenants` queries below (findTenantById, setTenantStatus) use
// `WHERE id = $1` which is the primary-key lookup, not a tenant_id filter.
// RLS on the tenants table also pins to id = current_setting(...), so the
// WHERE is consistent with RLS rather than redundant.

export async function findTenantSettings(client: PoolClient, forUpdate = false): Promise<TenantSettings | null> {
  // RLS restricts visibility to the current tenant's single row. LIMIT 1 is
  // belt-and-braces; tenant_settings.tenant_id is the primary key.
  const result = await client.query<SettingsRow>(
    `SELECT ${SETTINGS_COLUMNS} FROM tenant_settings LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
  );
  const row = result.rows[0];
  return row !== undefined ? mapSettingsRow(row) : null;
}

export async function updateTenantSettingsRow(
  client: PoolClient,
  patch: Partial<Pick<TenantSettings, "auth_methods" | "ai_grading_enabled" | "ai_model_tier" | "features" | "data_region">>,
): Promise<TenantSettings> {
  // Build a dynamic UPDATE preserving the existing JSONB merge semantics for
  // auth_methods and features. Scalar fields overwrite directly.
  // No WHERE tenant_id filter — RLS scopes the UPDATE to the current
  // tenant's row (the only row visible inside the transaction).
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (patch.auth_methods !== undefined) {
    sets.push(`auth_methods = auth_methods || $${i}::jsonb`);
    values.push(JSON.stringify(patch.auth_methods));
    i++;
  }
  if (patch.features !== undefined) {
    sets.push(`features = features || $${i}::jsonb`);
    values.push(JSON.stringify(patch.features));
    i++;
  }
  if (patch.ai_grading_enabled !== undefined) {
    sets.push(`ai_grading_enabled = $${i}`);
    values.push(patch.ai_grading_enabled);
    i++;
  }
  if (patch.ai_model_tier !== undefined) {
    sets.push(`ai_model_tier = $${i}`);
    values.push(patch.ai_model_tier);
    i++;
  }
  if (patch.data_region !== undefined) {
    sets.push(`data_region = $${i}`);
    values.push(patch.data_region);
    i++;
  }

  if (sets.length === 0) {
    // No-op patch: just return the current row.
    const current = await findTenantSettings(client);
    if (current === null) {
      throw new NotFoundError(`tenant_settings not found for current tenant context`);
    }
    return current;
  }

  sets.push(`updated_at = now()`);

  const result = await client.query<SettingsRow>(
    `UPDATE tenant_settings SET ${sets.join(", ")} RETURNING ${SETTINGS_COLUMNS}`,
    values,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new NotFoundError(`tenant_settings not found for current tenant context`);
  }
  return mapSettingsRow(row);
}

export async function setTenantStatus(client: PoolClient, id: string, status: "active" | "suspended" | "archived"): Promise<void> {
  await client.query(
    `UPDATE tenants SET status = $1, updated_at = now() WHERE id = $2`,
    [status, id],
  );
}

// ---------------------------------------------------------------------------
// RW-36(a): queries moved out of apps/api routes (super-admin tenants, embed
// secrets). SQL text and parameter order are unchanged from the route copies.
// ---------------------------------------------------------------------------

/** Row-lock a tenant and read its display name (withTenant client). */
export async function lockTenantNameForUpdate(
  client: PoolClient,
  tenantId: string,
): Promise<{ name: string } | undefined> {
  const cur = await client.query<{ name: string }>(
    `SELECT name FROM tenants WHERE id = $1 FOR UPDATE`,
    [tenantId],
  );
  return cur.rows[0];
}

export async function updateTenantName(
  client: PoolClient,
  name: string,
  tenantId: string,
): Promise<void> {
  await client.query(`UPDATE tenants SET name = $1, updated_at = now() WHERE id = $2`, [
    name,
    tenantId,
  ]);
}

export async function findPrivacyDisclosed(
  client: PoolClient,
  tenantId: string,
): Promise<{ privacy_disclosed: boolean } | null> {
  const result = await client.query<{ privacy_disclosed: boolean }>(
    `SELECT privacy_disclosed FROM tenants WHERE id = $1 LIMIT 1`,
    [tenantId],
  );
  return result.rows[0] ?? null;
}

export interface TenantAdminSummaryRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  is_school: boolean;
  created_at: Date;
  admin_user_id: string | null;
  admin_email: string | null;
  admin_name: string | null;
  admin_role: string | null;
  admin_status: string | null;
  admin_invitation_id: string | null;
  admin_invitation_expires_at: Date | null;
  admin_count: number;
  reviewer_count: number;
}

/** Cross-tenant listing; caller MUST run it under assessiq_system (BYPASSRLS). */
export async function listTenantsWithAdminSummary(
  client: PoolClient,
  includeArchived: boolean,
): Promise<TenantAdminSummaryRow[]> {
  const result = await client.query<TenantAdminSummaryRow>(
    // admin_user_id / admin_role / admin_invitation_id let the Platform UI
    // target the primary-contact admin precisely for the inline edit modal
    // (PATCH /api/admin/super/users/:userId). The invitation id is the
    // outstanding (unaccepted) invite for that admin, used to re-address a
    // pending invite when its email is corrected.
    `SELECT t.id, t.slug, t.name, t.status, t.is_school, t.created_at,
                  a.id     AS admin_user_id,
                  a.email  AS admin_email,
                  a.name   AS admin_name,
                  a.role   AS admin_role,
                  a.status AS admin_status,
                  i.id         AS admin_invitation_id,
                  i.expires_at AS admin_invitation_expires_at,
                  COALESCE(ac.cnt, 0)::int AS admin_count,
                  COALESCE(rc.cnt, 0)::int AS reviewer_count
           FROM tenants t
           LEFT JOIN LATERAL (
             SELECT u.id, u.email, u.name, u.role, u.status
             FROM users u
             WHERE u.tenant_id = t.id AND u.role = 'admin'
             ORDER BY u.created_at ASC
             LIMIT 1
           ) a ON true
           LEFT JOIN LATERAL (
             SELECT ui.id, ui.expires_at
             FROM user_invitations ui
             WHERE ui.tenant_id = t.id
               AND lower(ui.email) = a.email
               AND ui.accepted_at IS NULL
             ORDER BY ui.created_at DESC
             LIMIT 1
           ) i ON true
           LEFT JOIN LATERAL (
             SELECT COUNT(*) AS cnt
             FROM users u
             WHERE u.tenant_id = t.id
               AND u.role = 'admin'
               AND u.status = 'active'
               AND u.deleted_at IS NULL
           ) ac ON true
           LEFT JOIN LATERAL (
             SELECT COUNT(*) AS cnt
             FROM users u
             WHERE u.tenant_id = t.id
               AND u.role = 'reviewer'
               AND u.status = 'active'
               AND u.deleted_at IS NULL
           ) rc ON true
           ${includeArchived ? '' : "WHERE t.status NOT IN ('archived', 'purged')"}
           ORDER BY t.created_at ASC`,
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Tenant logo (migration 0183). RLS confines every query to the current tenant.
// ---------------------------------------------------------------------------

export interface TenantLogoMeta {
  mime: "image/png" | "image/jpeg";
  width: number;
  height: number;
  byte_size: number;
  sha256: string;
  updated_at: Date;
}

const LOGO_META_COLUMNS = `mime, width, height, byte_size, sha256, updated_at`;

export async function findLogoMeta(client: PoolClient): Promise<TenantLogoMeta | null> {
  const r = await client.query<TenantLogoMeta>(`SELECT ${LOGO_META_COLUMNS} FROM tenant_logos LIMIT 1`);
  return r.rows[0] ?? null;
}

export async function findLogoBytes(
  client: PoolClient,
): Promise<{ mime: TenantLogoMeta["mime"]; bytes: Buffer; sha256: string } | null> {
  const r = await client.query<{ mime: TenantLogoMeta["mime"]; bytes: Buffer; sha256: string }>(
    `SELECT mime, bytes, sha256 FROM tenant_logos LIMIT 1`,
  );
  return r.rows[0] ?? null;
}

export async function upsertLogo(
  client: PoolClient,
  tenantId: string,
  v: { mime: string; bytes: Buffer; sha256: string; width: number; height: number },
  actorUserId: string,
): Promise<TenantLogoMeta> {
  const r = await client.query<TenantLogoMeta>(
    `INSERT INTO tenant_logos (tenant_id, mime, bytes, sha256, width, height, byte_size, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tenant_id) DO UPDATE SET
       mime = EXCLUDED.mime, bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256,
       width = EXCLUDED.width, height = EXCLUDED.height, byte_size = EXCLUDED.byte_size,
       updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING ${LOGO_META_COLUMNS}`,
    [tenantId, v.mime, v.bytes, v.sha256, v.width, v.height, v.bytes.length, actorUserId],
  );
  return r.rows[0]!;
}

export async function deleteLogo(client: PoolClient): Promise<boolean> {
  const r = await client.query(`DELETE FROM tenant_logos`);
  return (r.rowCount ?? 0) > 0;
}

/** Z-119: set or clear branding.primary; returns the previous value, or undefined when the tenant row is missing. */
export async function updateBrandingPrimary(
  client: PoolClient,
  tenantId: string,
  hex: string | null,
): Promise<string | null | undefined> {
  const cur = await client.query<{ primary: string | null }>(
    `SELECT branding->>'primary' AS "primary" FROM tenants WHERE id = $1 FOR UPDATE`,
    [tenantId],
  );
  if (cur.rows[0] === undefined) return undefined;
  await client.query(
    `UPDATE tenants
        SET branding = CASE WHEN $1::text IS NULL THEN COALESCE(branding, '{}'::jsonb) - 'primary'
                            ELSE jsonb_set(COALESCE(branding, '{}'::jsonb), '{primary}', to_jsonb($1::text)) END,
            updated_at = now()
      WHERE id = $2`,
    [hex, tenantId],
  );
  return cur.rows[0].primary;
}
