/**
 * Handler: POST /admin/attempts/:attemptId/send-back   (tenant admin)
 *
 * Phase II SP10 (2026-10-01) — "send back for re-evaluation". The platform
 * evaluator (super admin) released a finished evaluation to the tenant; the tenant
 * admin disagrees and returns it to the platform queue with a note.
 *
 * Effect (one tx, attempt row locked):
 *   evaluation_released_at / _by -> NULL   (the tenant can no longer see grades or
 *                                           publish it; it re-enters the platform queue)
 *   evaluation_note              -> the tenant's note
 *   evaluation_sent_back_at      -> now()
 *   attempts.status              UNCHANGED ('graded') — so there is NO re-billing:
 *                                billing runs only on the status flip in module 09
 *                                finalizeAttemptIfComplete, which does not match a
 *                                'graded' attempt. Grades already written stay as they
 *                                are; the platform evaluator re-evaluates via override /
 *                                manual score / re-run, then releases to the tenant again.
 *
 * Only valid when status 'graded' AND evaluation_released_at IS NOT NULL (the
 * evaluation is with the tenant, unpublished). A published result is final.
 *
 * Audit: one grading.sent_back row in the same tx. PII policy (same as override):
 * the note is free text and may contain candidate or HR detail — it lives ONLY on
 * attempts.evaluation_note, never in the audit_log payload.
 *
 * No AI call anywhere on this path.
 */

import { AppError, streamLogger } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import { AI_GRADING_ERROR_CODES } from "../types.js";

const log = streamLogger("grading");

export interface HandleAdminSendBackInput {
  tenantId: string;
  userId: string;
  attemptId: string;
  /** 1..500 chars, validated by the route. */
  note: string;
}

export interface HandleAdminSendBackOutput {
  attempt_id: string;
  /** ISO timestamp. */
  evaluation_sent_back_at: string;
}

export async function handleAdminSendBack(
  input: HandleAdminSendBackInput,
): Promise<HandleAdminSendBackOutput> {
  const { tenantId, userId, attemptId, note } = input;

  const sentBackAt = await withTenant(tenantId, async (client) => {
    // Row lock: serialises against a concurrent publish (09 release takes the same
    // lock), override and the platform's release-to-tenant.
    const res = await client.query<{ status: string; evaluation_released_at: Date | null }>(
      `SELECT status, evaluation_released_at FROM attempts WHERE id = $1 FOR UPDATE`,
      [attemptId],
    );
    const row = res.rows[0];
    if (row === undefined) {
      throw new AppError(
        `Attempt ${attemptId} not found`,
        AI_GRADING_ERROR_CODES.ATTEMPT_NOT_FOUND,
        404,
      );
    }
    if (row.status === "released") {
      throw new AppError(
        "This result has already been published to the candidate and can no longer be changed",
        AI_GRADING_ERROR_CODES.RESULT_ALREADY_PUBLISHED,
        409,
      );
    }
    if (row.status !== "graded" || row.evaluation_released_at === null) {
      throw new AppError(
        "Only an evaluation that AssessIQ has released to you can be sent back",
        AI_GRADING_ERROR_CODES.EVALUATION_NOT_RELEASED,
        409,
      );
    }

    const upd = await client.query<{ evaluation_sent_back_at: Date }>(
      `UPDATE attempts
          SET evaluation_released_at  = NULL,
              evaluation_released_by  = NULL,
              evaluation_note         = $2,
              evaluation_sent_back_at = now()
        WHERE id = $1
        RETURNING evaluation_sent_back_at`,
      [attemptId, note],
    );

    await auditInTx(client, {
      action: "grading.sent_back",
      actorKind: "user",
      actorUserId: userId,
      tenantId,
      entityType: "attempt",
      entityId: attemptId,
      before: { evaluation_status: "ready_to_publish" },
      // The note is intentionally NOT here — see the PII policy in the file header.
      after: { evaluation_status: "awaiting_evaluation" },
    });

    return upd.rows[0]!.evaluation_sent_back_at;
  });

  log.info({ attemptId }, "grading.sent_back.complete");

  return { attempt_id: attemptId, evaluation_sent_back_at: sentBackAt.toISOString() };
}
