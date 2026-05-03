// AssessIQ — modules/15-analytics/src/service.ts
//
// Phase 3 G3.C — public service layer for analytics.
//
// Orchestrates:
//   homeKpis        — dashboard KPI tile (called by 10-admin-dashboard)
//   queueSummary    — grading queue summary (called by 07-ai-grading handler)
//   cohortReport    — assessment cohort rollup
//   individualReport — per-user attempt history
//   topicHeatmap    — per-pack topic × score heatmap
//   archetypeDistribution — per-assessment archetype breakdown
//   gradingCostByMonth — cost telemetry (P3.D21 empty-shape in claude-code-vps)
//   exportAttemptsCsv    — CSV streaming export
//   exportAttemptsJsonl  — JSONL streaming export
//   exportTopicHeatmapCsv — topic heatmap CSV export
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.
// Analytics is deterministic aggregation only. CLAUDE.md rule #1.

import { withTenant } from '@assessiq/tenancy';
import { config, streamLogger } from '@assessiq/core';
import { Readable } from 'node:stream';
import type {
  HomeKpis,
  QueueSummary,
  CohortReport,
  IndividualReport,
  TopicHeatmap,
  ArchetypeDistributionItem,
  CostRow,
  ReportFilter,
} from './types.js';
import * as repo from './repository.js';

const log = streamLogger('app');

// ---------------------------------------------------------------------------
// Dashboard helpers
// ---------------------------------------------------------------------------

/** KPI tiles for the admin home page. Called by 10-admin-dashboard. */
export async function homeKpis(tenantId: string): Promise<HomeKpis> {
  return withTenant(tenantId, (client) => repo.queryHomeKpis(client, tenantId));
}

/** Grading queue summary. Called by 07-ai-grading's admin-queue handler. */
export async function queueSummary(tenantId: string): Promise<QueueSummary> {
  return withTenant(tenantId, (client) => repo.queryQueueSummary(client, tenantId));
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/**
 * Full cohort rollup for an assessment.
 * Wraps 09-scoring's cohortStats and adds level/topic breakdowns.
 * Reads attempt_summary_mv (nightly refresh) for aggregate stats.
 */
export async function cohortReport(
  tenantId: string,
  assessmentId: string,
): Promise<CohortReport> {
  return withTenant(tenantId, (client) =>
    repo.queryCohortReport(client, tenantId, assessmentId),
  );
}

/** Per-user attempt history with archetype progression. */
export async function individualReport(
  tenantId: string,
  userId: string,
  opts: { from?: string; to?: string } = {},
): Promise<IndividualReport> {
  return withTenant(tenantId, (client) =>
    repo.queryIndividualReport(client, tenantId, userId, opts),
  );
}

/** Topic × score heatmap for a question pack. */
export async function topicHeatmap(opts: {
  tenantId: string;
  packId: string;
  from?: string;
  to?: string;
}): Promise<TopicHeatmap> {
  return withTenant(opts.tenantId, (client) =>
    repo.queryTopicHeatmap(client, opts.tenantId, opts.packId, {
      ...(opts.from !== undefined && { from: opts.from }),
      ...(opts.to !== undefined && { to: opts.to }),
    }),
  );
}

/** Per-archetype attempt counts for an assessment. */
export async function archetypeDistribution(
  tenantId: string,
  assessmentId: string,
): Promise<ArchetypeDistributionItem[]> {
  return withTenant(tenantId, (client) =>
    repo.queryArchetypeDistribution(client, tenantId, assessmentId),
  );
}

// ---------------------------------------------------------------------------
// Cost telemetry (P3.D21)
// ---------------------------------------------------------------------------

/**
 * Monthly grading cost breakdown.
 *
 * P3.D21 empty-shape contract:
 *   In claude-code-vps mode: returns [] with an INFO log.
 *   In anthropic-api mode: queries grading_jobs.cost_* columns.
 */
export async function gradingCostByMonth(
  tenantId: string,
  year: number,
): Promise<CostRow[]> {
  if (config.AI_PIPELINE_MODE === 'claude-code-vps') {
    log.info(
      { tenantId, year },
      'gradingCostByMonth: cost telemetry not available in claude-code-vps mode (admin Max OAuth, no per-call cost)',
    );
    return [];
  }

  return withTenant(tenantId, (client) =>
    repo.queryCostByMonth(client, tenantId, year),
  );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Stream all attempts for a tenant as CSV.
 * Hard-capped at 10,000 rows (EXPORT_ROW_CAP).
 * Caller is responsible for providing an admin-scoped tenant context.
 */
export async function exportAttemptsCsv(opts: {
  tenantId: string;
  filters: ReportFilter & { limit?: number };
}): Promise<Readable> {
  return withTenant(opts.tenantId, (client) =>
    repo.streamAttemptExportRows(client, opts.tenantId, opts.filters, 'csv'),
  );
}

/**
 * Stream all attempts for a tenant as JSONL (one JSON object per line).
 * Hard-capped at 10,000 rows (EXPORT_ROW_CAP).
 */
export async function exportAttemptsJsonl(opts: {
  tenantId: string;
  filters: ReportFilter & { limit?: number };
}): Promise<Readable> {
  return withTenant(opts.tenantId, (client) =>
    repo.streamAttemptExportRows(client, opts.tenantId, opts.filters, 'jsonl'),
  );
}

/**
 * Stream topic heatmap data for a pack as CSV.
 */
export async function exportTopicHeatmapCsv(opts: {
  tenantId: string;
  packId: string;
  from?: string;
  to?: string;
}): Promise<Readable> {
  return withTenant(opts.tenantId, (client) =>
    repo.streamTopicHeatmapCsv(client, opts.tenantId, opts.packId, {
      ...(opts.from !== undefined && { from: opts.from }),
      ...(opts.to !== undefined && { to: opts.to }),
    }),
  );
}
