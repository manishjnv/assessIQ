// modules/02-tenancy/src/purge.ts
// RW-48b — retention purge of archived tenants. No AI, no worker-side AI calls.
//
// SELECTION: tenants.status = 'archived' AND updated_at <= now - minDays. There is
// no archived_at column: archiveTenant stamps updated_at in the same UPDATE, and an
// archived tenant is otherwise frozen, so updated_at is the archive time (a later
// rename only delays the purge, the safe direction). minDays is clamped to >= 180.
// The platform tenant (config.PLATFORM_TENANT_ID, and slug 'platform') is never selected.
//
// PURGE (per tenant, own withSystemRole tx, so one failure rolls back only that
// tenant): DELETE ... WHERE tenant_id = $1 on every public base table that has a
// tenant_id column, except audit_log (append-only), tenants (tombstone) and users.
// Tables WITHOUT tenant_id that FK to users(id) are cleared for the tenant's users.
// Users are kept as pseudonymised tombstones (same rule as 20-data-rights erasure.ts
// step 3) because audit_log.actor_user_id keeps its FK. Tables and FK-safe order come
// from the catalog (pg_constraint), not a hand list. Then status -> 'purged' and one
// 'tenant.purged' audit row with per-table counts, all in the same tx.
//
// GATE: enabled=false (default) is a dry run: reports candidates, changes no rows.

import type { PoolClient } from "pg";
import { config, streamLogger } from "@assessiq/core";
import { auditInTx } from "@assessiq/audit-log";
import { withSystemRole } from "./with-tenant.js";

const log = streamLogger("app");

export const MIN_PURGE_DAYS = 180;

export interface PurgeOptions {
  now?: Date;
  /** false (default) = dry run. */
  enabled?: boolean;
  /** Clamped to >= 180. */
  minDays?: number;
}

export interface TenantPurgeReport {
  tenantId: string;
  purged: boolean;
  /** table -> rows deleted, plus users_pseudonymised (non-zero only for tables). Empty on dry run or error. */
  counts: Record<string, number>;
  error?: string;
}

export interface PurgeReport {
  dryRun: boolean;
  minDays: number;
  tenants: TenantPurgeReport[];
}

const qi = (id: string): string => `"${id.replace(/"/g, '""')}"`;

interface Step {
  table: string;
  sql: string;
}

/** DELETE steps, children before parents. Cycles (none today) fall through and fail loudly in the DB. */
async function deleteOrder(client: PoolClient): Promise<Step[]> {
  const t = await client.query<{ table_name: string }>(
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
        AND t.table_type = 'BASE TABLE' AND c.table_name NOT IN ('audit_log', 'tenants', 'users')`,
  );
  // Tables with no tenant_id column that FK to users(id): clear rows of the tenant's users.
  const u = await client.query<{ table_name: string; col: string }>(
    `SELECT cc.relname AS table_name, a.attname AS col
       FROM pg_constraint k
       JOIN pg_class cc ON cc.oid = k.conrelid
       JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
      WHERE k.contype = 'f' AND k.connamespace = 'public'::regnamespace
        AND k.confrelid = 'users'::regclass AND array_length(k.conkey, 1) = 1
        AND cc.relkind = 'r' AND cc.relname NOT IN ('audit_log', 'users')
        AND NOT EXISTS (SELECT 1 FROM information_schema.columns c
                         WHERE c.table_schema = 'public' AND c.table_name = cc.relname
                           AND c.column_name = 'tenant_id')`,
  );
  const e = await client.query<{ child: string; parent: string }>(
    `SELECT cc.relname AS child, pc.relname AS parent
       FROM pg_constraint k
       JOIN pg_class cc ON cc.oid = k.conrelid
       JOIN pg_class pc ON pc.oid = k.confrelid
      WHERE k.contype = 'f' AND k.connamespace = 'public'::regnamespace`,
  );
  const sql = new Map<string, string>();
  for (const r of t.rows) sql.set(r.table_name, `DELETE FROM ${qi(r.table_name)} WHERE tenant_id = $1`);
  for (const r of u.rows) {
    sql.set(
      r.table_name,
      `DELETE FROM ${qi(r.table_name)} WHERE ${qi(r.col)} IN (SELECT id FROM users WHERE tenant_id = $1)`,
    );
  }
  const left = new Set(sql.keys());
  const order: Step[] = [];
  while (left.size > 0) {
    const ready = [...left].filter(
      (x) => !e.rows.some((r) => r.parent === x && r.child !== x && left.has(r.child)),
    );
    const batch = ready.length > 0 ? ready : [...left]; // cycle: let the DB report it
    for (const x of batch.sort()) {
      order.push({ table: x, sql: sql.get(x)! });
      left.delete(x);
    }
  }
  return order;
}

export async function purgeArchivedTenants(opts: PurgeOptions = {}): Promise<PurgeReport> {
  const now = opts.now ?? new Date();
  const dryRun = opts.enabled !== true;
  const minDays = Math.max(MIN_PURGE_DAYS, Math.floor(opts.minDays ?? MIN_PURGE_DAYS));
  const platformId = config.PLATFORM_TENANT_ID ?? null;

  const { ids, order } = await withSystemRole("tenant purge: select archived tenants", async (client) => {
    const r = await client.query<{ id: string }>(
      `SELECT id FROM tenants
        WHERE status = 'archived' AND slug <> 'platform'
          AND ($3::uuid IS NULL OR id <> $3::uuid)
          AND updated_at <= $1::timestamptz - make_interval(days => $2::int)
        ORDER BY updated_at`,
      [now.toISOString(), minDays, platformId],
    );
    return { ids: r.rows.map((x) => x.id), order: dryRun ? [] : await deleteOrder(client) };
  });

  log.info({ candidates: ids.length, dryRun, minDays }, "tenant.purge: sweep starting");
  const tenants: TenantPurgeReport[] = [];
  for (const tenantId of ids) {
    if (dryRun) {
      tenants.push({ tenantId, purged: false, counts: {} });
      continue;
    }
    try {
      const counts = await withSystemRole("tenant purge: delete archived tenant data", async (client) => {
        // Re-check inside the tx: the tenant may have been unarchived since selection.
        const cur = await client.query(`SELECT 1 FROM tenants WHERE id = $1 AND status = 'archived' FOR UPDATE`, [tenantId]);
        if (cur.rowCount === 0) return null;
        const out: Record<string, number> = {};
        for (const step of order) {
          const d = await client.query(step.sql, [tenantId]);
          if ((d.rowCount ?? 0) > 0) out[step.table] = d.rowCount ?? 0;
        }
        const pu = await client.query(
          `UPDATE users
              SET name      = 'deleted_user_' || substr(encode(sha256(id::text::bytea),'hex'),1,12),
                  email     = 'deleted+' || substr(encode(sha256(id::text::bytea),'hex'),1,12) || '@erased.assessiq.local',
                  metadata  = COALESCE(metadata, '{}'::jsonb) - 'roll_number' - 'branch',
                  erased_at = COALESCE(erased_at, now())
            WHERE tenant_id = $1`,
          [tenantId],
        );
        out["users_pseudonymised"] = pu.rowCount ?? 0;
        await client.query(`UPDATE tenants SET status = 'purged', updated_at = now() WHERE id = $1`, [tenantId]);
        await auditInTx(client, {
          tenantId,
          actorKind: "system",
          action: "tenant.purged",
          entityType: "tenant",
          entityId: tenantId,
          after: { counts: out, minDays },
        });
        return out;
      });
      tenants.push({ tenantId, purged: counts !== null, counts: counts ?? {} });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error({ tenantId, error }, "tenant.purge: tenant failed; continuing sweep");
      tenants.push({ tenantId, purged: false, counts: {}, error });
    }
  }
  return { dryRun, minDays, tenants };
}
