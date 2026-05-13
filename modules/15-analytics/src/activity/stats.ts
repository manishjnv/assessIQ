// AssessIQ — modules/15-analytics/src/activity/stats.ts
//
// Phase 9 — GET /api/admin/activity/stats
//
// Returns aggregate completion / active-candidate / avg-score stats for the
// tenant over a date window, optionally broken down by domain or level.
//
// Data source: attempt_summary_mv (explicit tenant filter required — Postgres 16
// does NOT enforce RLS on MVs). Every query includes:
//   WHERE tenant_id = current_setting('app.current_tenant', true)::uuid
// The CI lint at tools/lint-mv-tenant-filter.ts enforces this invariant.
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

export interface ActivityBreakdownItem {
  key: string;
  value: number;
  pct: number; // 0–1, rounded to 2 decimal places
}

export interface ActivityStatsResponse {
  from: string;       // YYYY-MM-DD
  to: string;         // YYYY-MM-DD
  groupBy: 'domain' | 'level';
  completions:      { total: number; breakdown: ActivityBreakdownItem[] };
  activeCandidates: { total: number; breakdown: ActivityBreakdownItem[] };
  avgScore:         { total: number; breakdown: ActivityBreakdownItem[] };
}

// ---------------------------------------------------------------------------
// Query schema
// ---------------------------------------------------------------------------

export const ActivityStatsQuerySchema = z.object({
  from:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  groupBy: z.enum(['domain', 'level']).optional(),
});
export type ActivityStatsQuery = z.infer<typeof ActivityStatsQuerySchema>;

// ---------------------------------------------------------------------------
// Repository — runs inside a withTenant callback (GUC already set)
// ---------------------------------------------------------------------------

export async function queryActivityStats(
  client: PoolClient,
  tenantId: string,
  opts: { from: string; to: string; groupBy: 'domain' | 'level' },
): Promise<ActivityStatsResponse> {
  const { from, to, groupBy } = opts;
  void tenantId; // tenantId used via withTenant GUC; explicit filter in SQL

  // -------------------------------------------------------------------------
  // 1. Completions total + breakdown
  //    groupBy=domain → question_packs.domain (raw slug, no mapping per db020d1)
  //    groupBy=level  → levels.label
  // -------------------------------------------------------------------------
  const groupCol = groupBy === 'domain' ? 'qp.domain' : 'lv.label';

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
         AND submitted_at >= $1::timestamptz
         AND submitted_at <  $2::timestamptz + interval '1 day'
     )
     SELECT
       COUNT(*)::text                                     AS total,
       grp_key                                            AS key,
       COUNT(*)::text                                     AS cnt
     FROM base
     GROUP BY GROUPING SETS ((), (grp_key))`,
    [from, to],
  );

  // Separate total row (key IS NULL from the () grouping set) from breakdown rows
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
  // 2. Active candidates total + breakdown
  //    "Active" = at least one submitted attempt in the period.
  //    COUNT(DISTINCT user_id) per group.
  // -------------------------------------------------------------------------
  const candidatesResult = await client.query<{
    total: string;
    key: string | null;
    cnt: string;
  }>(
    `WITH base AS (
       SELECT
         mv.user_id,
         ${groupCol} AS grp_key
       FROM attempt_summary_mv mv
       LEFT JOIN question_packs qp ON qp.id = mv.pack_id
       LEFT JOIN levels        lv ON lv.id = mv.level_id
       WHERE mv.tenant_id = current_setting('app.current_tenant', true)::uuid
         AND submitted_at >= $1::timestamptz
         AND submitted_at <  $2::timestamptz + interval '1 day'
     )
     SELECT
       COUNT(DISTINCT user_id)::text                      AS total,
       grp_key                                            AS key,
       COUNT(DISTINCT user_id)::text                      AS cnt
     FROM base
     GROUP BY GROUPING SETS ((), (grp_key))`,
    [from, to],
  );

  const candidatesTotal = parseInt(
    candidatesResult.rows.find((r) => r.key === null)?.total ?? '0',
    10,
  );
  const candidatesBreakdown: ActivityBreakdownItem[] = candidatesResult.rows
    .filter((r) => r.key !== null)
    .map((r) => ({
      key: r.key as string,
      value: parseInt(r.cnt, 10),
      pct: candidatesTotal > 0
        ? Math.round((parseInt(r.cnt, 10) / candidatesTotal) * 100) / 100
        : 0,
    }))
    .sort((a, b) => b.value - a.value);

  // -------------------------------------------------------------------------
  // 3. avgScore — overall AVG(auto_pct) + quartile breakdown
  //    Quartiles computed via PERCENTILE_CONT in a CTE; each attempt is
  //    categorised into one of four buckets and AVGed within that bucket.
  //    All 4 keys are always returned (value=0, pct=0 if the bucket is empty).
  //    Note: auto_pct may be NULL for unscored attempts — filtered out.
  //    groupBy is intentionally ignored here per contract: avgScore.breakdown
  //    is always quartile-based.
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
       WHERE tenant_id = current_setting('app.current_tenant', true)::uuid
         AND submitted_at >= $1::timestamptz
         AND submitted_at <  $2::timestamptz + interval '1 day'
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
    [from, to],
  );

  const avgTotal = avgScoreResult.rows[0]?.avg_total != null
    ? parseFloat(avgScoreResult.rows[0].avg_total)
    : 0;

  const totalScored = parseInt(avgScoreResult.rows[0]?.total_cnt ?? '0', 10);

  // Ensure all 4 bucket keys are present even if some are empty
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
    completions:      { total: completionsTotal,  breakdown: completionsBreakdown },
    activeCandidates: { total: candidatesTotal,   breakdown: candidatesBreakdown },
    avgScore:         { total: avgTotal,           breakdown: avgScoreBreakdown },
  };
}

// ---------------------------------------------------------------------------
// Service — resolves defaults then delegates to withTenant
// ---------------------------------------------------------------------------

export async function getActivityStats(
  tenantId: string,
  query: ActivityStatsQuery,
): Promise<ActivityStatsResponse> {
  // Resolve defaults BEFORE entering withTenant (pure JS, no DB needed)
  const today = new Date();
  const to = query.to ?? today.toISOString().slice(0, 10);
  const fromDate = new Date(to + 'T00:00:00Z');
  fromDate.setUTCDate(fromDate.getUTCDate() - 30);
  const from = query.from ?? fromDate.toISOString().slice(0, 10);
  const groupBy = query.groupBy ?? 'domain';

  return withTenant(tenantId, (client) =>
    queryActivityStats(client, tenantId, { from, to, groupBy }),
  );
}

// ---------------------------------------------------------------------------
// Route registrar
// ---------------------------------------------------------------------------

export function registerActivityStatsRoute(
  app: FastifyInstance,
  preHandler: preHandlerHookHandler[],
): void {
  app.get('/api/admin/activity/stats', { preHandler }, async (req, reply) => {
    const parsed = ActivityStatsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('invalid query parameters', {
        details: { validation: parsed.error.errors },
      });
    }
    const tenantId = (req as unknown as { session: { tenantId: string } }).session.tenantId;
    const data = await getActivityStats(tenantId, parsed.data);
    return reply.send({ data });
  });
}
