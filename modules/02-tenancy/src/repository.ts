import type { PoolClient } from "pg";
import { NotFoundError } from "@assessiq/core";
import type { Tenant, TenantSettings } from "./types.js";

const TENANT_COLUMNS = `id, slug, name, domain, branding, status, created_at, updated_at`;

const SETTINGS_COLUMNS = `tenant_id, auth_methods, ai_grading_enabled, ai_model_tier, features, webhook_secret, data_region, updated_at`;

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

export async function findTenantSettings(client: PoolClient): Promise<TenantSettings | null> {
  // RLS restricts visibility to the current tenant's single row. LIMIT 1 is
  // belt-and-braces; tenant_settings.tenant_id is the primary key.
  const result = await client.query<SettingsRow>(
    `SELECT ${SETTINGS_COLUMNS} FROM tenant_settings LIMIT 1`,
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
