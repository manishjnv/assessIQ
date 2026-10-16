/**
 * P4 shared helpers for the tenant AI cap (tenant_settings.ai_grading_scope).
 * Used by handleAdminGrade and handleAdminRerun so neither is a second AI path
 * for a tenant on 'none'. Imports no runtime.
 */
import type { PoolClient } from "pg";
import type { GradingProposal } from "../types.js";

export type AiGradingScope = "written" | "none";

/** Read the scope in the caller's tx. No row = default 'written'. */
export async function readAiGradingScope(client: PoolClient, tenantId: string): Promise<AiGradingScope> {
  const sc = await client.query<{ ai_grading_scope: string }>(
    `SELECT ai_grading_scope FROM tenant_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  return sc.rows[0]?.ai_grading_scope === "none" ? "none" : "written";
}

/** Placeholder for a question no AI may grade (scope 'none'); a human scores it. */
export function manualPlaceholder(attemptId: string, questionId: string, points: number): GradingProposal {
  return {
    attempt_id: attemptId,
    question_id: questionId,
    anchors: [],
    band: {
      reasoning_band: 0,
      ai_justification: "AI grading is off for this organisation; score manually.",
      error_class: null,
      needs_escalation: false,
    },
    score_earned: 0,
    score_max: points,
    prompt_version_sha: "error:no-sha",
    prompt_version_label: "manual",
    model: "none",
    escalation_chosen_stage: "manual",
    generated_at: new Date().toISOString(),
  };
}
