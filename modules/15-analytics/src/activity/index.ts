// AssessIQ — modules/15-analytics/src/activity/index.ts
//
// Phase 9 — Admin Activity backend.
//
// Public surface of the activity sub-module:
//   - Service functions (getActivity{Stats,Heatmap,Timeline,Leaderboard})
//   - Type definitions (response shapes + query schemas)
//   - registerActivityRoutes() — single entry-point that registers all 4
//     `/api/admin/activity/*` routes under one preHandler chain.
//
// The 4 endpoint files each own their full vertical slice (types + Zod + SQL +
// service + route registrar). This file is the orchestrator that the parent
// 15-analytics route plugin calls.

import type { FastifyInstance, preHandlerHookHandler } from 'fastify';

import {
  ActivityStatsQuerySchema,
  getActivityStats,
  queryActivityStats,
  registerActivityStatsRoute,
} from './stats.js';
import type {
  ActivityBreakdownItem,
  ActivityStatsQuery,
  ActivityStatsResponse,
} from './stats.js';

import {
  ActivityHeatmapQuerySchema,
  computeStreaks,
  getActivityHeatmap,
  queryActivityHeatmapCounts,
  registerActivityHeatmapRoute,
  zeroFillRange,
} from './heatmap.js';
import type {
  ActivityHeatmapDay,
  ActivityHeatmapQuery,
  ActivityHeatmapResponse,
} from './heatmap.js';

import {
  ActivityTimelineQuerySchema,
  getActivityTimeline,
  queryActivityTimelineRows,
  rankDomains,
  registerActivityTimelineRoute,
  zeroFillWeeks,
} from './timeline.js';
import type {
  ActivityTimelineBar,
  ActivityTimelineQuery,
  ActivityTimelineResponse,
} from './timeline.js';

import {
  ActivityLeaderboardQuerySchema,
  computeDelta,
  computePeriodBoundaries,
  getActivityLeaderboard,
  queryActivityLeaderboardRows,
  queryActivityLeaderboardTotal,
  registerActivityLeaderboardRoute,
} from './leaderboard.js';
import type {
  ActivityLeaderboardQuery,
  ActivityLeaderboardResponse,
  LeaderboardDirection,
  LeaderboardItem,
  LeaderboardPeriod,
} from './leaderboard.js';

import {
  ActivityFeedQuerySchema,
  getActivityFeed,
  queryActivityFeed,
  registerActivityFeedRoute,
} from './feed.js';
import type {
  ActivityFeedQuery,
  ActivityFeedResponse,
  FeedItem,
} from './feed.js';

// ---------------------------------------------------------------------------
// Re-exports (service layer)
// ---------------------------------------------------------------------------

export {
  // service functions
  getActivityStats,
  getActivityHeatmap,
  getActivityTimeline,
  getActivityLeaderboard,
  getActivityFeed,
  // repository helpers (exported for testing)
  queryActivityStats,
  queryActivityHeatmapCounts,
  queryActivityTimelineRows,
  queryActivityLeaderboardRows,
  queryActivityLeaderboardTotal,
  queryActivityFeed,
  // pure helpers (exported for testing)
  computeStreaks,
  zeroFillRange,
  rankDomains,
  zeroFillWeeks,
  computePeriodBoundaries,
  computeDelta,
  // Zod schemas
  ActivityStatsQuerySchema,
  ActivityHeatmapQuerySchema,
  ActivityTimelineQuerySchema,
  ActivityLeaderboardQuerySchema,
  ActivityFeedQuerySchema,
};

export type {
  // stats
  ActivityBreakdownItem,
  ActivityStatsQuery,
  ActivityStatsResponse,
  // heatmap
  ActivityHeatmapDay,
  ActivityHeatmapQuery,
  ActivityHeatmapResponse,
  // timeline
  ActivityTimelineBar,
  ActivityTimelineQuery,
  ActivityTimelineResponse,
  // leaderboard
  ActivityLeaderboardQuery,
  ActivityLeaderboardResponse,
  LeaderboardDirection,
  LeaderboardItem,
  LeaderboardPeriod,
  // feed
  ActivityFeedQuery,
  ActivityFeedResponse,
  FeedItem,
};

// ---------------------------------------------------------------------------
// Route registrar — orchestrates all 4 endpoints under one preHandler chain
// ---------------------------------------------------------------------------

/**
 * Register all 4 Phase 9 Admin Activity routes on a Fastify instance.
 *
 * Called by registerAnalyticsRoutes() in `../routes.ts`. The same `adminOnly`
 * preHandler chain used for the existing /api/admin/reports/* surface is
 * reused here — admins (super-admin included) can read activity metrics for
 * their own tenant; tenant isolation is enforced by withTenant() RLS.
 *
 * Mounts:
 *   GET /api/admin/activity/stats
 *   GET /api/admin/activity/heatmap
 *   GET /api/admin/activity/timeline
 *   GET /api/admin/activity/leaderboard
 *   GET /api/admin/activity/feed
 */
export function registerActivityRoutes(
  app: FastifyInstance,
  preHandler: preHandlerHookHandler[],
): void {
  registerActivityStatsRoute(app, preHandler);
  registerActivityHeatmapRoute(app, preHandler);
  registerActivityTimelineRoute(app, preHandler);
  registerActivityLeaderboardRoute(app, preHandler);
  registerActivityFeedRoute(app, preHandler);
}
