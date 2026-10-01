// AssessIQ — modules/09-scoring release core.
//
// SP2 (2026-10-01). ONE place that publishes a finished result to the candidate
// (attempts.status 'graded' -> 'released'). Every release path calls this inside
// its own withTenant transaction: the manual admin Release, the bulk "release
// all ready", and the worker auto-release sweep. Callers send the result email
// AFTER their transaction commits (module 13 sendResultReleasedEmail) — there is
// deliberately no email here.
//
// Invariants (build spec §0):
//   3. An erased candidate (users.erased_at) is never released — checked here,
//      server-side, in the same tx as the flip (fail-closed 422).
//   2. Exactly one audit row (grading.released) in the same tx, actor kind =
//      the real actor ('user' admin, or 'system' for the auto sweep).
//   4. The certificate is issued ONLY here (publish-to-student), upgrade-only,
//      inside a SAVEPOINT: any certificate error rolls back to the savepoint and
//      the release itself still commits.
//   9. A candidate sees a result only after release; release requires a
//      COMPLETE result: status 'graded' AND evaluation_released_at set (the
//      tenant may publish it — migration 0113) AND no effective grade still
//      flagged review_needed (a re-run can add one after finalisation).
//  10. An AUTO release re-checks the tenant's mode inside this tx (FOR SHARE on
//      tenant_settings): still 'auto', and the result became ready at or after
//      result_release_auto_since. The sweep's candidate read can be stale by the
//      time it gets here (admin switched back to manual in between).
//
// No AI call, no model, no network.

import type { PoolClient } from "pg";
import { AppError, streamLogger } from "@assessiq/core";
import { auditInTx } from "@assessiq/audit-log";
import { issueCertificateOnRelease } from "@assessiq/certification";

const log = streamLogger("grading");

// Wire codes. The erased code/message are 07's long-standing release contract
// (AI_GRADING_ERROR_CODES.ATTEMPT_NOT_RELEASABLE_ERASED) — duplicated as string
// literals because 09 must not import 07.
export const RELEASE_ERROR_CODES = {
  ATTEMPT_NOT_FOUND: "AIG_ATTEMPT_NOT_FOUND",
  ATTEMPT_NOT_RELEASABLE_ERASED: "AIG_ATTEMPT_NOT_RELEASABLE_ERASED",
  RESULT_NOT_READY: "RESULT_NOT_READY",
} as const;

export type ReleaseActor =
  | { kind: "user"; userId: string }
  | { kind: "system" };

export interface ReleaseAttemptInput {
  tenantId: string;
  attemptId: string;
  actor: ReleaseActor;
  /**
   * What caused the release, recorded in the audit row. Defaults from the actor
   * (user -> 'manual', system -> 'auto'). The auto-release sweep passes 'auto'
   * explicitly even when it attributes the release to the user who released the
   * evaluation. An 'auto' release is additionally gated on the tenant's CURRENT
   * result_release_mode (see the auto-release gate below); 'manual' is not.
   */
  trigger?: "manual" | "auto";
}

/**
 * Publish a finished result. Must run inside withTenant (RLS) on the caller's
 * open transaction. Throws AppError: 404 attempt not found, 422 erased
 * candidate, 409 RESULT_NOT_READY (not 'graded', evaluation not released,
 * already released, a grade still flagged for review, or — for an 'auto'
 * release — the tenant is no longer in auto mode / the result predates the
 * switch to auto; the caller treats this as "skip").
 */
export async function releaseAttemptInTx(
  client: PoolClient,
  input: ReleaseAttemptInput,
): Promise<{ released: true }> {
  const { tenantId, attemptId, actor } = input;
  const trigger = input.trigger ?? (actor.kind === "system" ? "auto" : "manual");

  // Lock the attempt row: serialises concurrent releases (admin click vs sweep)
  // and an override (07 takes the same lock), so the flip below is exactly-once.
  const res = await client.query<{
    status: string;
    evaluation_released_at: Date | null;
    erased_at: Date | null;
  }>(
    `SELECT a.status, a.evaluation_released_at, u.erased_at
       FROM attempts a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.id = $1
      FOR UPDATE OF a`,
    [attemptId],
  );
  const row = res.rows[0];
  if (row === undefined) {
    throw new AppError(
      `Attempt ${attemptId} not found`,
      RELEASE_ERROR_CODES.ATTEMPT_NOT_FOUND,
      404,
    );
  }

  // DPDP/GDPR erasure gate: releasing would email a tombstone address and mint
  // a fresh certificate for a "forgotten" candidate. Fail-closed.
  if (row.erased_at !== null) {
    throw new AppError(
      `Attempt ${attemptId} belongs to an erased candidate — results cannot be released`,
      RELEASE_ERROR_CODES.ATTEMPT_NOT_RELEASABLE_ERASED,
      422,
    );
  }

  if (row.status !== "graded" || row.evaluation_released_at === null) {
    throw new AppError(
      `Result is not ready to publish (status '${row.status}'${
        row.status === "graded" ? ", evaluation not released to the tenant" : ""
      })`,
      RELEASE_ERROR_CODES.RESULT_NOT_READY,
      409,
    );
  }

  // Auto-release gate. The sweep chooses its candidates in an earlier, separate
  // read, so by the time this tx holds the attempt lock the admin may have
  // switched the tenant back to manual (or manual -> auto -> manual -> auto,
  // moving result_release_auto_since past this result). Re-check the setting HERE
  // under a FOR SHARE lock on the tenant_settings row: a concurrent switch (02
  // updateResultReleaseMode takes FOR UPDATE) has either committed already and is
  // seen now, or waits until this tx commits, so "publish" and "switch to manual"
  // can never both win. Lock order: attempt row, then tenant_settings row (the
  // switch only ever locks tenant_settings). The timestamp comparison stays in SQL
  // so it is exact to the microsecond. A manual release (admin click / bulk) is an
  // explicit decision and skips this gate.
  if (trigger === "auto") {
    const gate = await client.query<{ ok: boolean | null }>(
      `SELECT (ts.result_release_mode = 'auto'
               AND ts.result_release_auto_since IS NOT NULL
               AND a.evaluation_released_at >= ts.result_release_auto_since) AS ok
         FROM tenant_settings ts
         JOIN attempts a ON a.id = $1
        WHERE ts.tenant_id = $2
          FOR SHARE OF ts`,
      [attemptId, tenantId],
    );
    if (gate.rows[0]?.ok !== true) {
      throw new AppError(
        "Result is not eligible for automatic release (the tenant is not in auto-release mode, or the result was ready before auto-release was switched on)",
        RELEASE_ERROR_CODES.RESULT_NOT_READY,
        409,
      );
    }
  }

  // P1 re-check: finalize (finalize.ts) guarantees no flagged grade when an attempt
  // becomes 'graded', but a later re-run / accept (07) can add a NEWER review_needed
  // row to a graded-but-unpublished attempt (e.g. the AI failed on the re-run). A
  // flagged grade is provisional, so it must never be published: same effective-grade
  // rule as finalize (newest row per question, admin_override wins a timestamp tie).
  const flagged = await client.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM (
         SELECT DISTINCT ON (g.question_id) g.status
           FROM gradings g
          WHERE g.attempt_id = $1
          ORDER BY g.question_id, g.graded_at DESC, (g.grader = 'admin_override') DESC
       ) e
      WHERE e.status = 'review_needed'`,
    [attemptId],
  );
  if ((flagged.rows[0]?.n ?? 0) > 0) {
    throw new AppError(
      "Result has grades that still need review — resolve them before publishing",
      RELEASE_ERROR_CODES.RESULT_NOT_READY,
      409,
    );
  }

  await client.query(`UPDATE attempts SET status = 'released' WHERE id = $1`, [attemptId]);

  await auditInTx(client, {
    action: "grading.released",
    tenantId,
    entityType: "attempt",
    entityId: attemptId,
    ...(actor.kind === "user"
      ? { actorKind: "user" as const, actorUserId: actor.userId }
      : { actorKind: "system" as const }),
    before: { attempt_status: "graded" },
    after: { attempt_status: "released", trigger },
  });

  // Certificate: best effort, upgrade-only, in a SAVEPOINT so a failure (missing
  // signing secret, DB error, ...) rolls back ONLY the certificate work and the
  // release still commits. A raw .catch() would not be enough: a failed SQL
  // statement aborts the whole transaction until we roll back to the savepoint.
  await client.query("SAVEPOINT release_cert");
  try {
    await issueCertificateOnRelease(client, {
      tenantId,
      attemptId,
      actorUserId: actor.kind === "user" ? actor.userId : null,
    });
    await client.query("RELEASE SAVEPOINT release_cert");
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT release_cert");
    log.warn(
      { attemptId, error: String(err) },
      "grading.release.cert_issuance_failed",
    );
  }

  return { released: true };
}
