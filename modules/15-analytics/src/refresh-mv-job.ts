// AssessIQ — modules/15-analytics/src/refresh-mv-job.ts
//
// Phase 3 G3.C — BullMQ nightly job to refresh attempt_summary_mv.
//
// REFRESH MATERIALIZED VIEW CONCURRENTLY attempt_summary_mv
//   Runs at 02:00 UTC (low-traffic window for India + US).
//   CONCURRENTLY: requires the UNIQUE index (present per P3.D18 migration).
//   Reads during refresh are unblocked (non-exclusive lock).
//
// The job processor is called from apps/api/src/worker.ts via the
// existing runJobWithLogging wrapper + QUEUE_NAME 'assessiq-cron'.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.

import { getPool } from '@assessiq/tenancy';
import { streamLogger } from '@assessiq/core';

const log = streamLogger('worker');

export const ANALYTICS_REFRESH_MV_JOB_NAME = 'analytics:refresh_mv';

/**
 * Runs REFRESH MATERIALIZED VIEW CONCURRENTLY attempt_summary_mv.
 * Returns { duration_ms } for the worker log.
 */
export async function processRefreshMvJob(): Promise<{ duration_ms: number }> {
  const pool = getPool();
  const start = Date.now();

  const client = await pool.connect();
  try {
    // The MV aggregates the RLS-subject base tables (attempt_scores / attempts /
    // assessments) across ALL tenants, and REFRESH requires the executing role to
    // OWN the MV. So run the refresh as assessiq_system — the BYPASSRLS role that
    // owns the MV (migration 0088). The worker connects as assessiq_app, a member
    // of assessiq_system, so SET ROLE elevates for this job only. Consumers still
    // filter by tenant_id (RLS does not cover MVs — tools/lint-mv-tenant-filter.ts).
    await client.query('SET ROLE assessiq_system');
    await client.query('REFRESH MATERIALIZED VIEW CONCURRENTLY attempt_summary_mv');
    const duration_ms = Date.now() - start;
    log.info({ duration_ms }, 'analytics.refresh_mv: materialized view refreshed');
    return { duration_ms };
  } finally {
    // Restore the role before returning the connection to the pool. If RESET ever
    // fails the connection may still be elevated to the BYPASSRLS role — DESTROY it
    // (release(true)) rather than risk a later query on a pooled connection
    // inheriting BYPASSRLS and reading across tenants.
    try {
      await client.query('RESET ROLE');
      client.release();
    } catch {
      client.release(true);
    }
  }
}
