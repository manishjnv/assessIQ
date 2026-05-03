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
import type {
  AttemptScore,
  CohortStats,
  CohortPercentiles,
  LeaderboardRow,
  IndividualScore,
} from "./types.js";

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
       q.type  AS question_type,
       g.score_earned::text,
       g.score_max::text,
       g.status,
       g.reasoning_band,
       g.error_class
     FROM gradings g
     JOIN questions q ON q.id = g.question_id
     WHERE g.attempt_id = $1
     ORDER BY g.question_id, g.graded_at DESC`,
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
     WHERE a.assessment_id = $1`,
    [assessmentId],
  );

  const archetypeRes = await client.query<{ archetype: string; cnt: string }>(
    `SELECT atsc.archetype, COUNT(*)::text AS cnt
     FROM attempt_scores atsc
     JOIN attempts a ON a.id = atsc.attempt_id
     WHERE a.assessment_id = $1
       AND atsc.archetype IS NOT NULL
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
): Promise<IndividualScore[]> {
  const res = await client.query<{
    attempt_id: string;
    assessment_id: string;
    assessment_name: string;
    auto_pct: string;
    archetype: string | null;
    computed_at: Date;
  }>(
    `SELECT
       atsc.attempt_id,
       a.assessment_id,
       asmnt.name AS assessment_name,
       atsc.auto_pct::text,
       atsc.archetype,
       atsc.computed_at
     FROM attempt_scores atsc
     JOIN attempts   a     ON a.id    = atsc.attempt_id
     JOIN assessments asmnt ON asmnt.id = a.assessment_id
     WHERE a.user_id = $1
     ORDER BY atsc.computed_at DESC`,
    [userId],
  );

  return res.rows.map((r) => ({
    attempt_id: r.attempt_id,
    assessment_id: r.assessment_id,
    assessment_name: r.assessment_name,
    auto_pct: parseFloat(r.auto_pct),
    archetype:
      (r.archetype as import("./types.js").ArchetypeLabel | null) ?? null,
    computed_at: r.computed_at.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Internal mapper — AttemptScoreDbRow → AttemptScore
// ---------------------------------------------------------------------------

function mapAttemptScoreRow(r: AttemptScoreDbRow): AttemptScore {
  return {
    attempt_id: r.attempt_id,
    tenant_id: r.tenant_id,
    total_earned: parseFloat(r.total_earned),
    total_max: parseFloat(r.total_max),
    auto_pct: parseFloat(r.auto_pct),
    pending_review: Boolean(r.pending_review),
    archetype:
      (r.archetype as import("./types.js").ArchetypeLabel | null) ?? null,
    archetype_signals:
      r.archetype_signals != null
        ? (r.archetype_signals as import("./types.js").ArchetypeSignals)
        : null,
    computed_at:
      r.computed_at instanceof Date
        ? r.computed_at.toISOString()
        : String(r.computed_at),
  };
}
