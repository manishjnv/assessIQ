/**
 * Handlers for the PLATFORM evaluation queue (Phase II SP9/SP10, 2026-10-01).
 *
 * Owner decision: AI evaluation is run only by the platform super admin (the owner
 * whose Claude subscription runs Claude Code on the VPS). Tenants review and publish.
 * These service-layer handlers (no Fastify req/reply) back the super-admin routes
 * (apps/api routes/admin-super-evaluations.ts → routes-super.ts):
 *
 *   handleSuperListEvaluations      GET  queue, ALL tenants, no candidate PII
 *   resolveEvaluationTenant         attempt id -> its tenant (system role) + active gate
 *   handleSuperGetEvaluation        GET  one attempt's review payload, blind (no PII)
 *   handleSuperReleaseToTenant      POST hand a finished evaluation to the tenant
 *   handleSuperReleaseToTenantBulk  POST same, many attempts, one tx each
 *
 * The AI itself (grade / rerun) and accept / override / manual-score are the existing
 * handlers (admin-grade / admin-rerun / admin-accept / admin-override /
 * admin-manual-score) called with tenantId = the ATTEMPT's tenant and userId = the
 * super admin. This file never spawns or imports the AI runtime (lint:ambient-ai):
 * the super admin's click on Evaluate stays the only AI trigger, sync + single-flight.
 *
 * Tenancy model (no new cross-tenant WRITE path):
 *   - The only RLS-bypassing code here is a READ-ONLY system-role transaction (queue
 *     list + attempt -> tenant lookup), same pattern as apps/api admin-super.ts and
 *     02-tenancy assertTenantActive. It never writes.
 *   - Every write (grades, release, audit) happens inside
 *     withTenant(<the attempt's tenant>) so RLS applies exactly as for that tenant's
 *     own admin; the audit row lands in THAT tenant's audit log with the super admin
 *     as actor.
 */

import type { PoolClient } from "pg";
import { AppError, streamLogger } from "@assessiq/core";
import { assertTenantActive, getPool, withTenant } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import { getAttemptProgress, listSuperEvaluationQueue } from "../repository.js";
import type { SuperEvaluationRow } from "../repository.js";
import { AI_GRADING_ERROR_CODES } from "../types.js";
import type { GradingsRow } from "../types.js";
import { loadAttemptReview } from "./admin-claim-release.js";
import type {
  AttemptAnswerRow,
  AttemptScoreSummary,
  FrozenQuestionRow,
} from "./admin-claim-release.js";

const log = streamLogger("grading");

// ---------------------------------------------------------------------------
// Read-only system-role transaction
// ---------------------------------------------------------------------------

/**
 * Run `fn` in a READ ONLY transaction as the assessiq_system (BYPASSRLS) role.
 * READ ONLY is enforced by Postgres, so nothing passed in here can write even by
 * mistake. Used only for the cross-tenant queue read and the attempt -> tenant
 * lookup, where there is no tenant context yet.
 */
async function withSystemReadOnly<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL ROLE assessiq_system");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // connection likely dead — surface the original error
    });
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export interface HandleSuperListEvaluationsOutput {
  items: SuperEvaluationRow[];
  counts: { pending: number; older_than_24h: number };
}

/** The platform evaluation queue across all tenants, oldest first, blind (no candidate PII). */
export async function handleSuperListEvaluations(
  input: { tenantId?: string } = {},
): Promise<HandleSuperListEvaluationsOutput> {
  return withSystemReadOnly((client) =>
    listSuperEvaluationQueue(client, input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
  );
}

// ---------------------------------------------------------------------------
// attempt -> tenant
// ---------------------------------------------------------------------------

/**
 * Resolve the tenant that owns `attemptId` and require it to be writable
 * (assertTenantActive: 'active' / 'provisioning'). Every per-attempt platform route
 * starts here, so a super admin session — which carries the PLATFORM tenant — can
 * operate on any tenant's attempt without that tenant ever being taken from the
 * request.
 *
 * Throws 404 AIG_ATTEMPT_NOT_FOUND for an unknown attempt id, and (from
 * assertTenantActive) 404 TENANT_NOT_FOUND / 409 TENANT_NOT_ACTIVE for a missing or
 * suspended / archived tenant. `attemptId` must already be a valid UUID (route-validated).
 */
export async function resolveEvaluationTenant(attemptId: string): Promise<string> {
  const tenantId = await withSystemReadOnly(async (client) => {
    const res = await client.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM attempts WHERE id = $1`,
      [attemptId],
    );
    return res.rows[0]?.tenant_id;
  });
  if (tenantId === undefined) {
    throw new AppError(
      `Attempt ${attemptId} not found`,
      AI_GRADING_ERROR_CODES.ATTEMPT_NOT_FOUND,
      404,
    );
  }
  await assertTenantActive(tenantId);
  return tenantId;
}

// ---------------------------------------------------------------------------
// Review payload (blind)
// ---------------------------------------------------------------------------

export interface HandleSuperGetEvaluationOutput {
  tenant_id: string;
  tenant_name: string;
  /** NO candidate name / email / erasure flag — the evaluator reviews blind. */
  attempt: {
    id: string;
    status: string;
    assessment_name: string;
    level_label: string;
    started_at: string | null;
    submitted_at: string | null;
  };
  answers: AttemptAnswerRow[];
  frozen_questions: FrozenQuestionRow[];
  gradings: GradingsRow[];
  /** The latest AI proposal batch (review cache); the platform evaluator's working state. */
  ai_proposals: unknown[] | null;
  grading_started_at: string | null;
  score: AttemptScoreSummary | null;
  evaluation_released_at: string | null;
  evaluation_note: string | null;
  evaluation_sent_back_at: string | null;
}

/**
 * GET payload for the platform evaluator: the same review data the tenant's attempt
 * page gets (questions, answers, rubric / expected answers, gradings, AI proposals,
 * score) with candidate identity removed, plus tenant + evaluation metadata.
 * READ-ONLY: no claim, no audit, no state change. `tenantId` must come from
 * resolveEvaluationTenant().
 */
export async function handleSuperGetEvaluation(input: {
  tenantId: string;
  attemptId: string;
}): Promise<HandleSuperGetEvaluationOutput> {
  const { tenantId, attemptId } = input;

  return withTenant(tenantId, async (client) => {
    const r = await loadAttemptReview(client, attemptId, "platform");
    const { row } = r;
    return {
      tenant_id: tenantId,
      tenant_name: row.tenant_name ?? "(unknown)",
      attempt: {
        id: attemptId,
        status: row.status,
        assessment_name: row.assessment_name ?? "(unknown)",
        level_label: row.level_label ?? "(unknown)",
        started_at: row.started_at?.toISOString() ?? null,
        submitted_at: row.submitted_at?.toISOString() ?? null,
      },
      answers: r.answers,
      frozen_questions: r.frozen_questions,
      gradings: r.gradings,
      ai_proposals: row.ai_proposals,
      grading_started_at: row.grading_started_at?.toISOString() ?? null,
      score: r.score,
      evaluation_released_at: row.evaluation_released_at?.toISOString() ?? null,
      evaluation_note: row.evaluation_note,
      evaluation_sent_back_at: row.evaluation_sent_back_at?.toISOString() ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Release to tenant
// ---------------------------------------------------------------------------

export interface HandleSuperReleaseToTenantOutput {
  attempt_id: string;
  /** ISO timestamp. */
  evaluation_released_at: string;
}

/**
 * Hand a finished evaluation to the tenant: set evaluation_released_at / _by and
 * clear any send-back marker, plus one grading.evaluation_released audit row (the
 * target tenant's audit log, super admin as actor), all in one tx.
 *
 * Refused (nothing written):
 *   404 AIG_ATTEMPT_NOT_FOUND                 not in this tenant
 *   422 AIG_ATTEMPT_NOT_RELEASABLE_ERASED     candidate erased (invariant 3: never listed / released)
 *   409 RESULT_ALREADY_PUBLISHED              status 'released' — a published result is final
 *   409 EVALUATION_NOT_COMPLETE               not 'graded', or a question has no effective
 *                                             grade / one is still flagged review_needed
 *   409 EVALUATION_ALREADY_RELEASED           already with the tenant
 * Runs under the attempt row lock, so it serialises against send-back, override and a
 * tenant publish. `tenantId` must come from resolveEvaluationTenant().
 */
export async function handleSuperReleaseToTenant(input: {
  tenantId: string;
  userId: string;
  attemptId: string;
}): Promise<HandleSuperReleaseToTenantOutput> {
  const { tenantId, userId, attemptId } = input;

  const releasedAt = await withTenant(tenantId, async (client) => {
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
        AI_GRADING_ERROR_CODES.ATTEMPT_NOT_FOUND,
        404,
      );
    }
    if (row.erased_at !== null) {
      throw new AppError(
        `Attempt ${attemptId} belongs to an erased candidate — results cannot be released`,
        AI_GRADING_ERROR_CODES.ATTEMPT_NOT_RELEASABLE_ERASED,
        422,
      );
    }
    if (row.status === "released") {
      throw new AppError(
        "This result has already been published to the candidate and can no longer be changed",
        AI_GRADING_ERROR_CODES.RESULT_ALREADY_PUBLISHED,
        409,
      );
    }
    if (row.status !== "graded") {
      throw new AppError(
        `Evaluation is not complete (attempt status '${row.status}')`,
        AI_GRADING_ERROR_CODES.EVALUATION_NOT_COMPLETE,
        409,
      );
    }
    if (row.evaluation_released_at !== null) {
      throw new AppError(
        "This evaluation has already been released to the tenant",
        AI_GRADING_ERROR_CODES.EVALUATION_ALREADY_RELEASED,
        409,
      );
    }

    // Complete = every frozen question has an effective grade that is not flagged.
    // 'graded' guarantees this at finalize time; a later re-run / accept can add a
    // newer review_needed row, so re-check here (same rule as module 09 release).
    const progress = await getAttemptProgress(client, attemptId);
    if (progress.total === 0 || progress.done < progress.total) {
      throw new AppError(
        "Evaluation is not complete — a question has no final grade or a grade still needs review",
        AI_GRADING_ERROR_CODES.EVALUATION_NOT_COMPLETE,
        409,
        { details: { questions: progress.total, graded: progress.done } },
      );
    }

    const upd = await client.query<{ evaluation_released_at: Date }>(
      `UPDATE attempts
          SET evaluation_released_at  = now(),
              evaluation_released_by  = $2,
              evaluation_sent_back_at = NULL
        WHERE id = $1
        RETURNING evaluation_released_at`,
      [attemptId, userId],
    );

    await auditInTx(client, {
      action: "grading.evaluation_released",
      actorKind: "user",
      actorUserId: userId,
      tenantId,
      entityType: "attempt",
      entityId: attemptId,
      before: { evaluation_status: "awaiting_evaluation" },
      after: { evaluation_status: "ready_to_publish" },
    });

    return upd.rows[0]!.evaluation_released_at;
  });

  log.info({ attemptId, tenantId }, "grading.evaluation_released.complete");

  return { attempt_id: attemptId, evaluation_released_at: releasedAt.toISOString() };
}

export interface HandleSuperReleaseToTenantBulkOutput {
  released: string[];
  skipped: Array<{ id: string; code: string }>;
}

/** Machine code for a skipped entry: details.code (e.g. TENANT_NOT_ACTIVE) wins over the generic code. */
function skipCode(err: unknown): string {
  if (err instanceof AppError) {
    const detailCode = err.details?.["code"];
    return typeof detailCode === "string" ? detailCode : err.code;
  }
  return "RELEASE_FAILED";
}

/**
 * Release many evaluations, each in its OWN transaction (resolve tenant -> active
 * gate -> handleSuperReleaseToTenant), so one bad attempt never rolls back the
 * others. Duplicate ids are processed once. 200 { released: [ids], skipped: [{id, code}] }.
 */
export async function handleSuperReleaseToTenantBulk(input: {
  userId: string;
  attemptIds: string[];
}): Promise<HandleSuperReleaseToTenantBulkOutput> {
  const released: string[] = [];
  const skipped: Array<{ id: string; code: string }> = [];

  for (const attemptId of new Set(input.attemptIds)) {
    try {
      const tenantId = await resolveEvaluationTenant(attemptId);
      await handleSuperReleaseToTenant({ tenantId, userId: input.userId, attemptId });
      released.push(attemptId);
    } catch (err) {
      if (!(err instanceof AppError)) {
        log.error({ attemptId, err }, "grading.release_to_tenant.unexpected_error");
      }
      skipped.push({ id: attemptId, code: skipCode(err) });
    }
  }

  log.info(
    { requested: input.attemptIds.length, released: released.length, skipped: skipped.length },
    "grading.release_to_tenant.bulk_complete",
  );

  return { released, skipped };
}
