/**
 * E2 Part 2 — grading quality per prompt version, from admin overrides.
 *
 * READ-ONLY, cross-tenant, super admin only (route guard): one aggregate row per
 * ORIGINAL prompt_version_sha over a window of `days`:
 *   ai_grades                AI rows (grader='ai') created in the window
 *   overrides                admin overrides of an AI row made in the window
 *   override_rate            overrides / ai_grades (null when no AI rows)
 *   mean_abs_band_delta      mean |override band - original band|
 *   mean_abs_score_delta_pct mean |override score - original score| / score_max * 100
 * Reads the grading_override_quality view (migration 0140) through the same
 * READ ONLY assessiq_system transaction as the evaluation queue. No candidate data,
 * no AI, no writes.
 */

import { withSystemReadOnly } from "./super-evaluations.js";

export interface GradingQualityRow {
  prompt_version_sha: string;
  ai_grades: number;
  overrides: number;
  override_rate: number | null;
  mean_abs_band_delta: number | null;
  mean_abs_score_delta_pct: number | null;
}

const round = (v: string | null, dp: number): number | null =>
  v === null ? null : Math.round(Number(v) * 10 ** dp) / 10 ** dp;

export async function handleSuperGradingQuality(input: {
  days: number;
}): Promise<{ days: number; items: GradingQualityRow[] }> {
  const { days } = input;
  const items = await withSystemReadOnly(async (client) => {
    const res = await client.query<{
      sha: string;
      ai_grades: number;
      overrides: number;
      band_delta: string | null;
      score_delta_pct: string | null;
    }>(
      `WITH ai AS (
         SELECT prompt_version_sha AS sha, COUNT(*)::int AS n
           FROM gradings
          WHERE grader = 'ai' AND graded_at >= now() - $1::int * interval '1 day'
          GROUP BY 1
       ), ov AS (
         SELECT original_prompt_version_sha AS sha,
                COUNT(*)::int AS n,
                AVG(ABS(override_reasoning_band - original_reasoning_band)) AS band_delta,
                AVG(ABS(override_score_earned - original_score_earned) / NULLIF(score_max, 0) * 100) AS score_delta_pct
           FROM grading_override_quality
          WHERE override_created_at >= now() - $1::int * interval '1 day'
          GROUP BY 1
       )
       SELECT COALESCE(ai.sha, ov.sha) AS sha,
              COALESCE(ai.n, 0) AS ai_grades,
              COALESCE(ov.n, 0) AS overrides,
              ov.band_delta::text AS band_delta,
              ov.score_delta_pct::text AS score_delta_pct
         FROM ai FULL JOIN ov ON ai.sha = ov.sha
        ORDER BY 1`,
      [days],
    );
    return res.rows;
  });
  return {
    days,
    items: items.map((r) => ({
      prompt_version_sha: r.sha,
      ai_grades: r.ai_grades,
      overrides: r.overrides,
      override_rate: r.ai_grades > 0 ? Math.round((r.overrides / r.ai_grades) * 1000) / 1000 : null,
      mean_abs_band_delta: round(r.band_delta, 2),
      mean_abs_score_delta_pct: round(r.score_delta_pct, 1),
    })),
  };
}
