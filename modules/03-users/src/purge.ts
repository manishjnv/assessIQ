// modules/03-users/src/purge.ts
// LC-2 — retention purge of soft-deleted users. No AI, no worker-side AI calls.
//
// SELECTION: users.deleted_at <= now - minDays AND erased_at IS NULL. minDays is
// clamped to >= 180. Platform-tenant users and role 'super_admin' are never purged
// (reported as skipped). A last active admin is skipped too (assertNotLastAdmin).
//
// PURGE (per tenant, one withTenant tx; one failing tenant rolls back only itself):
// re-read the user FOR UPDATE (skip if restored), delete the auth-chain rows found
// in the catalog (every FK to users(id) with ON DELETE CASCADE), delete invitations
// for the same email and the user's in-app notifications, then pseudonymise the
// users row (same rule as 02-tenancy purge.ts and 20-data-rights erasure.ts step 3)
// and write one 'user.purged' audit row. The users row is KEPT, as a tombstone,
// because audit_log.actor_user_id and attempts.user_id still reference it.
//
// GATE: enabled=false (default) is a dry run: selection and the admin checks run,
// no row changes. In a dry run `purged` lists the users that WOULD be purged.

import type { PoolClient } from 'pg';
import { config, ConflictError, streamLogger } from '@assessiq/core';
import { auditInTx } from '@assessiq/audit-log';
import { withSystemRole, withTenant } from '@assessiq/tenancy';
import { assertNotLastAdmin } from './invariants.js';

const log = streamLogger('app');

export const MIN_USER_PURGE_DAYS = 180;

export interface UserPurgeOptions {
  now?: Date;
  /** false (default) = dry run. */
  enabled?: boolean;
  /** Clamped to >= 180. */
  minDays?: number;
}

export type UserPurgeSkipReason = 'last_admin' | 'super_admin' | 'platform_tenant' | 'restored';

export interface UserPurgeTenantReport {
  tenantId: string;
  /** User ids purged (dry run: user ids that would be purged). */
  purged: string[];
  skipped: Array<{ userId: string; reason: UserPurgeSkipReason }>;
  error?: string;
}

export interface UserPurgeReport {
  dryRun: boolean;
  tenants: UserPurgeTenantReport[];
  totalPurged: number;
}

const qi = (id: string): string => `"${id.replace(/"/g, '""')}"`;

interface Candidate {
  id: string;
  tenant_id: string;
  role: string;
  platform: boolean;
}

/** Tables with an ON DELETE CASCADE single-column FK to users(id), sorted by name. */
async function cascadeTargets(client: PoolClient): Promise<Array<{ table: string; col: string }>> {
  const r = await client.query<{ table_name: string; col: string }>(
    `SELECT cc.relname AS table_name, a.attname AS col
       FROM pg_constraint k
       JOIN pg_class cc ON cc.oid = k.conrelid
       JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
      WHERE k.contype = 'f' AND k.connamespace = 'public'::regnamespace
        AND k.confrelid = 'users'::regclass AND k.confdeltype = 'c'
        AND array_length(k.conkey, 1) = 1
        AND cc.relkind = 'r' AND cc.relname NOT IN ('audit_log', 'users')
      ORDER BY cc.relname, a.attname`,
  );
  return r.rows.map((x) => ({ table: x.table_name, col: x.col }));
}

function isLastAdmin(err: unknown): boolean {
  return (
    err instanceof ConflictError &&
    (err.details as { code?: string } | undefined)?.code === 'LAST_ADMIN'
  );
}

export async function purgeSoftDeletedUsers(opts: UserPurgeOptions = {}): Promise<UserPurgeReport> {
  const now = opts.now ?? new Date();
  const dryRun = opts.enabled !== true;
  const minDays = Math.max(MIN_USER_PURGE_DAYS, Math.floor(opts.minDays ?? MIN_USER_PURGE_DAYS));
  const platformId = config.PLATFORM_TENANT_ID ?? null;

  const { candidates, targets } = await withSystemRole('user purge: select soft-deleted users', async (client) => {
    const r = await client.query<Candidate>(
      `SELECT u.id, u.tenant_id, u.role,
              (t.slug = 'platform' OR ($3::uuid IS NOT NULL AND u.tenant_id = $3::uuid)) AS platform
         FROM users u JOIN tenants t ON t.id = u.tenant_id
        WHERE u.deleted_at IS NOT NULL AND u.erased_at IS NULL
          AND u.deleted_at <= $1::timestamptz - make_interval(days => $2::int)
        ORDER BY u.tenant_id, u.deleted_at, u.id`,
      [now.toISOString(), minDays, platformId],
    );
    return { candidates: r.rows, targets: dryRun ? [] : await cascadeTargets(client) };
  });

  const byTenant = new Map<string, UserPurgeTenantReport>();
  const work = new Map<string, Candidate[]>();
  for (const c of candidates) {
    let rep = byTenant.get(c.tenant_id);
    if (rep === undefined) {
      rep = { tenantId: c.tenant_id, purged: [], skipped: [] };
      byTenant.set(c.tenant_id, rep);
    }
    if (c.platform) rep.skipped.push({ userId: c.id, reason: 'platform_tenant' });
    else if (c.role === 'super_admin') rep.skipped.push({ userId: c.id, reason: 'super_admin' });
    else work.set(c.tenant_id, [...(work.get(c.tenant_id) ?? []), c]);
  }

  log.info({ candidates: candidates.length, dryRun, minDays }, 'user.purge: sweep starting');
  if (!dryRun && targets.length === 0) log.warn({}, 'user.purge: no cascade targets found in catalog');

  for (const [tenantId, users] of work) {
    const rep = byTenant.get(tenantId)!;
    try {
      const out = await withTenant(tenantId, async (client) => {
        const purged: string[] = [];
        const skipped: UserPurgeTenantReport['skipped'] = [];
        for (const c of users) {
          // Re-check inside the tx: the user may have been restored since selection.
          const cur = await client.query<{ email: string; role: string; deleted_at: Date | null; erased_at: Date | null }>(
            `SELECT email, role, deleted_at, erased_at FROM users WHERE id = $1 FOR UPDATE`,
            [c.id],
          );
          const row = cur.rows[0];
          if (row === undefined || row.erased_at !== null) continue;
          if (row.deleted_at === null) {
            skipped.push({ userId: c.id, reason: 'restored' });
            continue;
          }
          if (row.role === 'super_admin') {
            skipped.push({ userId: c.id, reason: 'super_admin' });
            continue;
          }
          if (row.role === 'admin') {
            try {
              await assertNotLastAdmin(client, c.id, 'softDelete');
            } catch (err) {
              if (isLastAdmin(err)) {
                skipped.push({ userId: c.id, reason: 'last_admin' });
                continue;
              }
              throw err;
            }
          }
          if (dryRun) {
            purged.push(c.id);
            continue;
          }
          const tables: Record<string, number> = {};
          const bump = (name: string, n: number | null): void => {
            if ((n ?? 0) > 0) tables[name] = (tables[name] ?? 0) + (n ?? 0);
          };
          for (const t of targets) {
            const d = await client.query(`DELETE FROM ${qi(t.table)} WHERE ${qi(t.col)} = $1`, [c.id]);
            bump(t.table, d.rowCount);
            // A hidden RLS policy must never leave live sessions / TOTP secrets on a tombstone.
            const left = await client.query(`SELECT 1 FROM ${qi(t.table)} WHERE ${qi(t.col)} = $1 LIMIT 1`, [c.id]);
            if ((left.rowCount ?? 0) > 0) throw new Error(`user purge: rows survive in ${t.table}`);
          }
          const inv = await client.query(
            `DELETE FROM user_invitations WHERE tenant_id = $1 AND lower(email) = lower($2)`,
            [tenantId, row.email],
          );
          bump('user_invitations', inv.rowCount);
          const nt = await client.query(`DELETE FROM in_app_notifications WHERE user_id = $1`, [c.id]);
          bump('in_app_notifications', nt.rowCount);
          await client.query(
            `UPDATE users
                SET name      = 'deleted_user_' || substr(encode(sha256(id::text::bytea),'hex'),1,12),
                    email     = 'deleted+' || substr(encode(sha256(id::text::bytea),'hex'),1,12) || '@erased.assessiq.local',
                    metadata  = COALESCE(metadata, '{}'::jsonb) - 'roll_number' - 'branch',
                    status    = 'disabled',
                    erased_at = COALESCE(erased_at, now())
              WHERE id = $1`,
            [c.id],
          );
          await auditInTx(client, {
            tenantId,
            actorKind: 'system',
            action: 'user.purged',
            entityType: 'user',
            entityId: c.id,
            after: { tables, minDays },
          });
          purged.push(c.id);
        }
        return { purged, skipped };
      });
      rep.purged.push(...out.purged);
      rep.skipped.push(...out.skipped);
    } catch (err) {
      // Never err.message: a unique-violation message can contain an email.
      const error = (err as { code?: string }).code ?? (err instanceof Error ? err.name : 'unknown');
      log.error({ tenantId, error }, 'user.purge: tenant failed; continuing sweep');
      rep.error = error;
    }
  }

  const tenants = [...byTenant.values()];
  return { dryRun, tenants, totalPurged: tenants.reduce((n, t) => n + t.purged.length, 0) };
}
