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
    await client.query('REFRESH MATERIALIZED VIEW CONCURRENTLY attempt_summary_mv');
    const duration_ms = Date.now() - start;
    log.info({ duration_ms }, 'analytics.refresh_mv: materialized view refreshed');
    return { duration_ms };
  } finally {
    client.release();
  }
}
