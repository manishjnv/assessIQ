// modules/20-data-rights/src/attempt-retention.ts
// FUT-11 — nightly sweep of attempt_events for finished attempts past the tenant window.
//
// Window: tenant_settings.attempt_retention_days (NULL = keep forever, the default).
// Scope: attempt_events rows only. Answers, scores, gradings, certificates stay.
// Builds on the retention.ts pattern (per-tenant, RLS-scoped, errors isolated per tenant).
// Dry run counts the rows and deletes nothing.
//
// INVARIANT: no AI SDK import (CLAUDE.md rule #1).

import { streamLogger, ValidationError } from '@assessiq/core';
import { withTenant, listActiveTenantIds } from '@assessiq/tenancy';
import { auditInTx } from '@assessiq/audit-log';
import type { PoolClient } from 'pg';

const log = streamLogger('app');

export interface AttemptRetentionReport {
  tenantId: string;
  windowDays: number | null;
  /** Rows deleted, or rows that would be deleted on a dry run. */
  events: number;
  dryRun: boolean;
  error?: string;
}

const BATCH = 5000;
const MAX_BATCHES = 40;

export async function runAttemptRetentionForTenant(
  tenantId: string,
  options: { dryRun?: boolean } = {},
): Promise<AttemptRetentionReport> {
  const dryRun = options.dryRun ?? false;
  const windowDays = await withTenant(tenantId, async (client: PoolClient) => {
    const r = await client.query<{ d: number | null }>(
      `SELECT attempt_retention_days AS d FROM tenant_settings WHERE tenant_id = $1`,
      [tenantId],
    );
    return r.rows[0]?.d ?? null;
  });
  if (windowDays === null) return { tenantId, windowDays, events: 0, dryRun };

  // Only ended attempts (not in_progress / pending_admin_grading) with an end time past the window.
  const expired = `a.status NOT IN ('in_progress','pending_admin_grading')
                   AND COALESCE(a.submitted_at, a.ends_at) < now() - ($1 || ' days')::interval`;

  if (dryRun) {
    const events = await withTenant(tenantId, async (client: PoolClient) => {
      const r = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM attempt_events e JOIN attempts a ON a.id = e.attempt_id WHERE ${expired}`,
        [windowDays],
      );
      return Number(r.rows[0]?.n ?? 0);
    });
    return { tenantId, windowDays, events, dryRun };
  }

  let events = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await withTenant(tenantId, async (client: PoolClient) => {
      const r = await client.query(
        `DELETE FROM attempt_events WHERE id IN (
           SELECT e.id FROM attempt_events e JOIN attempts a ON a.id = e.attempt_id
            WHERE ${expired} LIMIT ${BATCH})`,
        [windowDays],
      );
      return r.rowCount ?? 0;
    });
    events += n;
    if (n < BATCH) break;
  }
  return { tenantId, windowDays, events, dryRun };
}

export async function runAttemptRetentionAllTenants(
  options: { dryRun?: boolean } = {},
): Promise<AttemptRetentionReport[]> {
  const reports: AttemptRetentionReport[] = [];
  for (const tenantId of await listActiveTenantIds()) {
    try {
      reports.push(await runAttemptRetentionForTenant(tenantId, options));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ tenantId, message }, 'attempt.retention: tenant sweep failed; continuing');
      reports.push({ tenantId, windowDays: null, events: 0, dryRun: options.dryRun ?? false, error: message });
    }
  }
  return reports;
}

// Z-132 — admin read and write of the window. NULL = keep forever (default).
export const MIN_ATTEMPT_RETENTION_DAYS = 30;
export const MAX_ATTEMPT_RETENTION_DAYS = 3650;

export async function getAttemptRetentionDays(tenantId: string): Promise<number | null> {
  return withTenant(tenantId, async (client: PoolClient) => {
    const r = await client.query<{ d: number | null }>(
      `SELECT attempt_retention_days AS d FROM tenant_settings WHERE tenant_id = $1`,
      [tenantId],
    );
    return r.rows[0]?.d ?? null;
  });
}

export async function updateAttemptRetentionDays(
  adminUserId: string,
  tenantId: string,
  days: number | null,
): Promise<{ attempt_retention_days: number | null; previous: number | null }> {
  if (
    days !== null &&
    (!Number.isInteger(days) || days < MIN_ATTEMPT_RETENTION_DAYS || days > MAX_ATTEMPT_RETENTION_DAYS)
  ) {
    throw new ValidationError(
      `attempt_retention_days must be a whole number between ${MIN_ATTEMPT_RETENTION_DAYS} and ${MAX_ATTEMPT_RETENTION_DAYS}, or empty`,
      { details: { code: 'ATTEMPT_RETENTION_DAYS_OUT_OF_RANGE', received: days } },
    );
  }
  return withTenant(tenantId, async (client: PoolClient) => {
    const prev = await client.query<{ d: number | null }>(
      `SELECT attempt_retention_days AS d FROM tenant_settings WHERE tenant_id = $1 FOR UPDATE`,
      [tenantId],
    );
    if (prev.rows.length === 0) throw new Error(`tenant_settings not found for tenant ${tenantId}`);
    const previous = prev.rows[0]!.d;
    await client.query(
      `UPDATE tenant_settings SET attempt_retention_days = $1, updated_at = now() WHERE tenant_id = $2`,
      [days, tenantId],
    );
    await auditInTx(client, {
      tenantId,
      actorKind: 'user',
      actorUserId: adminUserId,
      action: 'tenant_settings.attempt_retention_days.updated',
      entityType: 'tenant_settings',
      entityId: tenantId,
      before: { attempt_retention_days: previous },
      after: { attempt_retention_days: days },
    });
    return { attempt_retention_days: days, previous };
  });
}
