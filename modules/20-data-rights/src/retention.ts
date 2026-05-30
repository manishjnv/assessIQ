// modules/20-data-rights/src/retention.ts
// Module 20 S5 — DPDP / GDPR per-tenant candidate-data retention purge.
//
// The cron path runs nightly via apps/api/src/worker.ts (03:00 UTC). Tenant
// admins can also trigger a per-tenant run manually via
// POST /api/admin/retention/run-now (with ?dryRun=true for preview).
//
// SELECTION (per tenant, RLS-scoped via withTenant):
//   Liveness proxy is MAX(attempts.submitted_at), falling back to
//   users.created_at when the candidate has never attempted anything.
//   A candidate is "expired" when:
//     - role = 'candidate'
//     - erased_at IS NULL                    (idempotent)
//     - deleted_at IS NULL                   (do not double-tombstone soft-deleted)
//     - last_active_at < now() - retention_days * interval '1 day'
//     - no active attempts (status NOT IN ('in_progress','pending_admin_grading'))
//
// FOR EACH expired candidate (unless dryRun):
//   call eraseCandidatePii(tenantId, userId, reason='retention_purge',
//                          actorUserId=null, actorKind='system')
//   which runs the existing 7-step atomic tombstone (S2/S3-lite).
//
// PER-TENANT AUDIT (always, even on dryRun):
//   emit one 'system.dsr.retention.run' row carrying the run summary so the
//   forensic chain shows what the cron decided regardless of whether the
//   underlying erasures fired.
//
// FAILURE ISOLATION:
//   runRetentionPurgeAllTenants catches per-tenant errors and continues —
//   one tenant's broken state must not abort the global sweep. The error is
//   captured in the per-tenant report.
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any
// AI SDK. data-rights is not part of the AI pipeline (CLAUDE.md rule #1).

import { streamLogger } from '@assessiq/core';
import {
  withTenant,
  listActiveTenantIds,
  findTenantSettings,
} from '@assessiq/tenancy';
import { audit } from '@assessiq/audit-log';
import type { PoolClient } from 'pg';
import { eraseCandidatePii } from './erasure.js';

const log = streamLogger('app');

export interface RetentionPurgeOptions {
  /** If true, scan and report but do not actually erase. */
  dryRun?: boolean;
  /**
   * Hard cap on candidates erased per tenant per run. Defaults to 500 — a
   * safety guardrail so a misconfigured retention window cannot churn an
   * unbounded number of rows in a single cron tick. The next nightly run
   * picks up the remainder. Use a higher value (or 0 for unlimited) when
   * running a one-shot backlog catch-up via the admin route.
   */
  maxPerTenant?: number;
}

export interface RetentionPurgeReport {
  tenantId: string;
  retentionDays: number;
  candidatesScanned: number;
  candidatesErased: number;
  /**
   * Candidates that matched the selection but were SKIPPED — already-erased
   * (idempotent receipt with alreadyErased:true), or per-candidate erasure
   * errors caught below.
   */
  candidatesSkipped: number;
  errors: Array<{ userId: string; message: string }>;
  dryRun: boolean;
  /** Wall-clock duration of the per-tenant sweep, ms. */
  durationMs: number;
}

const DEFAULT_MAX_PER_TENANT = 500;
const SYSTEM_RETENTION_REASON = 'retention_purge';

/**
 * Run the retention purge for ONE tenant. Idempotent: candidates whose
 * erased_at is already set are skipped at SELECT time. Safe to call from
 * the nightly cron, the admin run-now route, or a one-shot ops script.
 */
export async function runRetentionPurgeForTenant(
  tenantId: string,
  options: RetentionPurgeOptions = {},
): Promise<RetentionPurgeReport> {
  const startedAt = Date.now();
  const dryRun = options.dryRun ?? false;
  const maxPerTenant = options.maxPerTenant ?? DEFAULT_MAX_PER_TENANT;
  const limitClause = maxPerTenant > 0 ? `LIMIT ${Math.floor(maxPerTenant)}` : '';

  // ── 1. Read the tenant's retention_days ─────────────────────────────────
  // TenantSettings.retention_days is a typed field on the public type as of
  // module 20 S5 (mapSettingsRow coerces the INT column). Read it directly
  // — the previous `as unknown as { retention_days?: number }` cast was
  // type-safety debt that would silently fall back to 730 if the field name
  // ever changed (Sonnet-takeover review note A, 2026-05-30).
  const retentionDays = await withTenant(tenantId, async (client: PoolClient) => {
    const settings = await findTenantSettings(client, false);
    if (settings === null) {
      log.warn(
        { tenantId },
        'retention.purge: tenant_settings row missing — treating as 730 default',
      );
      return 730;
    }
    return settings.retention_days ?? 730;
  });

  // ── 2. Select expired candidates ────────────────────────────────────────
  const candidateIds = await withTenant(tenantId, async (client: PoolClient) => {
    const result = await client.query<{ id: string }>(
      `WITH candidate_activity AS (
         SELECT u.id,
                GREATEST(
                  COALESCE(MAX(a.submitted_at), u.created_at),
                  u.created_at
                ) AS last_active_at,
                COUNT(*) FILTER (
                  WHERE a.status IN ('in_progress', 'pending_admin_grading')
                ) AS active_attempts
           FROM users u
           LEFT JOIN attempts a ON a.user_id = u.id
          WHERE u.role = 'candidate'
            AND u.erased_at IS NULL
            AND u.deleted_at IS NULL
          GROUP BY u.id, u.created_at
       )
       SELECT id
         FROM candidate_activity
        WHERE last_active_at < now() - ($1 || ' days')::interval
          AND active_attempts = 0
        ORDER BY last_active_at ASC
        ${limitClause}`,
      [retentionDays],
    );
    return result.rows.map((r) => r.id);
  });

  // ── 3. Erase each candidate (unless dryRun) ─────────────────────────────
  const errors: RetentionPurgeReport['errors'] = [];
  let candidatesErased = 0;
  let candidatesSkipped = 0;

  if (!dryRun) {
    for (const userId of candidateIds) {
      try {
        const receipt = await eraseCandidatePii(
          tenantId,
          userId,
          SYSTEM_RETENTION_REASON,
          null,           // actorUserId — system actor
          'system',       // actorKind — distinguish cron from admin click
        );
        if (receipt.alreadyErased) {
          candidatesSkipped++;
        } else {
          candidatesErased++;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ userId, message });
        candidatesSkipped++;
        log.warn(
          { tenantId, userId, message },
          'retention.purge: per-candidate erasure failed; continuing sweep',
        );
      }
    }
  }

  const durationMs = Date.now() - startedAt;
  const report: RetentionPurgeReport = {
    tenantId,
    retentionDays,
    candidatesScanned: candidateIds.length,
    candidatesErased,
    candidatesSkipped,
    errors,
    dryRun,
    durationMs,
  };

  // ── 4. Always emit a per-tenant run-summary audit event ────────────────
  // Even on dryRun. The forensic chain shows what the cron decided AND
  // whether the decision was executed.
  // audit() (not auditInTx) — this is its own boundary; no other domain
  // writes need to commit atomically with it. Failure HERE rethrows per the
  // audit subsystem contract; the per-candidate erasures already committed
  // their own atomic audit rows.
  await audit({
    tenantId,
    actorKind: 'system',
    action: 'system.dsr.retention.run',
    entityType: 'tenant_settings',
    entityId: tenantId,
    after: {
      retentionDays,
      candidatesScanned: report.candidatesScanned,
      candidatesErased: report.candidatesErased,
      candidatesSkipped: report.candidatesSkipped,
      errorCount: report.errors.length,
      dryRun: report.dryRun,
      durationMs: report.durationMs,
    },
  });

  log.info(
    {
      tenantId,
      retentionDays,
      candidatesScanned: report.candidatesScanned,
      candidatesErased: report.candidatesErased,
      dryRun: report.dryRun,
      durationMs: report.durationMs,
    },
    'retention.purge: tenant complete',
  );

  return report;
}

/**
 * Run the retention purge for every active tenant. Best-effort per-tenant —
 * one tenant's error does not abort the sweep. Called by the BullMQ cron
 * (apps/api/src/worker.ts) and by the super-admin one-shot route.
 */
export async function runRetentionPurgeAllTenants(
  options: RetentionPurgeOptions = {},
): Promise<RetentionPurgeReport[]> {
  const tenantIds = await listActiveTenantIds();
  log.info(
    { tenantCount: tenantIds.length, dryRun: options.dryRun ?? false },
    'retention.purge: sweep starting',
  );

  const reports: RetentionPurgeReport[] = [];
  for (const tenantId of tenantIds) {
    try {
      const report = await runRetentionPurgeForTenant(tenantId, options);
      reports.push(report);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { tenantId, message },
        'retention.purge: tenant-level failure; continuing sweep',
      );
      reports.push({
        tenantId,
        retentionDays: -1,
        candidatesScanned: 0,
        candidatesErased: 0,
        candidatesSkipped: 0,
        errors: [{ userId: '<tenant-level>', message }],
        dryRun: options.dryRun ?? false,
        durationMs: 0,
      });
    }
  }

  const totalErased = reports.reduce((s, r) => s + r.candidatesErased, 0);
  log.info(
    {
      tenantCount: tenantIds.length,
      totalErased,
      dryRun: options.dryRun ?? false,
    },
    'retention.purge: sweep complete',
  );

  return reports;
}
