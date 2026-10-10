// AssessIQ — modules/09-scoring repository layer.
//
// Phase 2 G2.B Session 3 — raw SQL via PoolClient.
//
// CRITICAL — RLS-only scoping (CLAUDE.md hard rule #4):
//   Every query runs through a PoolClient whose connection has already received
//   SET LOCAL ROLE assessiq_app + set_config('app.current_tenant', ...) from
//   withTenant(). RLS on attempt_scores (and on the tables we JOIN) enforces
//   tenant isolation at the Postgres layer. NEVER add WHERE tenant_id = $N —
//   that pattern masks RLS bugs.
//
//   Exception: upsertAttemptScore passes tenant_id to satisfy the WITH CHECK
//   policy (same rationale as insertAttempt in modules/06-attempt-engine).
//
// Performance note: computeAttemptScore is called after every admin-accept and
// on manual recompute. The queries run O(question_count) rows — small and fast.
// cohortStats / leaderboard are admin-on-demand; no latency SLA beyond reasonable.

import type { PoolClient } from "pg";
import { logger } from "@assessiq/core";
import type {
  AttemptScore,
  CohortStats,
  CohortPercentiles,
  LeaderboardRow,
  IndividualReport,
} from "./types.js";
import { ArchetypeSignalsSchema } from "./types.js";

// ---------------------------------------------------------------------------
// Internal row shapes (raw Postgres → typed)
// ---------------------------------------------------------------------------

interface AttemptRow {
  status: string;
  started_at: Date | null;
  duration_seconds: number | null;
  assessment_id: string;
}

interface GradingRow {
  question_id: string;
  question_type: string;
  score_earned: number;
  score_max: number;
  status: string;
  reasoning_band: number | null;
  error_class: string | null;
}

interface AnswerRow {
  question_id: string;
  time_spent_seconds: number;
  edits_count: number;
  flagged: boolean;
}

interface EventRow {
  event_type: string;
  at: Date;
}

interface CohortDbRow {
  attempt_count: string;
  average_pct: string | null;
  p50: string | null;
  p75: string | null;
  p90: string | null;
}

interface CohortPercentilesDbRow {
  time_p25_ms: string | null;
  time_p75_ms: string | null;
  edit_p25: string | null;
  edit_p75: string | null;
  iqr_p25_ms: string | null;
  sample_size: string;
}

interface AttemptScoreDbRow {
  attempt_id: string;
  tenant_id: string;
  total_earned: string;
  total_max: string;
  auto_pct: string;
  pending_review: boolean;
  archetype: string | null;
  archetype_signals: unknown | null;
  computed_at: Date;
}

// ---------------------------------------------------------------------------
// getAttempt — fetch status + timing for archetype computation
// ---------------------------------------------------------------------------

export async function getAttempt(
  client: PoolClient,
  attemptId: string,
): Promise<AttemptRow | null> {
  const res = await client.query<{
    status: string;
    started_at: Date | null;
    duration_seconds: number | null;
    assessment_id: string;
  }>(
    `SELECT status, started_at, duration_seconds, assessment_id
     FROM attempts
     WHERE id = $1`,
    [attemptId],
  );
  return res.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// getGradingsForAttempt — latest grading per (attempt, question)
//
// "Latest" = highest graded_at. override_of IS NOT NULL rows are the override
// themselves — we still pick the LATEST row per question regardless, which is
// the override row. This correctly reflects the post-override score.
// An admin_override row wins a graded_at tie (same transaction => same now()):
// the same "effective grading" rule as finalizeAttemptIfComplete and
// 15-analytics results-export.
// ---------------------------------------------------------------------------

export async function getGradingsForAttempt(
  client: PoolClient,
  attemptId: string,
): Promise<GradingRow[]> {
  const res = await client.query<{
    question_id: string;
    question_type: string;
    score_earned: string;
    score_max: string;
    status: string;
    reasoning_band: number | null;
    error_class: string | null;
  }>(
    `SELECT DISTINCT ON (g.question_id)
       g.question_id,
       COALESCE(qv.type, q.type) AS question_type, -- N21: frozen type; q.type only if the attempt row/version is missing
       g.score_earned::text,
       g.score_max::text,
       g.status,
       g.reasoning_band,
       g.error_class
     FROM gradings g
     JOIN questions q ON q.id = g.question_id
     LEFT JOIN attempt_questions aq
       ON aq.attempt_id = g.attempt_id AND aq.question_id = g.question_id
     LEFT JOIN question_versions qv
       ON qv.question_id = aq.question_id AND qv.version = aq.question_version
     WHERE g.attempt_id = $1
     ORDER BY g.question_id, g.graded_at DESC, (g.grader = 'admin_override') DESC`,
    [attemptId],
  );
  return res.rows.map((r) => ({
    question_id: r.question_id,
    question_type: r.question_type,
    score_earned: parseFloat(r.score_earned),
    score_max: parseFloat(r.score_max),
    status: r.status,
    reasoning_band: r.reasoning_band,
    error_class: r.error_class,
  }));
}

// ---------------------------------------------------------------------------
// getAttemptAnswers — per-question timing + edit data
// ---------------------------------------------------------------------------

export async function getAttemptAnswers(
  client: PoolClient,
  attemptId: string,
): Promise<AnswerRow[]> {
  const res = await client.query<{
    question_id: string;
    time_spent_seconds: number;
    edits_count: number;
    flagged: boolean;
  }>(
    `SELECT question_id, time_spent_seconds, edits_count, flagged
     FROM attempt_answers
     WHERE attempt_id = $1`,
    [attemptId],
  );
  return res.rows.map((r) => ({
    question_id: r.question_id,
    time_spent_seconds: Number(r.time_spent_seconds),
    edits_count: Number(r.edits_count),
    flagged: Boolean(r.flagged),
  }));
}

// ---------------------------------------------------------------------------
// getAttemptEvents — all events for archetype signal extraction
// ---------------------------------------------------------------------------

export async function getAttemptEvents(
  client: PoolClient,
  attemptId: string,
): Promise<EventRow[]> {
  const res = await client.query<{ event_type: string; at: Date }>(
    `SELECT event_type, at
     FROM attempt_events
     WHERE attempt_id = $1
     ORDER BY at ASC`,
    [attemptId],
  );
  return res.rows;
}

// ---------------------------------------------------------------------------
// getCohortPercentiles — p25/p75 of signals from OTHER scored attempts in
// the same assessment. Returns null when sample_size < 2.
// ---------------------------------------------------------------------------

export async function getCohortPercentiles(
  client: PoolClient,
  assessmentId: string,
  excludeAttemptId: string,
): Promise<CohortPercentiles | null> {
  const res = await client.query<CohortPercentilesDbRow>(
    `SELECT
       PERCENTILE_CONT(0.25) WITHIN GROUP (
         ORDER BY (atsc.archetype_signals->>'time_per_question_p50_ms')::float
       ) AS time_p25_ms,
       PERCENTILE_CONT(0.75) WITHIN GROUP (
         ORDER BY (atsc.archetype_signals->>'time_per_question_p50_ms')::float
       ) AS time_p75_ms,
       PERCENTILE_CONT(0.25) WITHIN GROUP (
         ORDER BY (atsc.archetype_signals->>'edit_count_total')::float
       ) AS edit_p25,
       PERCENTILE_CONT(0.75) WITHIN GROUP (
         ORDER BY (atsc.archetype_signals->>'edit_count_total')::float
       ) AS edit_p75,
       PERCENTILE_CONT(0.25) WITHIN GROUP (
         ORDER BY (atsc.archetype_signals->>'time_per_question_iqr_ms')::float
       ) AS iqr_p25_ms,
       COUNT(*) AS sample_size
     FROM attempt_scores atsc
     JOIN attempts a ON a.id = atsc.attempt_id
     WHERE a.assessment_id = $1
       AND atsc.attempt_id != $2
       AND atsc.archetype_signals IS NOT NULL`,
    [assessmentId, excludeAttemptId],
  );

  const row = res.rows[0];
  if (!row || parseInt(row.sample_size, 10) < 2) return null;

  // If any percentile is null (e.g. all archetype_signals->>'field' were null),
  // we still don't have enough meaningful data.
  if (
    row.time_p25_ms === null ||
    row.time_p75_ms === null ||
    row.edit_p25 === null ||
    row.edit_p75 === null ||
    row.iqr_p25_ms === null
  ) {
    return null;
  }

  return {
    time_p25_ms: parseFloat(row.time_p25_ms),
    time_p75_ms: parseFloat(row.time_p75_ms),
    edit_p25: parseFloat(row.edit_p25),
    edit_p75: parseFloat(row.edit_p75),
    iqr_p25_ms: parseFloat(row.iqr_p25_ms),
  };
}

// ---------------------------------------------------------------------------
// upsertAttemptScore — UPSERT on attempt_id PK (idempotent)
// ---------------------------------------------------------------------------

export interface UpsertAttemptScoreInput {
  attempt_id: string;
  tenant_id: string;
  total_earned: number;
  total_max: number;
  auto_pct: number;
  pending_review: boolean;
  archetype: string | null;
  archetype_signals: unknown | null;
}

export async function upsertAttemptScore(
  client: PoolClient,
  row: UpsertAttemptScoreInput,
): Promise<AttemptScore> {
  const res = await client.query<AttemptScoreDbRow>(
    `INSERT INTO attempt_scores
       (attempt_id, tenant_id, total_earned, total_max, auto_pct,
        pending_review, archetype, archetype_signals, computed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())
     ON CONFLICT (attempt_id) DO UPDATE SET
       total_earned      = EXCLUDED.total_earned,
       total_max         = EXCLUDED.total_max,
       auto_pct          = EXCLUDED.auto_pct,
       pending_review    = EXCLUDED.pending_review,
       archetype         = EXCLUDED.archetype,
       archetype_signals = EXCLUDED.archetype_signals,
       computed_at       = now()
     RETURNING *`,
    [
      row.attempt_id,
      row.tenant_id,
      row.total_earned,
      row.total_max,
      row.auto_pct,
      row.pending_review,
      row.archetype,
      row.archetype_signals != null
        ? JSON.stringify(row.archetype_signals)
        : null,
    ],
  );

  const r = res.rows[0]!;
  return mapAttemptScoreRow(r);
}

// ---------------------------------------------------------------------------
// isAttemptTenantVisible — false when the attempt is missing or its result is
// not yet released to the tenant (TENANT_VISIBLE_ATTEMPT_SQL).
// ---------------------------------------------------------------------------

export async function isAttemptTenantVisible(
  client: PoolClient,
  attemptId: string,
): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM attempts a WHERE a.id = $1 AND ${TENANT_VISIBLE_ATTEMPT_SQL}`,
    [attemptId],
  );
  return res.rows.length > 0;
}

// ---------------------------------------------------------------------------
// getAttemptScore — fetch existing row (returns null if not yet computed)
// ---------------------------------------------------------------------------

export async function getAttemptScore(
  client: PoolClient,
  attemptId: string,
): Promise<AttemptScore | null> {
  const res = await client.query<AttemptScoreDbRow>(
    `SELECT * FROM attempt_scores WHERE attempt_id = $1`,
    [attemptId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return mapAttemptScoreRow(r);
}

// Tenant-visible score rule (2026-10-01): a tenant sees a score only once the
// result is released to it — status 'released', or 'graded' with
// evaluation_released_at set (same rule as 15 results-export / 07
// deriveEvaluationStatus). Applied to every tenant report reader below.
export const TENANT_VISIBLE_ATTEMPT_SQL =
  "(a.status = 'released' OR (a.status = 'graded' AND a.evaluation_released_at IS NOT NULL))";

// ---------------------------------------------------------------------------
// getCohortStats — aggregate stats for all graded attempts in an assessment
// ---------------------------------------------------------------------------

export async function getCohortStats(
  client: PoolClient,
  assessmentId: string,
): Promise<CohortStats> {
  const aggRes = await client.query<CohortDbRow>(
    `SELECT
       COUNT(*)::text                                              AS attempt_count,
       AVG(atsc.auto_pct)::text                                   AS average_pct,
       PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY atsc.auto_pct)::text AS p50,
       PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY atsc.auto_pct)::text AS p75,
       PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY atsc.auto_pct)::text AS p90
     FROM attempt_scores atsc
     JOIN attempts a ON a.id = atsc.attempt_id
     WHERE a.assessment_id = $1
       AND ${TENANT_VISIBLE_ATTEMPT_SQL}`,
    [assessmentId],
  );

  const archetypeRes = await client.query<{ archetype: string; cnt: string }>(
    `SELECT atsc.archetype, COUNT(*)::text AS cnt
     FROM attempt_scores atsc
     JOIN attempts a ON a.id = atsc.attempt_id
     WHERE a.assessment_id = $1
       AND atsc.archetype IS NOT NULL
       AND ${TENANT_VISIBLE_ATTEMPT_SQL}
     GROUP BY atsc.archetype`,
    [assessmentId],
  );

  const agg = aggRes.rows[0];
  const archetypeDistribution: Record<string, number> = {};
  for (const row of archetypeRes.rows) {
    archetypeDistribution[row.archetype] = parseInt(row.cnt, 10);
  }

  return {
    attempt_count: parseInt(agg?.attempt_count ?? "0", 10),
    average_pct:
      agg?.average_pct != null ? parseFloat(agg.average_pct) : null,
    p50: agg?.p50 != null ? parseFloat(agg.p50) : null,
    p75: agg?.p75 != null ? parseFloat(agg.p75) : null,
    p90: agg?.p90 != null ? parseFloat(agg.p90) : null,
    archetype_distribution: archetypeDistribution,
  };
}

// ---------------------------------------------------------------------------
// getLeaderboard — top-N by auto_pct, RLS-enforced, admin-only per P2.D13
// ---------------------------------------------------------------------------

export async function getLeaderboard(
  client: PoolClient,
  assessmentId: string,
  opts: { topN: number; anonymize: boolean },
): Promise<LeaderboardRow[]> {
  const res = await client.query<{
    attempt_id: string;
    candidate_name: string;
    candidate_email: string;
    auto_pct: string;
    archetype: string | null;
    computed_at: Date;
  }>(
    `SELECT
       atsc.attempt_id,
       u.name  AS candidate_name,
       u.email AS candidate_email,
       atsc.auto_pct::text,
       atsc.archetype,
       atsc.computed_at
     FROM attempt_scores atsc
     JOIN attempts a  ON a.id  = atsc.attempt_id
     JOIN users    u  ON u.id  = a.user_id
     WHERE a.assessment_id = $1
       AND ${TENANT_VISIBLE_ATTEMPT_SQL}
     ORDER BY atsc.auto_pct DESC
     LIMIT $2`,
    [assessmentId, opts.topN],
  );

  return res.rows.map((r, idx) => ({
    rank: idx + 1,
    attempt_id: r.attempt_id,
    candidate_name: opts.anonymize ? null : r.candidate_name,
    candidate_email: opts.anonymize ? null : r.candidate_email,
    auto_pct: parseFloat(r.auto_pct),
    archetype: (r.archetype as import("./types.js").ArchetypeLabel | null) ?? null,
    computed_at: r.computed_at.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// getIndividualScores — all attempt scores for a given user across assessments
// ---------------------------------------------------------------------------

export async function getIndividualScores(
  client: PoolClient,
  userId: string,
): Promise<IndividualReport | null> {
  // users is RLS-scoped by withTenant; a missing row = unknown user in this tenant.
  const u = await client.query<{ email: string; name: string | null }>(
    `SELECT email, name FROM users WHERE id = $1`,
    [userId],
  );
  if (u.rows.length === 0) return null;

  const res = await client.query<{
    attempt_id: string;
    assessment_id: string;
    assessment_name: string;
    level_label: string | null;
    submitted_at: Date | null;
    auto_pct: string;
    archetype: string | null;
    archetype_signals: unknown | null;
    computed_at: Date;
  }>(
    `SELECT
       atsc.attempt_id,
       a.assessment_id,
       asmnt.name AS assessment_name,
       l.label AS level_label,
       a.submitted_at,
       atsc.auto_pct::text,
       atsc.archetype,
       atsc.archetype_signals,
       atsc.computed_at
     FROM attempt_scores atsc
     JOIN attempts   a     ON a.id    = atsc.attempt_id
     JOIN assessments asmnt ON asmnt.id = a.assessment_id
     LEFT JOIN levels l    ON l.id    = asmnt.level_id
     WHERE a.user_id = $1
       AND ${TENANT_VISIBLE_ATTEMPT_SQL}
     ORDER BY atsc.computed_at DESC`,
    [userId],
  );

  const attempts = res.rows.map((r) => {
    const auto_pct = parseFloat(r.auto_pct);
    // ponytail: validate archetype_signals at return boundary; fail-safe to null
    const signalsResult = ArchetypeSignalsSchema.safeParse(
      r.archetype_signals,
    );
    const validatedSignals = signalsResult.success ? signalsResult.data : null;
    if (!signalsResult.success && r.archetype_signals != null) {
      logger.warn(
        {
          attempt_id: r.attempt_id,
          issues: signalsResult.error.issues,
        },
        "archetype_signals validation failed; setting to null",
      );
    }
    return {
      attempt_id: r.attempt_id,
      assessment_id: r.assessment_id,
      assessment_name: r.assessment_name,
      level_label: r.level_label ?? "",
      submitted_at: (r.submitted_at ?? r.computed_at).toISOString(),
      auto_pct,
      // 0/25/50/75/100 bands -> 0..4
      band: Math.min(4, Math.max(0, Math.round(auto_pct / 25))),
      archetype:
        (r.archetype as import("./types.js").ArchetypeLabel | null) ?? null,
      archetype_signals: validatedSignals,
      computed_at: r.computed_at.toISOString(),
    };
  });

  return {
    user_id: userId,
    email: u.rows[0]!.email,
    name: u.rows[0]!.name,
    total_attempts: attempts.length,
    latest_band: attempts[0]?.band ?? null, // rows are newest-first
    attempts,
  };
}

// ---------------------------------------------------------------------------
// Internal mapper — AttemptScoreDbRow → AttemptScore
// ---------------------------------------------------------------------------

function mapAttemptScoreRow(r: AttemptScoreDbRow): AttemptScore {
  // ponytail: validate archetype_signals at return boundary; fail-safe to null
  const signalsResult = ArchetypeSignalsSchema.safeParse(
    r.archetype_signals,
  );
  const validatedSignals = signalsResult.success ? signalsResult.data : null;
  if (!signalsResult.success && r.archetype_signals != null) {
    logger.warn(
      {
        attempt_id: r.attempt_id,
        issues: signalsResult.error.issues,
      },
      "archetype_signals validation failed; setting to null",
    );
  }
  return {
    attempt_id: r.attempt_id,
    tenant_id: r.tenant_id,
    total_earned: parseFloat(r.total_earned),
    total_max: parseFloat(r.total_max),
    auto_pct: parseFloat(r.auto_pct),
    pending_review: Boolean(r.pending_review),
    archetype:
      (r.archetype as import("./types.js").ArchetypeLabel | null) ?? null,
    archetype_signals: validatedSignals,
    computed_at:
      r.computed_at instanceof Date
        ? r.computed_at.toISOString()
        : String(r.computed_at),
  };
}

// ---------------------------------------------------------------------------
// getSectionScoresForAttempt — per-section earned/max for sectioned assessments
//
// Same "effective grading" rule as getGradingsForAttempt (latest graded_at, an
// admin_override wins ties); the section comes from attempt_questions.section_index
// and the name from assessments.settings.sections. [] when the assessment has no
// sections. CALLERS decide visibility (never call for an unreleased score).
// ---------------------------------------------------------------------------

export interface SectionScore {
  index: number;
  name: string;
  earned: number;
  max: number;
}

export async function getSectionScoresForAttempt(
  client: PoolClient,
  attemptId: string,
): Promise<SectionScore[]> {
  const res = await client.query<{ idx: number; name: string | null; earned: string; max: string }>(
    `WITH eff AS (
       SELECT DISTINCT ON (g.question_id) g.question_id, g.score_earned, g.score_max
         FROM gradings g
        WHERE g.attempt_id = $1
        ORDER BY g.question_id, g.graded_at DESC, (g.grader = 'admin_override') DESC)
     SELECT aq.section_index AS idx,
            (a2.settings->'sections'->aq.section_index->>'name') AS name,
            COALESCE(SUM(eff.score_earned), 0)::text AS earned,
            COALESCE(SUM(eff.score_max), 0)::text AS max
       FROM attempt_questions aq
       JOIN attempts at ON at.id = aq.attempt_id
       JOIN assessments a2 ON a2.id = at.assessment_id
       LEFT JOIN eff ON eff.question_id = aq.question_id
      WHERE aq.attempt_id = $1 AND aq.section_index IS NOT NULL
      GROUP BY aq.section_index, a2.settings
      ORDER BY aq.section_index`,
    [attemptId],
  );
  return res.rows.map((r) => ({
    index: r.idx,
    name: r.name ?? `Section ${r.idx + 1}`,
    earned: parseFloat(r.earned),
    max: parseFloat(r.max),
  }));
}
