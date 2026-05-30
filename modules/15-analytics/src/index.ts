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
  getAdminCohortReport,
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
  AdminCohortReport,
  AdminCohortAttemptRow,
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
export { EXPORT_ROW_CAP, COHORT_ATTEMPTS_HARD_LIMIT } from './repository.js';

// ---------------------------------------------------------------------------
// Phase 9 — Admin Activity surface
// ---------------------------------------------------------------------------
export {
  getActivityStats,
  getActivityHeatmap,
  getActivityTimeline,
  getActivityLeaderboard,
  registerActivityRoutes,
  // Repository helpers (exported for test reuse)
  queryActivityStats,
  queryActivityHeatmapCounts,
  queryActivityTimelineRows,
  queryActivityLeaderboardRows,
  queryActivityLeaderboardTotal,
  // Feed
  getActivityFeed,
  queryActivityFeed,
  ActivityFeedQuerySchema,
  // Exported pure helpers + Zod schemas (for test reuse)
  computeStreaks,
  zeroFillRange,
  rankDomains,
  zeroFillWeeks,
  computePeriodBoundaries,
  computeDelta,
  ActivityStatsQuerySchema,
  ActivityHeatmapQuerySchema,
  ActivityTimelineQuerySchema,
  ActivityLeaderboardQuerySchema,
} from './activity/index.js';

export type {
  ActivityBreakdownItem,
  ActivityStatsQuery,
  ActivityStatsResponse,
  ActivityHeatmapDay,
  ActivityHeatmapQuery,
  ActivityHeatmapResponse,
  ActivityTimelineBar,
  ActivityTimelineQuery,
  ActivityTimelineResponse,
  ActivityLeaderboardQuery,
  ActivityLeaderboardResponse,
  LeaderboardDirection,
  LeaderboardItem,
  LeaderboardPeriod,
  // Feed
  ActivityFeedQuery,
  ActivityFeedResponse,
  FeedItem,
} from './activity/index.js';

// ---------------------------------------------------------------------------
// Phase 10 — Candidate Activity surface
// ---------------------------------------------------------------------------
export {
  getCandidateActivityStats,
  getCandidateActivityHeatmap,
  getCandidateActivityTimeline,
  getCandidateActivityLeaderboard,
  registerActivityCandidateRoutes,
  queryCandidateActivityStats,
  queryCandidateHeatmapCounts,
  queryCandidateTimelineRows,
  queryCandidateLeaderboardRows,
  queryCandidateLeaderboardTotal,
  CandidateActivityStatsQuerySchema,
  CandidateLeaderboardQuerySchema,
} from './activity-candidate/index.js';

export type {
  CandidateActivityStatsQuery,
  CandidateActivityStatsResponse,
  CandidateActivityLeaderboardResponse,
  CandidateLeaderboardItem,
  CandidateLeaderboardQuery,
} from './activity-candidate/index.js';
