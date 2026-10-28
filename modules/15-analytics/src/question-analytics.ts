// AssessIQ — modules/15-analytics/src/question-analytics.ts
//
// X6b — per-question analytics for ONE assessment (tenant admin, read-only, no AI).
// Live query, not the nightly question_stats_mv: the grain is assessment x question.
// Rules are the same as migration 0189 (question_stats_mv):
//   - effective grading = newest gradings row per (attempt, question), admin_override wins a tie
//   - correct = status 'correct' OR full marks; status review_needed is left out
//   - only tenant-visible attempts: 'released', or 'graded' with evaluation_released_at set
//     (RCA 2026-10 "released to the tenant")
// The "possibly bad question" flag is display only. It never changes marks or review state.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.

import { AppError } from '@assessiq/core';
import { withTenant } from '@assessiq/tenancy';

// All flag thresholds live here.
export const FLAG_MIN_ATTEMPTS = 20;
export const FLAG_LOW_SHARE = 0.2;
export const FLAG_HIGH_SHARE = 0.98;

const STEM_MAX = 120;

export interface QuestionAnalyticsRow {
  question_id: string;
  pack_id: string;
  /** 1-based order of the question in the assessment's question set (by creation time). */
  position: number;
  type: string;
  stem_preview: string;
  attempts: number;
  correct_count: number;
  share_correct: number | null;
  avg_time_seconds: number | null;
  distractors?: Array<{ option_index: number; count: number }>;
  possibly_bad: boolean;
  flag_reason: string | null;
}

/** Pure flag rule. Boundaries: 20 attempts counts; share 0.2 and 0.98 exactly do not flag. */
export function flagQuestion(
  attempts: number,
  share: number | null,
): { possibly_bad: boolean; flag_reason: string | null } {
  if (share === null || attempts < FLAG_MIN_ATTEMPTS) return { possibly_bad: false, flag_reason: null };
  const pct = Math.round(share * 100);
  if (share < FLAG_LOW_SHARE) {
    return { possibly_bad: true, flag_reason: `Only ${pct}% answered correctly. The question may be too hard, unclear or wrongly keyed.` };
  }
  if (share > FLAG_HIGH_SHARE) {
    return { possibly_bad: true, flag_reason: `${pct}% answered correctly. The question may be too easy or give the answer away.` };
  }
  return { possibly_bad: false, flag_reason: null };
}

interface QRow { question_id: string; pack_id: string; type: string; stem: string | null }
interface GRow {
  question_id: string;
  selected: number | null;
  n: string;
  correct: string;
  time_sum: string;
  time_n: string;
}

export async function getAssessmentQuestionAnalytics(args: {
  tenantId: string;
  assessmentId: string;
}): Promise<QuestionAnalyticsRow[]> {
  const { tenantId, assessmentId } = args;
  return withTenant(tenantId, async (client) => {
    const own = await client.query(
      'SELECT 1 FROM assessments WHERE id = $1 AND tenant_id = $2',
      [assessmentId, tenantId],
    );
    if (own.rows.length === 0) throw new AppError('assessment not found', 'ASSESSMENT_NOT_FOUND', 404);

    // Questions that were served in this assessment (any attempt), in set order.
    const qs = await client.query<QRow>(
      `SELECT q.id AS question_id, q.pack_id, q.type,
              COALESCE(q.content->>'question', q.content->>'prompt', q.content->>'stem', '') AS stem
         FROM questions q
         JOIN question_packs p ON p.id = q.pack_id AND p.tenant_id = $1
        WHERE q.id IN (
              SELECT aq.question_id
                FROM attempt_questions aq
                JOIN attempts a ON a.id = aq.attempt_id
               WHERE a.tenant_id = $1 AND a.assessment_id = $2)
        ORDER BY q.created_at, q.id`,
      [tenantId, assessmentId],
    );

    // One small group per (question, selected MCQ option). Non-index answers group under NULL.
    const gs = await client.query<GRow>(
      `WITH eff AS (
         SELECT DISTINCT ON (g.attempt_id, g.question_id)
                g.attempt_id, g.question_id, g.status, g.score_earned, g.score_max
           FROM gradings g
           JOIN attempts a ON a.id = g.attempt_id
          WHERE a.tenant_id = $1 AND a.assessment_id = $2 AND g.tenant_id = $1
          ORDER BY g.attempt_id, g.question_id, g.graded_at DESC, (g.grader = 'admin_override') DESC, g.id DESC
       ), graded AS (
         SELECT e.question_id,
                (e.status = 'correct' OR (e.score_earned = e.score_max AND e.score_max > 0)) AS is_correct,
                aa.time_spent_seconds,
                CASE
                  WHEN jsonb_typeof(aa.answer) = 'number' AND (aa.answer #>> '{}') ~ '^[0-9]{1,4}$'
                    THEN (aa.answer #>> '{}')::int
                  WHEN jsonb_typeof(aa.answer) = 'object' AND jsonb_typeof(aa.answer->'selected') = 'number'
                       AND (aa.answer->>'selected') ~ '^[0-9]{1,4}$'
                    THEN (aa.answer->>'selected')::int
                END AS selected
           FROM eff e
           JOIN attempts a ON a.id = e.attempt_id
           JOIN attempt_scores ats ON ats.attempt_id = a.id AND ats.tenant_id = $1
           LEFT JOIN attempt_answers aa ON aa.attempt_id = e.attempt_id AND aa.question_id = e.question_id
          WHERE e.status <> 'review_needed'
            AND a.tenant_id = $1 AND a.assessment_id = $2
            AND (a.status = 'released' OR (a.status = 'graded' AND a.evaluation_released_at IS NOT NULL))
       )
       SELECT question_id, selected,
              count(*)::text AS n,
              count(*) FILTER (WHERE is_correct)::text AS correct,
              COALESCE(sum(time_spent_seconds), 0)::text AS time_sum,
              count(time_spent_seconds)::text AS time_n
         FROM graded
        GROUP BY question_id, selected`,
      [tenantId, assessmentId],
    );

    const byQ = new Map<string, GRow[]>();
    for (const g of gs.rows) {
      const list = byQ.get(g.question_id);
      if (list) list.push(g); else byQ.set(g.question_id, [g]);
    }

    return qs.rows.map((q, i): QuestionAnalyticsRow => {
      const groups = byQ.get(q.question_id) ?? [];
      const attempts = groups.reduce((s, g) => s + Number(g.n), 0);
      const correct = groups.reduce((s, g) => s + Number(g.correct), 0);
      const timeSum = groups.reduce((s, g) => s + Number(g.time_sum), 0);
      const timeN = groups.reduce((s, g) => s + Number(g.time_n), 0);
      const share = attempts === 0 ? null : correct / attempts;
      const stem = (q.stem ?? '').replace(/\s+/g, ' ').trim();
      const row: QuestionAnalyticsRow = {
        question_id: q.question_id,
        pack_id: q.pack_id,
        position: i + 1,
        type: q.type,
        stem_preview: stem.length > STEM_MAX ? `${stem.slice(0, STEM_MAX - 1)}…` : stem,
        attempts,
        correct_count: correct,
        share_correct: share,
        avg_time_seconds: timeN === 0 ? null : Math.round((timeSum / timeN) * 10) / 10,
        ...flagQuestion(attempts, share),
      };
      if (q.type === 'mcq') {
        const picks = groups
          .filter((g) => g.selected !== null)
          .map((g) => ({ option_index: Number(g.selected), count: Number(g.n) }))
          .sort((a, b) => a.option_index - b.option_index);
        if (picks.length > 0) row.distractors = picks;
      }
      return row;
    });
  });
}
