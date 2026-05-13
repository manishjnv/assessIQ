// AssessIQ — modules/15-analytics/src/activity-candidate/index.ts
//
// Phase 10 — Candidate Activity backend.
//
// Public surface of the activity-candidate sub-module:
//   - Service functions (getCandidateActivity{Stats,Heatmap,Timeline,Leaderboard})
//   - Type definitions (response shapes + query schemas)
//   - registerActivityCandidateRoutes() — single entry-point that registers all 4
//     `/api/me/activity/*` routes under one preHandler chain.

import type { FastifyInstance, preHandlerHookHandler } from 'fastify';

import {
  CandidateActivityStatsQuerySchema,
  getCandidateActivityStats,
  queryCandidateActivityStats,
  registerCandidateActivityStatsRoute,
} from './stats.js';
import type {
  CandidateActivityStatsQuery,
  CandidateActivityStatsResponse,
} from './stats.js';

import {
  getCandidateActivityHeatmap,
  queryCandidateHeatmapCounts,
  registerCandidateActivityHeatmapRoute,
} from './heatmap.js';

import {
  CandidateLeaderboardQuerySchema,
  getCandidateActivityLeaderboard,
  queryCandidateLeaderboardRows,
  queryCandidateLeaderboardTotal,
  registerCandidateActivityLeaderboardRoute,
} from './leaderboard.js';
import type {
  CandidateActivityLeaderboardResponse,
  CandidateLeaderboardItem,
  CandidateLeaderboardQuery,
} from './leaderboard.js';

import {
  getCandidateActivityTimeline,
  queryCandidateTimelineRows,
  registerCandidateActivityTimelineRoute,
} from './timeline.js';

// ---------------------------------------------------------------------------
// Re-exports (service layer)
// ---------------------------------------------------------------------------

export {
  getCandidateActivityStats,
  getCandidateActivityHeatmap,
  getCandidateActivityTimeline,
  getCandidateActivityLeaderboard,
  queryCandidateActivityStats,
  queryCandidateHeatmapCounts,
  queryCandidateTimelineRows,
  queryCandidateLeaderboardRows,
  queryCandidateLeaderboardTotal,
  CandidateActivityStatsQuerySchema,
  CandidateLeaderboardQuerySchema,
};

export type {
  CandidateActivityStatsQuery,
  CandidateActivityStatsResponse,
  CandidateActivityLeaderboardResponse,
  CandidateLeaderboardItem,
  CandidateLeaderboardQuery,
};

// ---------------------------------------------------------------------------
// Route registrar
// ---------------------------------------------------------------------------

export function registerActivityCandidateRoutes(
  app: FastifyInstance,
  preHandler: preHandlerHookHandler[],
): void {
  registerCandidateActivityStatsRoute(app, preHandler);
  registerCandidateActivityHeatmapRoute(app, preHandler);
  registerCandidateActivityTimelineRoute(app, preHandler);
  registerCandidateActivityLeaderboardRoute(app, preHandler);
}
