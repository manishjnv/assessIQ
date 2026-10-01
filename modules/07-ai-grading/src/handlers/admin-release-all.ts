/**
 * Handler: POST /admin/assessments/:assessmentId/release-all
 *
 * SP2 / A9 (2026-10-01) — "Release all ready": publish every finished result of
 * one assessment in a single click.
 *
 * Ready = status 'graded' AND evaluation_released_at set (the result is complete
 * and the tenant may publish it) AND a non-erased candidate (invariant 3:
 * erased candidates are never released or emailed — they are not even listed).
 *
 * Each attempt is released in its OWN transaction through module 09's
 * releaseAttemptInTx, so one bad attempt never rolls back the others and every
 * release has its own grading.released audit row (trigger 'manual', actor = the
 * admin). Emails are sent AFTER each commit, best-effort (sequential — a campus
 * cohort is a few hundred). A race (another click or the sweep released it first)
 * surfaces as a skipped entry with code RESULT_NOT_READY, never an error.
 *
 * No AI anywhere on this path.
 */

import { AppError, NotFoundError, streamLogger } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { releaseAttemptInTx } from "@assessiq/scoring";
import { sendReleaseEmailSafely } from "./admin-claim-release.js";

const log = streamLogger("grading");

export interface HandleAdminReleaseAllInput {
  tenantId: string;
  userId: string;
  assessmentId: string;
}

export interface HandleAdminReleaseAllOutput {
  /** Attempt ids published by this call (oldest evaluation first). */
  released: string[];
  /** Attempts that were ready when listed but could not be released, with the reason code. */
  skipped: Array<{ id: string; code: string }>;
}

export async function handleAdminReleaseAll(
  input: HandleAdminReleaseAllInput,
): Promise<HandleAdminReleaseAllOutput> {
  const { tenantId, userId, assessmentId } = input;

  // 1. Resolve the ready set (RLS hides other tenants' assessments -> 404).
  const ready = await withTenant(tenantId, async (client) => {
    const exists = await client.query(`SELECT 1 FROM assessments WHERE id = $1`, [assessmentId]);
    if ((exists.rowCount ?? 0) === 0) {
      throw new NotFoundError(`Assessment not found: ${assessmentId}`);
    }
    const res = await client.query<{ id: string }>(
      `SELECT a.id
         FROM attempts a
         JOIN users u ON u.id = a.user_id
        WHERE a.assessment_id = $1
          AND a.status = 'graded'
          AND a.evaluation_released_at IS NOT NULL
          AND u.erased_at IS NULL
        ORDER BY a.evaluation_released_at ASC, a.id ASC`,
      [assessmentId],
    );
    return res.rows.map((r) => r.id);
  });

  // 2. One transaction per attempt.
  const released: string[] = [];
  const skipped: Array<{ id: string; code: string }> = [];
  for (const attemptId of ready) {
    try {
      await withTenant(tenantId, (client) =>
        releaseAttemptInTx(client, {
          tenantId,
          attemptId,
          actor: { kind: "user", userId },
          trigger: "manual",
        }),
      );
    } catch (err) {
      if (err instanceof AppError) {
        skipped.push({ id: attemptId, code: err.code });
      } else {
        log.error({ attemptId, err }, "grading.release_all.unexpected_error");
        skipped.push({ id: attemptId, code: "RELEASE_FAILED" });
      }
      continue;
    }
    released.push(attemptId);
    await sendReleaseEmailSafely(tenantId, attemptId);
  }

  log.info(
    { assessmentId, ready: ready.length, released: released.length, skipped: skipped.length },
    "grading.release_all.complete",
  );

  return { released, skipped };
}
