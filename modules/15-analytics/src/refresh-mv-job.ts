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

import { withSystemRole } from '@assessiq/tenancy';
import { streamLogger } from '@assessiq/core';

const log = streamLogger('worker');

export const ANALYTICS_REFRESH_MV_JOB_NAME = 'analytics:refresh_mv';

/**
 * Runs REFRESH MATERIALIZED VIEW CONCURRENTLY on attempt_summary_mv and question_stats_mv.
 * Returns { duration_ms } for the worker log.
 */
export async function processRefreshMvJob(): Promise<{ duration_ms: number }> {
  const start = Date.now();
  // The MV aggregates the RLS-subject base tables across ALL tenants, and REFRESH requires the
  // executing role to OWN the MV (migration 0088: assessiq_system). FUT-10: runs on the system
  // pool in a tx (SET LOCAL ROLE dies with the tx, so no pooled-connection role leak).
  // Consumers still filter by tenant_id (RLS does not cover MVs: tools/lint-mv-tenant-filter.ts).
  await withSystemRole('analytics.refresh_mv', async (client) => {
    await client.query('REFRESH MATERIALIZED VIEW CONCURRENTLY attempt_summary_mv');
    // RW-60: per-question Phase C stats (migration 0189), same role, same job.
    await client.query('REFRESH MATERIALIZED VIEW CONCURRENTLY question_stats_mv');
  });
  const duration_ms = Date.now() - start;
  log.info({ duration_ms, views: 2 }, 'analytics.refresh_mv: materialized views refreshed');
  return { duration_ms };
}
