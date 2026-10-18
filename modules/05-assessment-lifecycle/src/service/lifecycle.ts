import { NotFoundError, ValidationError } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import { assertPublishEntitled } from "@assessiq/billing";
import type { PoolClient } from "pg";
import * as repo from "../repository.js";
import { assertCanTransition, assertReopenAllowed } from "../state-machine.js";
import { AL_ERROR_CODES } from "../types.js";
import type { Assessment, ResolvedBlueprint } from "../types.js";
import { log, countActiveQuestionsForLevel } from "./_shared.js";
import { countActiveQuestionsForCriterion, criterionNodeScope } from "./blueprint.js";

// ---------------------------------------------------------------------------
// freezeAssessmentPool — "lock at assignment" snapshot (additive)
// ---------------------------------------------------------------------------
//
// Snapshots the assessment's EXACT eligible question pool at publish time into
// assessment_frozen_pool (migration 0096). After this, module 06 startAttempt
// draws from the frozen set instead of the live pool, so master-pack revisions
// and clone auto-sync only reach NEWLY-published assessments — already-assigned
// tests keep their original content (and every candidate of one assessment sees
// the same pool, closing the fairness gap).
//
// Captures the SAME pool listActiveQuestionPoolForPick would return at this
// instant: every status='active' question in (pack, level), pinned to
// MAX(question_versions.version), plus the taxonomy fields the blueprint draw
// re-filters on. The full (pack, level) active set is frozen uniformly — the
// legacy draw uses all rows; the blueprint draw filters by (domain, category,
// type) at draw time. INNER JOIN question_versions mirrors the live query, so a
// question with no snapshot is excluded identically (see RCA 2026-05-25 clone
// snapshot fix).
//
// WRITE-ONCE / idempotent: ON CONFLICT (assessment_id, question_id) DO NOTHING.
// publishAssessment (draft→published) is the first freeze; reopenAssessment
// (closed→published) re-invokes this but the rows already exist, so it is a
// no-op — the original freeze stands. Returns the assessment's total frozen
// pool size (for the audit payload), not just the rows inserted this call.
//
// Runs inside the caller's withTenant tx (RLS-scoped to the assessment tenant).
async function freezeAssessmentPool(
  client: PoolClient,
  tenantId: string,
  assessmentId: string,
  packId: string,
  levelId: string,
): Promise<number> {
  await client.query(
    `INSERT INTO assessment_frozen_pool
       (tenant_id, assessment_id, question_id, question_version,
        level_id, domain_id, category_id, type, points)
     SELECT $1, $2, q.id, MAX(qv.version)::int,
            q.level_id, q.domain_id, q.category_id, q.type, q.points
       FROM questions q
       JOIN question_versions qv ON qv.question_id = q.id
      WHERE q.pack_id = $3 AND q.level_id = $4 AND q.status = 'active'
      GROUP BY q.id, q.level_id, q.domain_id, q.category_id, q.type, q.points
     ON CONFLICT (assessment_id, question_id) DO NOTHING`,
    [tenantId, assessmentId, packId, levelId],
  );

  const sized = await client.query<{ count: string }>(
    `SELECT count(*) FROM assessment_frozen_pool WHERE assessment_id = $1`,
    [assessmentId],
  );
  return parseInt(sized.rows[0]?.count ?? "0", 10);
}

// ---------------------------------------------------------------------------
// publishAssessment — draft → published (with pool-size pre-flight)
// ---------------------------------------------------------------------------

export async function publishAssessment(
  tenantId: string,
  id: string,
  publishedByUserId: string,
): Promise<Assessment> {
  log.info({ tenantId, id }, "publishAssessment");

  return withTenant(tenantId, async (client) => {
    // a. Read assessment
    const assessment = await repo.findAssessmentById(client, id);
    if (assessment === null) {
      throw new NotFoundError(`Assessment not found: ${id}`, {
        details: { code: AL_ERROR_CODES.ASSESSMENT_NOT_FOUND },
      });
    }

    // b. Enforce state machine — draft → published only (closed → published
    //    must go through reopenAssessment)
    assertCanTransition(assessment.status, "published");

    // B2 — server-authoritative entitlement enforcement (authorization gate).
    // Runs in this withTenant tx; throws AppError 403 NOT_ENTITLED if the
    // assessment's pack is not entitled (internal tier bypasses). Fail-fast
    // before pool work. See modules/19-billing assertPublishEntitled + spec B2.
    await assertPublishEntitled(client, tenantId, assessment.pack_id);

    // c. Pool-size pre-flight
    //    Blueprint path (C2): per-criterion check.
    //    No-blueprint path: existing whole-pool count unchanged.
    const blueprint = (assessment.settings as Record<string, unknown>)?.["blueprint"] as
      | ResolvedBlueprint
      | undefined;

    if (blueprint !== undefined) {
      // C2: per-criterion pool pre-flight. All criteria must pass.
      for (let idx = 0; idx < blueprint.criteria.length; idx++) {
        const criterion = blueprint.criteria[idx]!;
        const criterionAvailable = await countActiveQuestionsForCriterion(
          client,
          assessment.pack_id,
          assessment.level_id,
          blueprint.domain_id,
          criterion.category_id,
          criterion.type,
          criterionNodeScope(criterion),
        );
        if (criterionAvailable < criterion.count) {
          throw new ValidationError(
            `Blueprint criterion ${idx} pool too small: ${criterionAvailable} available < ${criterion.count} required (${criterion.category_id !== undefined ? `category_id=${criterion.category_id}` : `node_id=${criterion.node_id}`}, type=${criterion.type})`,
            {
              details: {
                code: AL_ERROR_CODES.POOL_TOO_SMALL_CRITERION,
                criterion_index: idx,
                category_id: criterion.category_id,
                node_id: criterion.node_id,
                type: criterion.type,
                available: criterionAvailable,
                required: criterion.count,
              },
            },
          );
        }
      }
    } else {
      // No-blueprint: existing whole-pool check unchanged
      const available = await countActiveQuestionsForLevel(
        client,
        assessment.pack_id,
        assessment.level_id,
      );
      if (available < assessment.question_count) {
        throw new ValidationError(
          `Question pool too small: ${available} < ${assessment.question_count}`,
          {
            details: {
              code: AL_ERROR_CODES.POOL_TOO_SMALL,
              available,
              required: assessment.question_count,
            },
          },
        );
      }
    }

    // d. Transition to published
    const updated = await repo.updateAssessmentRow(client, id, { status: "published" });

    // e. "Lock at assignment" — freeze the eligible pool now (additive). The
    //    pre-flight above guaranteed the pool is non-empty and large enough, so
    //    this captures a validated snapshot. Write-once: the first publish
    //    freezes; a later reopen finds the rows and is a no-op.
    const frozenPoolSize = await freezeAssessmentPool(
      client,
      tenantId,
      id,
      assessment.pack_id,
      assessment.level_id,
    );

    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: publishedByUserId,
      action: "assessment.published",
      entityType: "assessment",
      entityId: id,
      before: { status: assessment.status },
      after: {
        status: updated.status,
        question_count: assessment.question_count,
        has_blueprint: blueprint !== undefined,
        frozen_pool_size: frozenPoolSize,
      },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// closeAssessment — active → closed
// ---------------------------------------------------------------------------

export async function closeAssessment(
  tenantId: string,
  id: string,
  closedByUserId: string,
): Promise<Assessment> {
  log.info({ tenantId, id }, "closeAssessment");

  return withTenant(tenantId, async (client) => {
    const assessment = await repo.findAssessmentById(client, id);
    if (assessment === null) {
      throw new NotFoundError(`Assessment not found: ${id}`, {
        details: { code: AL_ERROR_CODES.ASSESSMENT_NOT_FOUND },
      });
    }

    // assertCanTransition enforces active → closed only;
    // draft → closed and closed → closed are both illegal.
    assertCanTransition(assessment.status, "closed");

    const updated = await repo.updateAssessmentRow(client, id, { status: "closed" });

    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: closedByUserId,
      action: "assessment.closed",
      entityType: "assessment",
      entityId: id,
      before: { status: assessment.status },
      after: { status: updated.status },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// cancelAssessment — <any non-terminal> → cancelled (soft retire)
// ---------------------------------------------------------------------------
//
// Soft counterpart to deleteAssessment. Moves the assessment to the terminal
// `cancelled` state, which the default list view hides. Unlike delete it does
// NOT remove the row — attempts, invitations, frozen pool and audit history all
// survive. This is the path for retiring an assessment that already has
// candidate attempts (which hard-delete refuses).
//
// In-flight semantics (DELIBERATE, consistent with active→closed): cancelling an
// `active` assessment blocks NEW attempts (06-attempt-engine start() requires
// status='active', service.ts:141) but lets already-in_progress attempts finish
// (submission gates on attempt.status, not assessment.status — identical to how
// the boundary cron auto-closes an active assessment under in-flight candidates).
// No in-progress guard is added: that would defeat the "retire a running test
// assessment" use case and would diverge from existing close behaviour.

export async function cancelAssessment(
  tenantId: string,
  id: string,
  cancelledByUserId: string,
): Promise<Assessment> {
  log.info({ tenantId, id }, "cancelAssessment");

  return withTenant(tenantId, async (client) => {
    const assessment = await repo.findAssessmentById(client, id);
    if (assessment === null) {
      throw new NotFoundError(`Assessment not found: ${id}`, {
        details: { code: AL_ERROR_CODES.ASSESSMENT_NOT_FOUND },
      });
    }

    // Legal from draft/published/active/closed → cancelled (terminal).
    // cancelled → cancelled is rejected → 422, so a double-cancel is a no-op
    // surfaced to the caller rather than a silent re-write.
    assertCanTransition(assessment.status, "cancelled");

    const updated = await repo.updateAssessmentRow(client, id, { status: "cancelled" });

    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: cancelledByUserId,
      action: "assessment.cancelled",
      entityType: "assessment",
      entityId: id,
      before: { status: assessment.status },
      after: { status: updated.status },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// deleteAssessment — hard delete (zero-attempts only)
// ---------------------------------------------------------------------------
//
// Removes the assessment row entirely. Allowed ONLY when the assessment has no
// attempts (dev/test/incomplete cleanup). assessment_invitations and
// assessment_frozen_pool cascade away (ON DELETE CASCADE); audit_log is
// append-only and untouched. For assessments that DO have attempts, callers
// must use cancelAssessment instead.

export async function deleteAssessment(
  tenantId: string,
  id: string,
  deletedByUserId: string,
): Promise<void> {
  log.info({ tenantId, id }, "deleteAssessment");

  return withTenant(tenantId, async (client) => {
    const assessment = await repo.findAssessmentById(client, id);
    if (assessment === null) {
      throw new NotFoundError(`Assessment not found: ${id}`, {
        details: { code: AL_ERROR_CODES.ASSESSMENT_NOT_FOUND },
      });
    }

    // Zero-attempts guard. The attempts FK is ON DELETE RESTRICT, so the DB
    // would block the delete regardless — but counting first lets us return a
    // friendly 422 that steers the admin to cancel, instead of a raw FK error.
    // Count + delete share this withTenant tx: a racing attempt insert between
    // them is still caught by the FK at DELETE time and rolls the whole tx back.
    const attemptCount = await repo.countAttemptsForAssessment(client, id);
    if (attemptCount > 0) {
      throw new ValidationError(
        `Cannot delete assessment '${id}': it has ${attemptCount} candidate attempt(s). Cancel it instead to retire it without losing attempt history.`,
        { details: { code: AL_ERROR_CODES.ASSESSMENT_HAS_ATTEMPTS, attemptCount } },
      );
    }

    // Audit BEFORE the delete, same tx, so the forensic record is written even
    // as the row disappears. If the DELETE then fails (FK race) the tx rolls
    // back, including this audit row — no orphaned "deleted" record. `name` is
    // omitted on purpose: the audit redactor strips any `name` key, so logging
    // it yields "[REDACTED]"; pack_id/level_id/status are the useful forensics.
    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: deletedByUserId,
      action: "assessment.deleted",
      entityType: "assessment",
      entityId: id,
      before: {
        status: assessment.status,
        pack_id: assessment.pack_id,
        level_id: assessment.level_id,
      },
    });

    // Cascades invitations + frozen pool. The count guard above covers the
    // common case, but at READ COMMITTED a candidate could insert an attempt
    // between the count and this DELETE (only possible for an `active`
    // assessment — drafts can't be attempted). The attempts FK (ON DELETE
    // RESTRICT) is the hard backstop: such a race makes this DELETE raise
    // foreign_key_violation (23503), which we catch and re-throw as the same
    // friendly guard error so the client never sees a raw Postgres 500. The tx
    // rolls back (the audit row with it), leaving the assessment + attempt intact.
    try {
      await repo.deleteAssessmentRow(client, id);
    } catch (err) {
      if (err && typeof err === "object" && (err as { code?: string }).code === "23503") {
        throw new ValidationError(
          `Cannot delete assessment '${id}': a candidate attempt was created during deletion. Cancel it instead to retire it without losing attempt history.`,
          { details: { code: AL_ERROR_CODES.ASSESSMENT_HAS_ATTEMPTS } },
        );
      }
      throw err;
    }
  });
}

// ---------------------------------------------------------------------------
// reopenAssessment — closed → published (requires now < closes_at)
// ---------------------------------------------------------------------------

export async function reopenAssessment(
  tenantId: string,
  id: string,
  reopenedByUserId: string,
): Promise<Assessment> {
  log.info({ tenantId, id }, "reopenAssessment");

  return withTenant(tenantId, async (client) => {
    const assessment = await repo.findAssessmentById(client, id);
    if (assessment === null) {
      throw new NotFoundError(`Assessment not found: ${id}`, {
        details: { code: AL_ERROR_CODES.ASSESSMENT_NOT_FOUND },
      });
    }

    // closed → published via the state machine
    assertCanTransition(assessment.status, "published");

    // Time-boundary check: cannot reopen past closes_at
    assertReopenAllowed(new Date(), assessment.closes_at);

    // B2 — server-authoritative entitlement enforcement (authorization gate,
    // reopen path). Runs in this withTenant tx; throws AppError 403 NOT_ENTITLED
    // if the assessment's pack is not entitled (internal tier bypasses).
    // See modules/19-billing assertPublishEntitled + spec B2.
    await assertPublishEntitled(client, tenantId, assessment.pack_id);

    const updated = await repo.updateAssessmentRow(client, id, { status: "published" });

    // "Lock at assignment" — write-once freeze. A normally-published assessment
    // is already frozen, so this is a no-op (ON CONFLICT DO NOTHING) and the
    // original content stands. The only case it inserts is a legacy assessment
    // published BEFORE migration 0096 (no frozen rows yet) being reopened — it
    // freezes the current pool then, which is the forward-only fallback.
    const frozenPoolSize = await freezeAssessmentPool(
      client,
      tenantId,
      id,
      assessment.pack_id,
      assessment.level_id,
    );

    // Reuse assessment.published with after.kind=reopen — same pattern as
    // 04-question-bank's restoreVersion → question.updated kind=restore.
    // Keeps the action catalog tight; forensic queries filter on
    // after->>'kind' = 'reopen' when distinguishing initial publish from reopen.
    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: reopenedByUserId,
      action: "assessment.published",
      entityType: "assessment",
      entityId: id,
      before: { status: assessment.status },
      after: {
        kind: "reopen",
        status: updated.status,
        closes_at: updated.closes_at?.toISOString() ?? null,
        frozen_pool_size: frozenPoolSize,
      },
    });

    return updated;
  });
}

