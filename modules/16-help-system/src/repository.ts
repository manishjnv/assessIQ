/**
 * Help-content repository.
 *
 * CONTRACT: caller is responsible for tenant context (GUC / RLS).
 * This file NEVER includes `WHERE tenant_id = $n` — RLS enforces isolation.
 *
 * RLS policy on help_content uses the nullable-tenant variant:
 *   USING (tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant')::uuid)
 * That means when `app.current_tenant` is set, BOTH the matching tenant row
 * AND the global (tenant_id IS NULL) row are visible in a single SELECT.
 * The service layer is responsible for preferring the tenant override over the
 * global when both are returned for the same (key, locale).
 *
 * When `app.current_tenant` is NOT set (anonymous / globals-only mode, see
 * service.ts `withGlobalsOnly`), only `tenant_id IS NULL` rows pass RLS,
 * because `current_setting('app.current_tenant', true)` returns NULL and the
 * `::uuid` cast of NULL IS NULL, which makes the `= current_setting(...)::uuid`
 * predicate false, leaving only the `tenant_id IS NULL` arm true.
 */

import type { PoolClient } from "pg";
import type { Audience, HelpEntry, UpsertHelpInput } from "./types.js";

// ---------------------------------------------------------------------------
// Row mapper — snake_case (DB) → camelCase (TS)
// ---------------------------------------------------------------------------

function mapRow(r: Record<string, unknown>): HelpEntry {
  return {
    id: r["id"] as string,
    tenantId: (r["tenant_id"] as string | null) ?? null,
    key: r["key"] as string,
    audience: r["audience"] as HelpEntry["audience"],
    locale: r["locale"] as string,
    shortText: r["short_text"] as string,
    longMd: (r["long_md"] as string | null) ?? null,
    version: r["version"] as number,
    status: r["status"] as HelpEntry["status"],
    updatedAt:
      r["updated_at"] instanceof Date
        ? (r["updated_at"] as Date).toISOString()
        : (r["updated_at"] as string),
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Returns all active rows matching the page prefix and audience.
 *
 * `page` is matched via `key LIKE page || '.%'` so a request for
 * 'admin.assessments.create' returns keys like
 * 'admin.assessments.create.duration', 'admin.assessments.create.page', etc.
 *
 * Both the global row (tenant_id IS NULL) and any tenant override are returned
 * when RLS allows it. The service layer deduplicates and prefers the override.
 */
export async function listHelpForPage(
  client: PoolClient,
  page: string,
  audience: Audience,
  locale: string,
): Promise<HelpEntry[]> {
  const res = await client.query<Record<string, unknown>>(
    `SELECT id, tenant_id, key, audience, locale, short_text, long_md,
            version, status, updated_at
       FROM help_content
      WHERE key LIKE $1
        AND (audience = $2 OR audience = 'all')
        AND locale = $3
        AND status = 'active'
      ORDER BY key, tenant_id NULLS LAST`,
    [`${page}.%`, audience, locale],
  );
  return res.rows.map(mapRow);
}

/**
 * Returns 0–2 rows for a single key: the global (tenant_id IS NULL) and/or
 * the tenant override (tenant_id IS NOT NULL), depending on what RLS allows.
 * The service layer chooses which to surface.
 */
export async function getHelpKey(
  client: PoolClient,
  key: string,
  locale: string,
): Promise<HelpEntry[]> {
  const res = await client.query<Record<string, unknown>>(
    `SELECT id, tenant_id, key, audience, locale, short_text, long_md,
            version, status, updated_at
       FROM help_content
      WHERE key = $1
        AND locale = $2
        AND status = 'active'
      ORDER BY tenant_id NULLS LAST`,
    [key, locale],
  );
  return res.rows.map(mapRow);
}

/**
 * Upserts a tenant-scoped help entry.
 *
 * Inserts a new row with version = MAX(version)+1 for the (tenant_id, key,
 * locale) group, or 1 if no prior row exists.
 *
 * NEVER passes tenant_id=NULL — the INSERT RLS policy blocks it, and the
 * service contract requires callers to always supply a real tenant UUID.
 */
export async function upsertHelp(
  client: PoolClient,
  tenantId: string,
  key: string,
  input: UpsertHelpInput,
): Promise<HelpEntry> {
  const locale = input.locale ?? "en";
  const res = await client.query<Record<string, unknown>>(
    `INSERT INTO help_content
       (tenant_id, key, audience, locale, short_text, long_md, version, status, updated_at)
     VALUES (
       $1, $2, $3, $4, $5, $6,
       COALESCE(
         (SELECT MAX(version) + 1 FROM help_content WHERE tenant_id = $1 AND key = $2 AND locale = $4),
         1
       ),
       'active',
       now()
     )
     RETURNING id, tenant_id, key, audience, locale, short_text, long_md, version, status, updated_at`,
    [tenantId, key, input.audience, locale, input.shortText, input.longMd ?? null],
  );
  const row = res.rows[0];
  if (row === undefined) {
    throw new Error(`upsertHelp: no row returned for key=${key}`);
  }
  return mapRow(row);
}

/**
 * Returns all active help rows visible to the current tenant context.
 * Used by the export endpoint.
 */
export async function exportTenantHelp(
  client: PoolClient,
  locale: string,
): Promise<HelpEntry[]> {
  const res = await client.query<Record<string, unknown>>(
    `SELECT id, tenant_id, key, audience, locale, short_text, long_md,
            version, status, updated_at
       FROM help_content
      WHERE locale = $1
        AND status = 'active'
      ORDER BY key, tenant_id NULLS LAST`,
    [locale],
  );
  return res.rows.map(mapRow);
}

/**
 * Bulk upsert. Each row is individually upserted; rows that raise a unique
 * constraint violation (tenant_id, key, locale, version) are counted as
 * skipped (idempotent re-import).
 */
export async function bulkUpsertHelp(
  client: PoolClient,
  tenantId: string,
  rows: Array<{ key: string; input: UpsertHelpInput }>,
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;

  for (const { key, input } of rows) {
    try {
      await upsertHelp(client, tenantId, key, input);
      inserted++;
    } catch (err: unknown) {
      // Postgres unique_violation = code '23505'. Treat as skipped.
      if (
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: string }).code === "23505"
      ) {
        skipped++;
      } else {
        throw err;
      }
    }
  }

  return { inserted, skipped };
}
