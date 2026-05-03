// AssessIQ — modules/15-analytics/src/repository.ts
//
// Phase 3 G3.C — raw SQL queries for analytics.
//
// CRITICAL — tenant isolation on the materialized view:
//   Postgres 16 does NOT enforce RLS on materialized views. Every query
//   against attempt_summary_mv MUST include an explicit:
//     WHERE tenant_id = current_setting('app.current_tenant', true)::uuid
//   This file is scanned by tools/lint-mv-tenant-filter.ts; any query
//   that reads attempt_summary_mv without this filter causes a CI failure.
//
// Live-table queries (homeKpis, queueSummary) run through withTenant so
// the connection has SET LOCAL app.current_tenant and RLS fires normally.
// No WHERE tenant_id needed on those (RLS handles it).
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.

import type { PoolClient } from 'pg';
import { Readable } from 'node:stream';
import type {
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
} from './types.js';

export const EXPORT_ROW_CAP = 10_000;

// ---------------------------------------------------------------------------
// Dashboard: homeKpis — queries LIVE tables (RLS via withTenant context)
// ---------------------------------------------------------------------------

export async function queryHomeKpis(client: PoolClient, tenantId: string): Promise<HomeKpis> {
  // Active assessments
  const activeResult = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM assessments WHERE status = 'active'`,
  );
  const activeAssessments = parseInt(activeResult.rows[0]?.count ?? '0', 10);

  // Attempts this week
  const attemptsWeekResult = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM attempts
     WHERE created_at >= now() - interval '7 days'`,
  );
  const attemptsThisWeek = parseInt(attemptsWeekResult.rows[0]?.count ?? '0', 10);

  // Awaiting review
  const awaitingResult = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM attempts WHERE status = 'pending_admin_grading'`,
  );
  const awaitingReview = parseInt(awaitingResult.rows[0]?.count ?? '0', 10);

  // Avg pct this week (from scored attempts created this week)
  const avgResult = await client.query<{ avg_pct: string | null }>(
    `SELECT ROUND(AVG(ats.auto_pct)::numeric, 2)::text AS avg_pct
     FROM attempt_scores ats
     JOIN attempts a ON a.id = ats.attempt_id
     WHERE a.created_at >= now() - interval '7 days'`,
  );
  const avgPctThisWeek = avgResult.rows[0]?.avg_pct != null
    ? parseFloat(avgResult.rows[0].avg_pct)
    : null;

  void tenantId; // tenantId is set via withTenant GUC; RLS enforces scope
  return { activeAssessments, attemptsThisWeek, awaitingReview, avgPctThisWeek };
}

// ---------------------------------------------------------------------------
// Dashboard: queueSummary — queries LIVE tables (RLS via withTenant)
// ---------------------------------------------------------------------------

export async function queryQueueSummary(client: PoolClient, tenantId: string): Promise<QueueSummary> {
  const result = await client.query<{
    in_progress: string;
    grading: string;
    pending_admin_grading: string;
    graded: string;
    released: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'in_progress')::text           AS in_progress,
       COUNT(*) FILTER (WHERE status = 'grading')::text               AS grading,
       COUNT(*) FILTER (WHERE status = 'pending_admin_grading')::text AS pending_admin_grading,
       COUNT(*) FILTER (WHERE status = 'graded')::text                AS graded,
       COUNT(*) FILTER (WHERE status = 'released')::text              AS released
     FROM attempts`,
  );
  const row = result.rows[0];
  void tenantId;
  return {
    inProgress: parseInt(row?.in_progress ?? '0', 10),
    grading: parseInt(row?.grading ?? '0', 10),
    awaitingReview: parseInt(row?.pending_admin_grading ?? '0', 10),
    ready: parseInt(row?.graded ?? '0', 10) + parseInt(row?.released ?? '0', 10),
  };
}

// ---------------------------------------------------------------------------
// Reports: cohortReport — reads attempt_summary_mv (explicit tenant filter)
// ---------------------------------------------------------------------------

export async function queryCohortReport(
  client: PoolClient,
  tenantId: string,
  assessmentId: string,
): Promise<CohortReport> {
  // Aggregate from MV — explicit tenant filter required (no RLS on MV)
  const aggResult = await client.query<{
    attempt_count: string;
    average_pct: string | null;
    p25: string | null;
    p50: string | null;
    p75: string | null;
    p90: string | null;
  }>(
    `SELECT
       COUNT(*)::text                                                         AS attempt_count,
       ROUND(AVG(auto_pct)::numeric, 2)::text                                AS average_pct,
       PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY auto_pct)::text          AS p25,
       PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY auto_pct)::text          AS p50,
       PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY auto_pct)::text          AS p75,
       PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY auto_pct)::text          AS p90
     FROM attempt_summary_mv
     WHERE tenant_id = current_setting('app.current_tenant', true)::uuid
       AND assessment_id = $1`,
    [assessmentId],
  );
  const agg = aggResult.rows[0];

  // Archetype distribution from MV — explicit tenant filter required
  const archetypeResult = await client.query<{ archetype: string; count: string }>(
    `SELECT archetype, COUNT(*)::text AS count
     FROM attempt_summary_mv
     WHERE tenant_id = current_setting('app.current_tenant', true)::uuid
       AND assessment_id = $1
       AND archetype IS NOT NULL
     GROUP BY archetype
     ORDER BY count DESC`,
    [assessmentId],
  );
  const archetypeDistribution: Record<string, number> = {};
  for (const r of archetypeResult.rows) {
    archetypeDistribution[r.archetype] = parseInt(r.count, 10);
  }

  // Level breakdown from MV — explicit tenant filter required
  const levelResult = await client.query<{
    level_id: string;
    level_label: string;
    attempt_count: string;
    average_pct: string | null;
  }>(
    `SELECT
       mv.level_id,
       l.label AS level_label,
       COUNT(*)::text AS attempt_count,
       ROUND(AVG(mv.auto_pct)::numeric, 2)::text AS average_pct
     FROM attempt_summary_mv mv
     LEFT JOIN levels l ON l.id = mv.level_id
     WHERE mv.tenant_id = current_setting('app.current_tenant', true)::uuid
       AND mv.assessment_id = $1
     GROUP BY mv.level_id, l.label
     ORDER BY l.label`,
    [assessmentId],
  );
  const levelBreakdown: LevelBreakdown[] = levelResult.rows.map((r) => ({
    levelId: r.level_id,
    levelLabel: r.level_label ?? r.level_id,
    attemptCount: parseInt(r.attempt_count, 10),
    averagePct: r.average_pct != null ? parseFloat(r.average_pct) : null,
  }));

  // Topic breakdown from live gradings table (RLS applies normally)
  const topicResult = await client.query<{
    topic: string;
    attempts_count: string;
    average_pct: string | null;
    hit_rate_pct: string | null;
  }>(
    `SELECT
       q.topic,
       COUNT(DISTINCT a.id)::text AS attempts_count,
       ROUND(AVG(g.score_earned / NULLIF(g.score_max, 0) * 100)::numeric, 2)::text AS average_pct,
       ROUND(
         100.0 * COUNT(*) FILTER (WHERE g.score_earned = g.score_max AND g.score_max > 0)
         / NULLIF(COUNT(*), 0)::numeric, 2
       )::text AS hit_rate_pct
     FROM attempts a
     JOIN assessments asm ON asm.id = a.assessment_id
     JOIN attempt_questions aq ON aq.attempt_id = a.id
     JOIN questions q ON q.id = aq.question_id
     JOIN gradings g ON g.attempt_id = a.id AND g.question_id = aq.question_id
     WHERE asm.id = $1
     GROUP BY q.topic
     ORDER BY q.topic`,
    [assessmentId],
  );
  const topicBreakdown: TopicBreakdownItem[] = topicResult.rows.map((r) => ({
    topic: r.topic,
    attemptsCount: parseInt(r.attempts_count, 10),
    averagePct: r.average_pct != null ? parseFloat(r.average_pct) : null,
    hitRatePct: r.hit_rate_pct != null ? parseFloat(r.hit_rate_pct) : null,
  }));

  void tenantId;
  return {
    assessmentId,
    attemptCount: parseInt(agg?.attempt_count ?? '0', 10),
    averagePct: agg?.average_pct != null ? parseFloat(agg.average_pct) : null,
    p25: agg?.p25 != null ? parseFloat(agg.p25) : null,
    p50: agg?.p50 != null ? parseFloat(agg.p50) : null,
    p75: agg?.p75 != null ? parseFloat(agg.p75) : null,
    p90: agg?.p90 != null ? parseFloat(agg.p90) : null,
    archetypeDistribution,
    levelBreakdown,
    topicBreakdown,
  };
}

// ---------------------------------------------------------------------------
// Reports: individualReport — reads attempt_summary_mv + live tables
// ---------------------------------------------------------------------------

export async function queryIndividualReport(
  client: PoolClient,
  tenantId: string,
  userId: string,
  opts: { from?: string; to?: string },
): Promise<IndividualReport> {
  const conditions: string[] = [
    `tenant_id = current_setting('app.current_tenant', true)::uuid`,
    `user_id = $1`,
  ];
  const params: unknown[] = [userId];
  let idx = 2;

  if (opts.from) {
    conditions.push(`submitted_at >= $${idx++}`);
    params.push(opts.from);
  }
  if (opts.to) {
    conditions.push(`submitted_at <= $${idx++}`);
    params.push(opts.to);
  }

  // Reads attempt_summary_mv — explicit tenant filter required (in conditions[0])
  const rows = await client.query<{
    attempt_id: string;
    assessment_id: string;
    assessment_name: string;
    attempt_status: string;
    submitted_at: Date | null;
    total_earned: string;
    total_max: string;
    auto_pct: string;
    archetype: string | null;
    computed_at: Date;
  }>(
    `SELECT attempt_id, assessment_id, assessment_name,
            attempt_status, submitted_at, total_earned,
            total_max, auto_pct, archetype, computed_at
     FROM attempt_summary_mv
     WHERE ${conditions.join(' AND ')}
     ORDER BY computed_at DESC`,
    params,
  );

  const attempts: AttemptSummaryRow[] = rows.rows.map((r) => ({
    attemptId: r.attempt_id,
    assessmentId: r.assessment_id,
    assessmentName: r.assessment_name,
    status: r.attempt_status,
    submittedAt: r.submitted_at?.toISOString() ?? null,
    totalEarned: parseFloat(r.total_earned),
    totalMax: parseFloat(r.total_max),
    autoPct: parseFloat(r.auto_pct),
    archetype: r.archetype,
    computedAt: r.computed_at.toISOString(),
  }));

  // Archetype progression (most recent first, by computed_at)
  const archetypeMap: Record<string, number> = {};
  for (const row of attempts) {
    if (row.archetype != null) {
      archetypeMap[row.archetype] = (archetypeMap[row.archetype] ?? 0) + 1;
    }
  }
  const total = Object.values(archetypeMap).reduce((s, n) => s + n, 0);
  const archetypeProgression = Object.entries(archetypeMap)
    .map(([archetype, count]) => ({
      archetype,
      weight: total > 0 ? parseFloat((count / total).toFixed(4)) : 0,
    }))
    .sort((a, b) => b.weight - a.weight);

  void tenantId;
  return { userId, attempts, archetypeProgression };
}

// ---------------------------------------------------------------------------
// Reports: topicHeatmap — reads live tables (RLS via withTenant)
// ---------------------------------------------------------------------------

export async function queryTopicHeatmap(
  client: PoolClient,
  tenantId: string,
  packId: string,
  opts: { from?: string | undefined; to?: string | undefined },
): Promise<TopicHeatmap> {
  const conditions: string[] = [`q.pack_id = $1`];
  const params: unknown[] = [packId];
  let idx = 2;

  if (opts.from) {
    conditions.push(`a.submitted_at >= $${idx++}`);
    params.push(opts.from);
  }
  if (opts.to) {
    conditions.push(`a.submitted_at <= $${idx++}`);
    params.push(opts.to);
  }

  const result = await client.query<{
    topic: string;
    attempts_count: string;
    attempts_correct: string;
    hit_rate_pct: string;
    mean_band: string | null;
    p50_band: string | null;
  }>(
    `SELECT
       q.topic,
       COUNT(g.id)::text AS attempts_count,
       COUNT(*) FILTER (WHERE g.score_earned = g.score_max AND g.score_max > 0)::text AS attempts_correct,
       ROUND(
         100.0 * COUNT(*) FILTER (WHERE g.score_earned = g.score_max AND g.score_max > 0)
         / NULLIF(COUNT(g.id), 0)::numeric, 2
       )::text AS hit_rate_pct,
       ROUND(AVG(g.reasoning_band)::numeric, 2)::text AS mean_band,
       PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY g.reasoning_band)::text AS p50_band
     FROM attempts a
     JOIN assessments asm ON asm.id = a.assessment_id
     JOIN attempt_questions aq ON aq.attempt_id = a.id
     JOIN questions q ON q.id = aq.question_id
     JOIN gradings g ON g.attempt_id = a.id AND g.question_id = aq.question_id
     WHERE ${conditions.join(' AND ')}
       AND a.status IN ('submitted','pending_admin_grading','graded','released')
     GROUP BY q.topic
     ORDER BY q.topic`,
    params,
  );

  const cells: TopicHeatmapCell[] = result.rows.map((r) => ({
    topic: r.topic,
    attemptsCount: parseInt(r.attempts_count, 10),
    attemptsCorrect: parseInt(r.attempts_correct, 10),
    hitRatePct: parseFloat(r.hit_rate_pct),
    meanBand: r.mean_band != null ? parseFloat(r.mean_band) : null,
    p50Band: r.p50_band != null ? parseFloat(r.p50_band) : null,
  }));

  void tenantId;
  return {
    tenantId,
    packId,
    periodStart: opts.from ?? null,
    periodEnd: opts.to ?? null,
    cells,
  };
}

// ---------------------------------------------------------------------------
// Reports: archetypeDistribution — reads attempt_summary_mv
// ---------------------------------------------------------------------------

export async function queryArchetypeDistribution(
  client: PoolClient,
  tenantId: string,
  assessmentId: string,
): Promise<ArchetypeDistributionItem[]> {
  // Reads attempt_summary_mv — explicit tenant filter required
  const result = await client.query<{ archetype: string; count: string }>(
    `SELECT archetype, COUNT(*)::text AS count
     FROM attempt_summary_mv
     WHERE tenant_id = current_setting('app.current_tenant', true)::uuid
       AND assessment_id = $1
       AND archetype IS NOT NULL
     GROUP BY archetype
     ORDER BY count DESC`,
    [assessmentId],
  );
  void tenantId;
  return result.rows.map((r) => ({
    archetype: r.archetype,
    count: parseInt(r.count, 10),
  }));
}

// ---------------------------------------------------------------------------
// Cost telemetry: gradingCostByMonth — reads grading_jobs (Phase 4+)
// ---------------------------------------------------------------------------

/**
 * Returns rows from grading_jobs.cost_* columns.
 * Only meaningful in anthropic-api mode (Phase 4+).
 * Returns [] in claude-code-vps mode — called from service.ts after the mode check.
 */
export async function queryCostByMonth(
  client: PoolClient,
  tenantId: string,
  year: number,
): Promise<CostRow[]> {
  // grading_jobs table ships in Phase 4 (anthropic-api mode).
  // This query runs only when AI_PIPELINE_MODE = 'anthropic-api'.
  // In Phase 3 / claude-code-vps, service.ts returns [] before calling here.
  const result = await client.query<{
    month: string;
    input_tokens: string;
    output_tokens: string;
    estimated_cost_usd: string;
    model: string;
  }>(
    `SELECT
       to_char(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
       SUM(COALESCE(cost_input_tokens, 0))::text           AS input_tokens,
       SUM(COALESCE(cost_output_tokens, 0))::text          AS output_tokens,
       ROUND(
         (SUM(COALESCE(cost_input_tokens, 0)) * 0.000003
          + SUM(COALESCE(cost_output_tokens, 0)) * 0.000015)::numeric, 4
       )::text                                             AS estimated_cost_usd,
       model
     FROM grading_jobs
     WHERE status = 'done'
       AND EXTRACT(YEAR FROM created_at) = $1
     GROUP BY month, model
     ORDER BY month, model`,
    [year],
  );
  void tenantId;
  return result.rows.map((r) => ({
    month: r.month,
    currency: 'USD' as const,
    inputTokens: parseInt(r.input_tokens, 10),
    outputTokens: parseInt(r.output_tokens, 10),
    estimatedCostUsd: parseFloat(r.estimated_cost_usd),
    model: r.model,
  }));
}

// ---------------------------------------------------------------------------
// Exports: streamAttemptsCsv — Postgres cursor streaming, 1000-row batches
// ---------------------------------------------------------------------------

/**
 * Builds a WHERE clause + params for attempt export filters.
 * Returns { where, params } where params is the positional-$N array.
 */
function buildExportWhere(
  filter: { assessmentId?: string | undefined; from?: string | undefined; to?: string | undefined; status?: string | undefined },
  tenantFilter: string,
): { where: string; params: unknown[] } {
  const conditions: string[] = [tenantFilter];
  const params: unknown[] = [];
  let idx = 1;

  if (filter.assessmentId) {
    conditions.push(`a.assessment_id = $${idx++}`);
    params.push(filter.assessmentId);
  }
  if (filter.from) {
    conditions.push(`a.submitted_at >= $${idx++}`);
    params.push(filter.from);
  }
  if (filter.to) {
    conditions.push(`a.submitted_at <= $${idx++}`);
    params.push(filter.to);
  }
  if (filter.status) {
    conditions.push(`a.status = $${idx++}`);
    params.push(filter.status);
  }

  return { where: conditions.join(' AND '), params };
}

const ATTEMPT_EXPORT_COLUMNS: (keyof AttemptExportRow)[] = [
  'tenant_id',
  'assessment_id',
  'assessment_name',
  'user_id',
  'user_email',
  'attempt_id',
  'status',
  'submitted_at',
  'total_earned',
  'total_max',
  'auto_pct',
  'archetype',
  'computed_at',
];

/**
 * Stream attempt export rows from attempt_summary_mv.
 * Fetches all rows up to EXPORT_ROW_CAP at once, returns a Readable.
 */
export async function streamAttemptExportRows(
  client: PoolClient,
  tenantId: string,
  filter: { assessmentId?: string | undefined; from?: string | undefined; to?: string | undefined; status?: string | undefined; limit?: number | undefined },
  format: 'csv' | 'jsonl',
): Promise<Readable> {
  // Reads attempt_summary_mv — explicit tenant filter is included in the WHERE clause.
  // We fetch all rows at once (bounded by EXPORT_ROW_CAP = 10_000) rather than using
  // a cursor. This avoids the withTenant() + cursor lifetime mismatch:
  //   - withTenant() opens a transaction, calls fn(client), then COMMITs and releases
  //     the client BEFORE the stream is consumed lazily.
  //   - Cursors only exist within the transaction, so a lazy-consume stream would
  //     FETCH from a cursor that no longer exists.
  // A 10k-row pre-fetch is well within memory bounds (< 5 MB for typical row sizes).
  const limit = Math.min(filter.limit ?? EXPORT_ROW_CAP, EXPORT_ROW_CAP);
  const { where, params } = buildExportWhere(filter, `mv.tenant_id = current_setting('app.current_tenant', true)::uuid`);

  void tenantId;

  const result = await client.query<Record<string, string | null>>(
    `SELECT
       mv.tenant_id::text,
       mv.assessment_id::text,
       mv.assessment_name,
       mv.user_id::text,
       u.email AS user_email,
       mv.attempt_id::text,
       mv.attempt_status     AS status,
       mv.submitted_at::text,
       mv.total_earned::text,
       mv.total_max::text,
       mv.auto_pct::text,
       mv.archetype,
       mv.computed_at::text
     FROM attempt_summary_mv mv
     JOIN attempts a   ON a.id  = mv.attempt_id
     JOIN users    u   ON u.id  = mv.user_id
     WHERE ${where}
     ORDER BY mv.computed_at DESC
     LIMIT ${limit}`,
    params,
  );

  // Build lines from pre-fetched rows and return a Readable that emits them.
  const lines: string[] = [];

  if (format === 'csv') {
    lines.push(ATTEMPT_EXPORT_COLUMNS.join(',') + '\r\n');
  }

  for (const row of result.rows) {
    if (format === 'csv') {
      const line = ATTEMPT_EXPORT_COLUMNS.map((col) => {
        const val = row[col as string] ?? '';
        if (typeof val === 'string' && (val.includes(',') || val.includes('"') || val.includes('\n'))) {
          return `"${val.replace(/"/g, '""')}"`;
        }
        return val;
      }).join(',') + '\r\n';
      lines.push(line);
    } else {
      const obj: Record<string, unknown> = {};
      for (const col of ATTEMPT_EXPORT_COLUMNS) {
        obj[col as string] = row[col as string] ?? null;
      }
      lines.push(JSON.stringify(obj) + '\n');
    }
  }

  return Readable.from(lines);
}

// ---------------------------------------------------------------------------
// Exports: streamTopicHeatmapCsv — materialises topicHeatmap as CSV stream
// ---------------------------------------------------------------------------

const TOPIC_HEATMAP_EXPORT_COLUMNS: (keyof TopicHeatmapExportRow)[] = [
  'tenant_id',
  'pack_id',
  'topic',
  'attempts_count',
  'attempts_correct',
  'hit_rate_pct',
  'mean_band',
  'p50_band',
];

export async function streamTopicHeatmapCsv(
  client: PoolClient,
  tenantId: string,
  packId: string,
  opts: { from?: string | undefined; to?: string | undefined },
): Promise<Readable> {
  // Fetch all heatmap data (topic heatmaps are small — no cursor needed)
  const heatmap = await queryTopicHeatmap(client, tenantId, packId, opts);

  const rows: TopicHeatmapExportRow[] = heatmap.cells.map((cell) => ({
    tenant_id: tenantId,
    pack_id: packId,
    topic: cell.topic,
    attempts_count: cell.attemptsCount,
    attempts_correct: cell.attemptsCorrect,
    hit_rate_pct: cell.hitRatePct,
    mean_band: cell.meanBand,
    p50_band: cell.p50Band,
  }));

  const lines: string[] = [TOPIC_HEATMAP_EXPORT_COLUMNS.join(',') + '\r\n'];
  for (const row of rows) {
    const line = TOPIC_HEATMAP_EXPORT_COLUMNS.map((col) => {
      const val = row[col as keyof TopicHeatmapExportRow];
      if (val === null || val === undefined) return '';
      const s = String(val);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    }).join(',') + '\r\n';
    lines.push(line);
  }

  const content = lines.join('');
  return Readable.from([content]);
}
