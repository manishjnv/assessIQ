// AssessIQ — modules/15-analytics/src/activity/leaderboard.ts
//
// Phase 9 — GET /api/admin/activity/leaderboard
//
// Returns a paginated, ranked list of assessments by submission volume over a
// rolling period (week / month / quarter), with a prior-period delta for
// trend context. Rankings are computed against the live `attempts` table —
// NOT the attempt_summary_mv — because the MV has a nightly refresh cycle
// that makes it too stale for week-over-week deltas (anti-pattern guard per
// Phase 9 plan §9).
//
// RLS is enforced via the withTenant GUC (SET LOCAL app.current_tenant).
// No explicit tenant_id filter is needed in the SQL because `attempts`,
// `assessments`, and `question_packs` are all RLS-scoped live tables.
//
// tools/lint-mv-tenant-filter.ts does NOT scan this file (it targets MV
// queries only). The live-table RLS path is consistent with homeKpis and
// queueSummary in repository.ts.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.
// CLAUDE.md rule #1.

import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ValidationError } from '@assessiq/core';
import { withTenant } from '@assessiq/tenancy';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LeaderboardPeriod = 'week' | 'month' | 'quarter';
export type LeaderboardDirection = 'up' | 'down' | 'flat';

export interface LeaderboardItem {
  rank: number;
  packId: string | null;     // null if assessment has no pack (data integrity edge case)
  packName: string | null;
  domain: string | null;     // raw slug — no display-name mapping per db020d1 decision
  currentCount: number;
  priorCount: number;
  deltaPct: number | null;   // null when priorCount=0 and currentCount>0 (new entry)
  direction: LeaderboardDirection;
}

export interface ActivityLeaderboardResponse {
  period: LeaderboardPeriod;
  from: string;       // YYYY-MM-DD start of current period
  to: string;         // YYYY-MM-DD end of current period (today)
  priorFrom: string;  // YYYY-MM-DD start of prior period
  priorTo: string;    // YYYY-MM-DD end of prior period
  page: number;
  pageSize: number;
  totalRanked: number; // total distinct assessments in current period (all pages)
  items: LeaderboardItem[];
}

// ---------------------------------------------------------------------------
// Query schema
// ---------------------------------------------------------------------------

export const ActivityLeaderboardQuerySchema = z.object({
  period: z.enum(['week', 'month', 'quarter']).optional(),
  page: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 1))
    .pipe(z.number().int().min(1).max(1000)),
  pageSize: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 10))
    .pipe(z.number().int().min(1).max(50)),
});
export type ActivityLeaderboardQuery = z.infer<typeof ActivityLeaderboardQuerySchema>;

// ---------------------------------------------------------------------------
// Period boundary helpers (exported for test reuse)
// ---------------------------------------------------------------------------

/**
 * Compute the four YYYY-MM-DD boundary dates for the leaderboard query.
 *
 * All math is in UTC. "today" is always inclusive (i.e. the query uses
 * `< to + interval '1 day'` so that rows submitted today are included).
 *
 * - week:    current = last 7 days; prior = 7 days before that (14 total)
 * - month:   current = last 30 days; prior = 30 days before that (60 total)
 * - quarter: current = last 90 days; prior = 90 days before that (180 total)
 */
export function computePeriodBoundaries(
  period: LeaderboardPeriod,
  today: Date,
): { from: string; to: string; priorFrom: string; priorTo: string } {
  const days = period === 'week' ? 7 : period === 'month' ? 30 : 90;

  // currentTo = today (inclusive upper bound in SQL via < currentTo + 1 day)
  const currentTo = toDateString(today);

  // currentFrom = today - (days - 1) so the window is exactly `days` days
  const currentFromDate = new Date(Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate() - (days - 1),
  ));
  const currentFrom = toDateString(currentFromDate);

  // priorTo = day before currentFrom
  const priorToDate = new Date(Date.UTC(
    currentFromDate.getUTCFullYear(),
    currentFromDate.getUTCMonth(),
    currentFromDate.getUTCDate() - 1,
  ));
  const priorTo = toDateString(priorToDate);

  // priorFrom = priorTo - (days - 1)
  const priorFromDate = new Date(Date.UTC(
    priorToDate.getUTCFullYear(),
    priorToDate.getUTCMonth(),
    priorToDate.getUTCDate() - (days - 1),
  ));
  const priorFrom = toDateString(priorFromDate);

  return { from: currentFrom, to: currentTo, priorFrom, priorTo };
}

function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Delta + direction helper (exported for test reuse)
// ---------------------------------------------------------------------------

/**
 * Compute deltaPct and direction from raw counts.
 *
 * Rules:
 * - priorCount=0 && currentCount>0  → deltaPct=null, direction='up' (new entry)
 * - priorCount=0 && currentCount=0  → deltaPct=0, direction='flat'  (shouldn't occur)
 * - otherwise: ((current - prior) / prior) * 100, rounded to 1 decimal
 *   direction: >0.5 → 'up', <-0.5 → 'down', else 'flat'
 */
export function computeDelta(
  currentCount: number,
  priorCount: number,
): { deltaPct: number | null; direction: LeaderboardDirection } {
  if (priorCount === 0) {
    if (currentCount > 0) {
      return { deltaPct: null, direction: 'up' };
    }
    return { deltaPct: 0, direction: 'flat' };
  }

  const raw = ((currentCount - priorCount) / priorCount) * 100;
  const deltaPct = Math.round(raw * 10) / 10; // 1 decimal place

  let direction: LeaderboardDirection;
  if (deltaPct > 0.5) {
    direction = 'up';
  } else if (deltaPct < -0.5) {
    direction = 'down';
  } else {
    direction = 'flat';
  }

  return { deltaPct, direction };
}

// ---------------------------------------------------------------------------
// Raw DB row type (internal)
// ---------------------------------------------------------------------------

interface LeaderboardRow {
  assessment_id: string;
  pack_id: string | null;
  pack_name: string | null;
  domain: string | null;
  current_count: number;
  prior_count: number;
}

// ---------------------------------------------------------------------------
// Repository — runs inside a withTenant callback (GUC already set)
// ---------------------------------------------------------------------------

/**
 * Fetch one page of leaderboard rows ranked by submission count DESC.
 *
 * Uses two CTEs against the live `attempts` table:
 *   current_period — submissions in [currentFrom, currentTo]
 *   prior_period   — submissions in [priorFrom,  priorTo]
 *
 * The prior_period CTE is LEFT JOINed so assessments with zero prior
 * submissions still appear (their prior_count will be 0 via COALESCE).
 *
 * RLS is enforced by the withTenant GUC; no explicit tenant filter needed.
 */
export async function queryActivityLeaderboardRows(
  client: PoolClient,
  bounds: { currentFrom: string; currentTo: string; priorFrom: string; priorTo: string },
  pageSize: number,
  offset: number,
): Promise<LeaderboardRow[]> {
  const { currentFrom, currentTo, priorFrom, priorTo } = bounds;

  const result = await client.query<{
    assessment_id: string;
    pack_id: string | null;
    pack_name: string | null;
    domain: string | null;
    current_count: string;
    prior_count: string;
  }>(
    `WITH current_period AS (
       SELECT a.assessment_id, ass.pack_id, COUNT(*)::int AS cnt
       FROM attempts a
       JOIN assessments ass ON ass.id = a.assessment_id
       WHERE a.submitted_at IS NOT NULL
         AND a.submitted_at >= $1::timestamptz
         AND a.submitted_at <  $2::timestamptz + interval '1 day'
         AND a.status IN ('submitted','auto_submitted','graded','released','pending_admin_grading')
       GROUP BY a.assessment_id, ass.pack_id
     ),
     prior_period AS (
       SELECT a.assessment_id, COUNT(*)::int AS cnt
       FROM attempts a
       WHERE a.submitted_at IS NOT NULL
         AND a.submitted_at >= $3::timestamptz
         AND a.submitted_at <  $4::timestamptz + interval '1 day'
         AND a.status IN ('submitted','auto_submitted','graded','released','pending_admin_grading')
       GROUP BY a.assessment_id
     )
     SELECT
       cp.assessment_id,
       cp.pack_id,
       qp.name                      AS pack_name,
       qp.domain                    AS domain,
       cp.cnt::int                  AS current_count,
       COALESCE(pp.cnt, 0)::int     AS prior_count
     FROM current_period cp
     LEFT JOIN prior_period pp ON pp.assessment_id = cp.assessment_id
     LEFT JOIN question_packs qp ON qp.id = cp.pack_id
     ORDER BY cp.cnt DESC, qp.name ASC
     LIMIT $5 OFFSET $6`,
    [currentFrom, currentTo, priorFrom, priorTo, pageSize, offset],
  );

  return result.rows.map((r) => ({
    assessment_id: r.assessment_id,
    pack_id: r.pack_id,
    pack_name: r.pack_name,
    domain: r.domain,
    current_count: parseInt(r.current_count as unknown as string, 10),
    prior_count: parseInt(r.prior_count as unknown as string, 10),
  }));
}

/**
 * Count total distinct assessments in the current period.
 * Used to populate `totalRanked` regardless of pagination.
 *
 * Cheap separate query — avoids a window function on the main paged query.
 */
export async function queryActivityLeaderboardTotal(
  client: PoolClient,
  bounds: { currentFrom: string; currentTo: string },
): Promise<number> {
  const { currentFrom, currentTo } = bounds;

  const result = await client.query<{ total: string }>(
    `SELECT COUNT(DISTINCT a.assessment_id)::text AS total
     FROM attempts a
     WHERE a.submitted_at IS NOT NULL
       AND a.submitted_at >= $1::timestamptz
       AND a.submitted_at <  $2::timestamptz + interval '1 day'
       AND a.status IN ('submitted','auto_submitted','graded','released','pending_admin_grading')`,
    [currentFrom, currentTo],
  );

  return parseInt(result.rows[0]?.total ?? '0', 10);
}

// ---------------------------------------------------------------------------
// Service — resolves defaults then delegates to withTenant
// ---------------------------------------------------------------------------

export async function getActivityLeaderboard(
  tenantId: string,
  query: ActivityLeaderboardQuery,
): Promise<ActivityLeaderboardResponse> {
  // Resolve defaults and compute boundaries BEFORE entering withTenant (pure JS)
  const period: LeaderboardPeriod = query.period ?? 'week';
  const page = query.page;        // already defaulted to 1 by schema transform
  const pageSize = query.pageSize; // already defaulted to 10 by schema transform
  const offset = (page - 1) * pageSize;
  const rankBase = offset + 1;    // rank of the first item on this page

  const today = new Date();
  const boundaries = computePeriodBoundaries(period, today);
  const { from, to, priorFrom, priorTo } = boundaries;

  const bounds = {
    currentFrom: from,
    currentTo:   to,
    priorFrom,
    priorTo,
  };

  return withTenant(tenantId, async (client) => {
    // Run both queries concurrently — they are independent reads.
    const [rows, totalRanked] = await Promise.all([
      queryActivityLeaderboardRows(client, bounds, pageSize, offset),
      queryActivityLeaderboardTotal(client, { currentFrom: from, currentTo: to }),
    ]);

    const items: LeaderboardItem[] = rows.map((row, idx) => {
      const { deltaPct, direction } = computeDelta(row.current_count, row.prior_count);
      return {
        rank: rankBase + idx,
        packId: row.pack_id,
        packName: row.pack_name,
        domain: row.domain,
        currentCount: row.current_count,
        priorCount: row.prior_count,
        deltaPct,
        direction,
      };
    });

    return {
      period,
      from,
      to,
      priorFrom,
      priorTo,
      page,
      pageSize,
      totalRanked,
      items,
    };
  });
}

// ---------------------------------------------------------------------------
// Route registrar
// ---------------------------------------------------------------------------

export function registerActivityLeaderboardRoute(
  app: FastifyInstance,
  preHandler: preHandlerHookHandler[],
): void {
  app.get('/api/admin/activity/leaderboard', { preHandler }, async (req, reply) => {
    const parsed = ActivityLeaderboardQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('invalid query parameters', {
        details: { validation: parsed.error.errors },
      });
    }
    const tenantId = (req as unknown as { session: { tenantId: string } }).session.tenantId;
    const data = await getActivityLeaderboard(tenantId, parsed.data);
    return reply.send({ data });
  });
}
