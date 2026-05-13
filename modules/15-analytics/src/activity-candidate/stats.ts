// AssessIQ — modules/15-analytics/src/activity-candidate/stats.ts
//
// Phase 10 — GET /api/me/activity/stats
//
// Returns candidate-scoped activity stats: completions, avgScore (quartile
// breakdown), and assessments-taken (distinct packs). Mirrors Phase 9 admin
// stats.ts with user_id scoping added.
//
// Data source: attempt_summary_mv (explicit tenant filter required).
// CRITICAL: every MV query MUST include:
//   WHERE mv.tenant_id = current_setting('app.current_tenant', true)::uuid
//   AND mv.user_id = $3
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.

import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ValidationError } from '@assessiq/core';
import { withTenant } from '@assessiq/tenancy';
import type { ActivityBreakdownItem } from '../activity/stats.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { ActivityBreakdownItem };

export interface CandidateActivityStatsResponse {
  from: string;
  to: string;
  groupBy: 'domain' | 'level';
  completions:      { total: number; breakdown: ActivityBreakdownItem[] };
  avgScore:         { total: number; breakdown: ActivityBreakdownItem[] };
  assessmentsTaken: { total: number };
}

// ---------------------------------------------------------------------------
// Query schema (mirrors admin stats schema)
// ---------------------------------------------------------------------------

export const CandidateActivityStatsQuerySchema = z.object({
  from:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  groupBy: z.enum(['domain', 'level']).optional(),
});
export type CandidateActivityStatsQuery = z.infer<typeof CandidateActivityStatsQuerySchema>;

// ---------------------------------------------------------------------------
// Session helper
// ---------------------------------------------------------------------------

type SessionReq = { session: { tenantId: string; userId: string } };
function sess(req: unknown): SessionReq['session'] {
  return (req as unknown as SessionReq).session;
}

// ---------------------------------------------------------------------------
// Repository — runs inside a withTenant callback (GUC already set)
// ---------------------------------------------------------------------------

export async function queryCandidateActivityStats(
  client: PoolClient,
  opts: { from: string; to: string; groupBy: 'domain' | 'level'; userId: string },
): Promise<CandidateActivityStatsResponse> {
  const { from, to, groupBy, userId } = opts;

  const groupCol = groupBy === 'domain' ? 'qp.domain' : 'lv.label';

  // -------------------------------------------------------------------------
  // 1. Completions total + breakdown
  // -------------------------------------------------------------------------
  const completionsResult = await client.query<{
    total: string;
    key: string | null;
    cnt: string;
  }>(
    `WITH base AS (
       SELECT
         mv.attempt_id,
         ${groupCol} AS grp_key
       FROM attempt_summary_mv mv
       LEFT JOIN question_packs qp ON qp.id = mv.pack_id
       LEFT JOIN levels        lv ON lv.id = mv.level_id
       WHERE mv.tenant_id = current_setting('app.current_tenant', true)::uuid
         AND mv.user_id = $3
         AND mv.submitted_at >= $1::timestamptz
         AND mv.submitted_at <  $2::timestamptz + interval '1 day'
     )
     SELECT
       COUNT(*)::text     AS total,
       grp_key            AS key,
       COUNT(*)::text     AS cnt
     FROM base
     GROUP BY GROUPING SETS ((), (grp_key))`,
    [from, to, userId],
  );

  const completionsTotal = parseInt(
    completionsResult.rows.find((r) => r.key === null)?.total ?? '0',
    10,
  );
  const completionsBreakdown: ActivityBreakdownItem[] = completionsResult.rows
    .filter((r) => r.key !== null)
    .map((r) => ({
      key: r.key as string,
      value: parseInt(r.cnt, 10),
      pct: completionsTotal > 0
        ? Math.round((parseInt(r.cnt, 10) / completionsTotal) * 100) / 100
        : 0,
    }))
    .sort((a, b) => b.value - a.value);

  // -------------------------------------------------------------------------
  // 2. Assessments taken (distinct packs in period)
  // -------------------------------------------------------------------------
  const assessmentsResult = await client.query<{ total: string }>(
    `SELECT COUNT(DISTINCT mv.pack_id)::text AS total
     FROM attempt_summary_mv mv
     WHERE mv.tenant_id = current_setting('app.current_tenant', true)::uuid
       AND mv.user_id = $3
       AND mv.submitted_at >= $1::timestamptz
       AND mv.submitted_at <  $2::timestamptz + interval '1 day'`,
    [from, to, userId],
  );
  const assessmentsTakenTotal = parseInt(
    assessmentsResult.rows[0]?.total ?? '0',
    10,
  );

  // -------------------------------------------------------------------------
  // 3. avgScore — overall AVG(auto_pct) + quartile breakdown
  // -------------------------------------------------------------------------
  const avgScoreResult = await client.query<{
    avg_total: string | null;
    bucket: string;
    bucket_avg: string | null;
    bucket_cnt: string;
    total_cnt: string;
  }>(
    `WITH filtered AS (
       SELECT auto_pct
       FROM attempt_summary_mv mv
       WHERE mv.tenant_id = current_setting('app.current_tenant', true)::uuid
         AND mv.user_id = $3
         AND mv.submitted_at >= $1::timestamptz
         AND mv.submitted_at <  $2::timestamptz + interval '1 day'
         AND auto_pct IS NOT NULL
     ),
     quartile_bounds AS (
       SELECT
         PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY auto_pct) AS q1,
         PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY auto_pct) AS q2,
         PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY auto_pct) AS q3
       FROM filtered
     ),
     bucketed AS (
       SELECT
         f.auto_pct,
         CASE
           WHEN f.auto_pct >= qb.q3 THEN 'top_quartile'
           WHEN f.auto_pct >= qb.q2 THEN 'above_median'
           WHEN f.auto_pct >= qb.q1 THEN 'below_median'
           ELSE                           'bottom_quartile'
         END AS bucket
       FROM filtered f
       CROSS JOIN quartile_bounds qb
     )
     SELECT
       (SELECT ROUND(AVG(auto_pct)::numeric, 1)::text FROM filtered) AS avg_total,
       b.bucket,
       ROUND(AVG(b.auto_pct)::numeric, 1)::text                      AS bucket_avg,
       COUNT(*)::text                                                  AS bucket_cnt,
       (SELECT COUNT(*) FROM filtered)::text                          AS total_cnt
     FROM bucketed b
     GROUP BY b.bucket`,
    [from, to, userId],
  );

  const avgTotal = avgScoreResult.rows[0]?.avg_total != null
    ? parseFloat(avgScoreResult.rows[0].avg_total)
    : 0;
  const totalScored = parseInt(avgScoreResult.rows[0]?.total_cnt ?? '0', 10);

  const QUARTILE_KEYS = ['top_quartile', 'above_median', 'below_median', 'bottom_quartile'] as const;
  const bucketMap = new Map<string, { value: number; cnt: number }>();
  for (const row of avgScoreResult.rows) {
    bucketMap.set(row.bucket, {
      value: row.bucket_avg != null ? parseFloat(row.bucket_avg) : 0,
      cnt: parseInt(row.bucket_cnt, 10),
    });
  }
  const avgScoreBreakdown: ActivityBreakdownItem[] = QUARTILE_KEYS.map((key) => {
    const entry = bucketMap.get(key);
    return {
      key,
      value: entry?.value ?? 0,
      pct: totalScored > 0 && entry != null
        ? Math.round((entry.cnt / totalScored) * 100) / 100
        : 0,
    };
  });

  return {
    from,
    to,
    groupBy,
    completions:      { total: completionsTotal,      breakdown: completionsBreakdown },
    avgScore:         { total: avgTotal,               breakdown: avgScoreBreakdown },
    assessmentsTaken: { total: assessmentsTakenTotal },
  };
}

// ---------------------------------------------------------------------------
// Service — resolves defaults then delegates to withTenant
// ---------------------------------------------------------------------------

export async function getCandidateActivityStats(
  tenantId: string,
  userId: string,
  query: CandidateActivityStatsQuery,
): Promise<CandidateActivityStatsResponse> {
  const today = new Date();
  const to = query.to ?? today.toISOString().slice(0, 10);
  const fromDate = new Date(to + 'T00:00:00Z');
  fromDate.setUTCDate(fromDate.getUTCDate() - 30);
  const from = query.from ?? fromDate.toISOString().slice(0, 10);
  const groupBy = query.groupBy ?? 'domain';

  return withTenant(tenantId, (client) =>
    queryCandidateActivityStats(client, { from, to, groupBy, userId }),
  );
}

// ---------------------------------------------------------------------------
// Route registrar
// ---------------------------------------------------------------------------

export function registerCandidateActivityStatsRoute(
  app: FastifyInstance,
  preHandler: preHandlerHookHandler[],
): void {
  app.get('/api/me/activity/stats', { preHandler }, async (req, reply) => {
    const parsed = CandidateActivityStatsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('invalid query parameters', {
        details: { validation: parsed.error.errors },
      });
    }
    const { tenantId, userId } = sess(req);
    const data = await getCandidateActivityStats(tenantId, userId, parsed.data);
    return reply.send({ data });
  });
}
