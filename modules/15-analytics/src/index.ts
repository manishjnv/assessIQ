// AssessIQ — modules/15-analytics/src/index.ts
//
// Phase 3 G3.C — public barrel for @assessiq/analytics.
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any AI SDK.

// ---------------------------------------------------------------------------
// Dashboard helpers (called by 10-admin-dashboard and 07-ai-grading)
// ---------------------------------------------------------------------------
export { homeKpis, queueSummary } from './service.js';

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
export {
  cohortReport,
  individualReport,
  topicHeatmap,
  archetypeDistribution,
  gradingCostByMonth,
} from './service.js';

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
export { exportAttemptsCsv, exportAttemptsJsonl, exportTopicHeatmapCsv } from './service.js';

// ---------------------------------------------------------------------------
// Route registrar
// ---------------------------------------------------------------------------
export {
  registerAnalyticsRoutes,
  type RegisterAnalyticsRoutesOptions,
} from './routes.js';

// ---------------------------------------------------------------------------
// Worker job
// ---------------------------------------------------------------------------
export {
  processRefreshMvJob,
  ANALYTICS_REFRESH_MV_JOB_NAME,
} from './refresh-mv-job.js';

// ---------------------------------------------------------------------------
// Types (public surface)
// ---------------------------------------------------------------------------
export type {
  HomeKpis,
  QueueSummary,
  CohortReport,
  LevelBreakdown,
  TopicBreakdownItem,
  IndividualReport,
  AttemptSummaryRow,
  TopicHeatmap,
  TopicHeatmapCell,
  ArchetypeDistributionItem,
  CostRow,
  AttemptExportRow,
  TopicHeatmapExportRow,
  ReportFilter,
  ExportFilter,
} from './types.js';
export { ReportFilterSchema, ExportFilterSchema } from './types.js';
export { EXPORT_ROW_CAP } from './repository.js';
