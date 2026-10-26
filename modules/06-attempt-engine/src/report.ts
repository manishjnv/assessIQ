// EXP-28: "Report a problem" on a question. A candidate tells the platform that a question looks wrong or unclear.
// Feeds the EXP-12 review queue (module 04): the queue shows a count. A report never changes a review state,
// a mark or the attempt. Allowed while the attempt is running and after it ends (a result can show a wrong key).
import { AuthzError, NotFoundError, ValidationError } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import * as repo from "./repository.js";
import { AE_ERROR_CODES } from "./types.js";

export const REPORT_REASONS = ["wrong_answer", "unclear", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
/** Abuse limit: reports per attempt. A change to an existing report does not count again. */
export const MAX_REPORTS_PER_ATTEMPT = 20;
export const MAX_REPORT_NOTE_CHARS = 500;

export interface ReportQuestionInput {
  attemptId: string;
  questionId: string;
  reason: ReportReason;
  note?: string | null;
}

export async function reportQuestion(tenantId: string, userId: string, input: ReportQuestionInput): Promise<{ reported: true }> {
  if (!REPORT_REASONS.includes(input.reason)) {
    throw new ValidationError("reason is not valid", { details: { code: AE_ERROR_CODES.INVALID_PARAM, param: "reason" } });
  }
  const note = input.note === undefined || input.note === null || input.note.trim() === "" ? null : input.note.trim();
  if (note !== null && note.length > MAX_REPORT_NOTE_CHARS) {
    throw new ValidationError(`note must be at most ${MAX_REPORT_NOTE_CHARS} characters`, { details: { code: AE_ERROR_CODES.INVALID_PARAM, param: "note" } });
  }
  return withTenant(tenantId, async (client) => {
    const attempt = await repo.findAttemptById(client, input.attemptId);
    if (attempt === null) {
      throw new NotFoundError(`Attempt not found: ${input.attemptId}`, { details: { code: AE_ERROR_CODES.ATTEMPT_NOT_FOUND } });
    }
    if (attempt.user_id !== userId) {
      throw new AuthzError(`Attempt ${attempt.id} not owned by user ${userId}`, { details: { code: AE_ERROR_CODES.NOT_OWNED_BY_USER } });
    }
    const aq = await repo.findAttemptQuestion(client, input.attemptId, input.questionId);
    if (aq === null) {
      throw new NotFoundError(`Question ${input.questionId} not in attempt ${input.attemptId}`, { details: { code: AE_ERROR_CODES.UNKNOWN_QUESTION } });
    }
    const count = await client.query<{ n: string; mine: boolean | null }>(
      `SELECT count(*) AS n, bool_or(question_id = $2) AS mine FROM question_reports WHERE attempt_id = $1`,
      [input.attemptId, input.questionId],
    );
    if (parseInt(count.rows[0]?.n ?? "0", 10) >= MAX_REPORTS_PER_ATTEMPT && count.rows[0]?.mine !== true) {
      throw new ValidationError("You have reported the most questions allowed for one test.", { details: { code: AE_ERROR_CODES.INVALID_PARAM, param: "question_id" } });
    }
    await client.query(
      `INSERT INTO question_reports (tenant_id, attempt_id, question_id, user_id, reason, note)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (attempt_id, question_id) DO UPDATE SET reason = EXCLUDED.reason, note = EXCLUDED.note, updated_at = now()`,
      [tenantId, input.attemptId, input.questionId, userId, input.reason, note],
    );
    return { reported: true as const };
  });
}
