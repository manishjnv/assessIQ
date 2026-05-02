/**
 * Service layer for module 06-attempt-engine.
 *
 * Six candidate-facing functions plus one boundary helper:
 *   - startAttempt: idempotent create-or-return for (assessment, user)
 *   - getAttemptForCandidate: server-authoritative timer + frozen questions
 *   - saveAnswer: last-write-wins autosave (decision #7)
 *   - toggleFlag: per-question flag
 *   - recordEvent: behavioural-signal log with rate cap (decision #23)
 *   - submitAttempt: idempotent terminal transition
 *   - sweepStaleTimers: pure logic the boundary cron will call (apps/worker
 *     does not exist yet; same pattern as module 05's boundaries.ts)
 *
 * RLS: every function wraps its DB ops in withTenant(). Routes pass
 * tenantId from req.session; the DB enforces tenant isolation for both the
 * tenant-bearing attempts table and the JOIN-RLS child tables.
 *
 * Owner check: every candidate-facing call asserts attempt.user_id === userId
 * AFTER the RLS-scoped fetch. Tenant isolation is structural (RLS); ownership
 * within a tenant is service-layer (RLS would let admin-as-candidate read,
 * which is correct — we want admin-impersonation to work for ops). The
 * service layer denies cross-user reads with NOT_OWNED_BY_USER.
 *
 * State machine (Phase 1):
 *   draft → in_progress     (startAttempt creates as in_progress directly)
 *   in_progress → submitted (submitAttempt — stops here per decision #6)
 *   in_progress → auto_submitted (sweepStaleTimers, on timer expiry)
 * Phase 2 will add: submitted → pending_admin_grading → graded → released.
 * The service rejects any other transition with WRITES_LOCKED.
 */

import {
  AuthzError,
  ConflictError,
  NotFoundError,
  ValidationError,
  streamLogger,
  uuidv7,
} from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import * as alRepo from "../../05-assessment-lifecycle/src/repository.js";
import * as qbRepo from "../../04-question-bank/src/repository.js";
import * as repo from "./repository.js";
import {
  AE_ERROR_CODES,
  EVENT_PAYLOAD_SCHEMAS,
  KNOWN_EVENT_TYPES,
  TERMINAL_ATTEMPT_STATUSES,
} from "./types.js";
import type {
  Attempt,
  AttemptAnswer,
  AttemptEvent,
  CandidateAttemptView,
  EventType,
  RecordEventInput,
  SaveAnswerInput,
  StartAttemptInput,
  ToggleFlagInput,
} from "./types.js";
import { RATE_CAP_CONSTANTS, tryAdmitEvent } from "./rate-cap.js";

const log = streamLogger("app");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fisher-Yates shuffle (in-place). Uses `Math.random()` per decision #20:
 * non-reproducible — the spec explicitly trades reproducibility for cost.
 * Re-creating an attempt may yield a different question order; that's an
 * acceptable trade for v1.
 */
function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i] as T;
    arr[i] = arr[j] as T;
    arr[j] = tmp;
  }
}

/**
 * Assert the loaded attempt belongs to `userId`. The RLS-scoped fetch only
 * narrows by tenant; admin-as-candidate impersonation would still load the
 * row. Phase 1 candidate flows always pass the requesting user's id and we
 * fail-closed when it doesn't match.
 */
function assertAttemptOwnedBy(attempt: Attempt, userId: string): void {
  if (attempt.user_id !== userId) {
    throw new AuthzError(`Attempt ${attempt.id} not owned by user ${userId}`, {
      details: { code: AE_ERROR_CODES.NOT_OWNED_BY_USER },
    });
  }
}

/**
 * Compute remaining seconds for an attempt. Negative values are clamped to 0;
 * null ends_at returns 0 (treat as expired).
 */
function computeRemainingSeconds(attempt: Attempt, now: Date): number {
  if (attempt.ends_at === null) return 0;
  const remainingMs = attempt.ends_at.getTime() - now.getTime();
  if (remainingMs <= 0) return 0;
  return Math.floor(remainingMs / 1000);
}

// ===========================================================================
// startAttempt — idempotent (assessment, user) → attempt
// ===========================================================================

export async function startAttempt(
  tenantId: string,
  input: StartAttemptInput,
): Promise<Attempt> {
  log.info(
    { tenantId, userId: input.userId, assessmentId: input.assessmentId },
    "startAttempt",
  );

  return withTenant(tenantId, async (client) => {
    // a. If an attempt already exists, return it (idempotent).
    const existing = await repo.findAttemptByAssessmentAndUser(
      client,
      input.assessmentId,
      input.userId,
    );
    if (existing !== null) {
      assertAttemptOwnedBy(existing, input.userId);
      return existing;
    }

    // b. Assessment must exist and be 'active'.
    const assessment = await alRepo.findAssessmentById(client, input.assessmentId);
    if (assessment === null) {
      throw new NotFoundError(`Assessment not found: ${input.assessmentId}`, {
        details: { code: AE_ERROR_CODES.ASSESSMENT_NOT_FOUND },
      });
    }
    if (assessment.status !== "active") {
      throw new ConflictError(
        `Assessment must be 'active' to start an attempt (current: '${assessment.status}')`,
        { details: { code: AE_ERROR_CODES.ASSESSMENT_NOT_ACTIVE, status: assessment.status } },
      );
    }

    // c. Invitation must exist and be valid (not expired/submitted).
    const invitation = await repo.findInvitationForCandidate(
      client,
      input.assessmentId,
      input.userId,
    );
    if (invitation === null) {
      throw new NotFoundError("No invitation for this assessment", {
        details: { code: AE_ERROR_CODES.INVITATION_NOT_FOUND },
      });
    }
    if (invitation.status === "expired") {
      throw new ValidationError("Invitation has been revoked", {
        details: { code: AE_ERROR_CODES.INVITATION_INVALID, status: invitation.status },
      });
    }
    if (invitation.status === "submitted") {
      throw new ValidationError("Attempt already submitted", {
        details: { code: AE_ERROR_CODES.ALREADY_SUBMITTED },
      });
    }
    if (invitation.expires_at.getTime() < Date.now()) {
      throw new ValidationError("Invitation expired", {
        details: { code: AE_ERROR_CODES.INVITATION_EXPIRED, expires_at: invitation.expires_at },
      });
    }

    // d. Resolve level for duration_minutes (timer source).
    const level = await qbRepo.findLevelById(client, assessment.level_id);
    if (level === null) {
      throw new NotFoundError(`Level not found: ${assessment.level_id}`, {
        details: { code: AE_ERROR_CODES.ASSESSMENT_NOT_ACTIVE },
      });
    }

    // e. Pull the active question pool and verify size.
    const pool = await repo.listActiveQuestionPoolForPick(
      client,
      assessment.pack_id,
      assessment.level_id,
    );
    if (pool.length < assessment.question_count) {
      throw new ValidationError(
        `Question pool too small at start: ${pool.length} < ${assessment.question_count}`,
        {
          details: {
            code: AE_ERROR_CODES.POOL_TOO_SMALL,
            available: pool.length,
            required: assessment.question_count,
          },
        },
      );
    }

    // f. Shuffle (decision #20) — only if assessment.randomize. Either way,
    //    take the first N from the (possibly shuffled) array.
    const picks = [...pool];
    if (assessment.randomize) {
      shuffleInPlace(picks);
    }
    const chosen = picks.slice(0, assessment.question_count);

    // g. Compute timer.
    const startedAt = new Date();
    const durationSeconds = level.duration_minutes * 60;
    const endsAt = new Date(startedAt.getTime() + durationSeconds * 1000);

    // h. Insert attempt row.
    const attemptId = uuidv7();
    const attempt = await repo.insertAttempt(client, {
      id: attemptId,
      tenantId,
      assessmentId: input.assessmentId,
      userId: input.userId,
      status: "in_progress",
      startedAt,
      endsAt,
      durationSeconds,
    });

    // i. Snapshot the question set + empty answer rows.
    const aqRows = chosen.map((q, i) => ({
      questionId: q.id,
      position: i + 1,
      questionVersion: q.version,
    }));
    await repo.insertAttemptQuestions(client, attempt.id, aqRows);
    await repo.insertEmptyAttemptAnswers(client, attempt.id, chosen.map((q) => q.id));

    // j. Mark invitation 'started' (no-op if it was already past pending/viewed).
    await repo.markInvitationStarted(client, invitation.id);

    // k. Append a question_view event for the first question (Phase 1
    //    candidate UI also fires this client-side; the server-side write at
    //    start ensures every attempt has at least one event row).
    const firstQid = chosen[0]?.id;
    if (firstQid !== undefined) {
      await repo.insertAttemptEvent(client, {
        attemptId: attempt.id,
        event_type: "question_view",
        question_id: firstQid,
        payload: {},
      });
    }

    return attempt;
  });
}

// ===========================================================================
// getAttemptForCandidate — server-authoritative view (timer + frozen Qs)
// ===========================================================================

export async function getAttemptForCandidate(
  tenantId: string,
  attemptId: string,
  userId: string,
): Promise<CandidateAttemptView> {
  return withTenant(tenantId, async (client) => {
    const attempt = await repo.findAttemptById(client, attemptId);
    if (attempt === null) {
      throw new NotFoundError(`Attempt not found: ${attemptId}`, {
        details: { code: AE_ERROR_CODES.ATTEMPT_NOT_FOUND },
      });
    }
    assertAttemptOwnedBy(attempt, userId);

    const now = new Date();
    let effectiveAttempt = attempt;

    // Server-authoritative auto-submit: if the timer has expired and the
    // candidate is reading the view, transition NOW so the candidate cannot
    // submit answers post-deadline by racing the next sweep.
    if (
      attempt.status === "in_progress" &&
      attempt.ends_at !== null &&
      attempt.ends_at.getTime() <= now.getTime()
    ) {
      effectiveAttempt = await repo.updateAttemptStatus(client, attempt.id, {
        status: "auto_submitted",
        submittedAt: now,
      });
      await repo.markInvitationSubmitted(client, attempt.assessment_id, attempt.user_id);
      await repo.insertAttemptEvent(client, {
        attemptId: attempt.id,
        event_type: "time_milestone",
        payload: {
          seconds: attempt.duration_seconds ?? 0,
          kind: "auto_submit",
        },
      });
    }

    const questions = await repo.listFrozenQuestionsForAttempt(client, attempt.id);
    const answers = await repo.listAttemptAnswers(client, attempt.id);

    return {
      attempt: effectiveAttempt,
      questions,
      answers,
      remaining_seconds: computeRemainingSeconds(effectiveAttempt, now),
    };
  });
}

// ===========================================================================
// saveAnswer — last-write-wins (decision #7)
// ===========================================================================

export async function saveAnswer(
  tenantId: string,
  userId: string,
  input: SaveAnswerInput,
): Promise<{ client_revision: number }> {
  return withTenant(tenantId, async (client) => {
    const attempt = await repo.findAttemptById(client, input.attemptId);
    if (attempt === null) {
      throw new NotFoundError(`Attempt not found: ${input.attemptId}`, {
        details: { code: AE_ERROR_CODES.ATTEMPT_NOT_FOUND },
      });
    }
    assertAttemptOwnedBy(attempt, userId);

    if (attempt.status !== "in_progress") {
      throw new ConflictError(
        `Attempt ${attempt.id} is not writable (status: ${attempt.status})`,
        { details: { code: AE_ERROR_CODES.WRITES_LOCKED, status: attempt.status } },
      );
    }

    // Server-authoritative timer check — even if the candidate's clock is
    // skewed forward, the server rejects writes once the timer has expired.
    const now = new Date();
    if (attempt.ends_at !== null && attempt.ends_at.getTime() <= now.getTime()) {
      throw new ConflictError("Timer has expired", {
        details: { code: AE_ERROR_CODES.TIMER_EXPIRED },
      });
    }

    // Question must be in the attempt's frozen set.
    const aq = await repo.findAttemptQuestion(
      client,
      input.attemptId,
      input.questionId,
    );
    if (aq === null) {
      throw new NotFoundError(
        `Question ${input.questionId} not in attempt ${input.attemptId}`,
        { details: { code: AE_ERROR_CODES.UNKNOWN_QUESTION } },
      );
    }

    const incomingRevision = input.client_revision ?? 0;

    const repoInput: Parameters<typeof repo.saveAttemptAnswer>[1] = {
      attemptId: input.attemptId,
      questionId: input.questionId,
      answer: input.answer,
      incomingRevision,
      editsCount: input.edits_count,
      timeSpentSeconds: input.time_spent_seconds,
    };
    const { previousRevision, newRevision } = await repo.saveAttemptAnswer(
      client,
      repoInput,
    );

    // Multi-tab conflict event when incoming < stored (decision #7).
    if (incomingRevision < previousRevision) {
      await repo.insertAttemptEvent(client, {
        attemptId: input.attemptId,
        event_type: "multi_tab_conflict",
        question_id: input.questionId,
        payload: {
          incoming_revision: incomingRevision,
          stored_revision: previousRevision,
        },
      });
    }

    // Always log the answer_save event.
    await repo.insertAttemptEvent(client, {
      attemptId: input.attemptId,
      event_type: "answer_save",
      question_id: input.questionId,
      payload: {
        edits_count: input.edits_count,
        client_revision: newRevision,
      },
    });

    return { client_revision: newRevision };
  });
}

// ===========================================================================
// toggleFlag
// ===========================================================================

export async function toggleFlag(
  tenantId: string,
  userId: string,
  input: ToggleFlagInput,
): Promise<{ flagged: boolean }> {
  return withTenant(tenantId, async (client) => {
    const attempt = await repo.findAttemptById(client, input.attemptId);
    if (attempt === null) {
      throw new NotFoundError(`Attempt not found: ${input.attemptId}`, {
        details: { code: AE_ERROR_CODES.ATTEMPT_NOT_FOUND },
      });
    }
    assertAttemptOwnedBy(attempt, userId);

    if (attempt.status !== "in_progress") {
      throw new ConflictError(
        `Attempt ${attempt.id} is not writable (status: ${attempt.status})`,
        { details: { code: AE_ERROR_CODES.WRITES_LOCKED, status: attempt.status } },
      );
    }

    const aq = await repo.findAttemptQuestion(
      client,
      input.attemptId,
      input.questionId,
    );
    if (aq === null) {
      throw new NotFoundError(
        `Question ${input.questionId} not in attempt ${input.attemptId}`,
        { details: { code: AE_ERROR_CODES.UNKNOWN_QUESTION } },
      );
    }

    const result = await repo.setAnswerFlag(
      client,
      input.attemptId,
      input.questionId,
      input.flagged,
    );

    await repo.insertAttemptEvent(client, {
      attemptId: input.attemptId,
      event_type: input.flagged ? "flag" : "unflag",
      question_id: input.questionId,
      payload: { flagged: input.flagged },
    });

    return result;
  });
}

// ===========================================================================
// recordEvent — rate-capped (decision #23)
// ===========================================================================

export async function recordEvent(
  tenantId: string,
  userId: string,
  input: RecordEventInput,
): Promise<AttemptEvent | null> {
  // Validate event_type before touching the DB.
  if (!KNOWN_EVENT_TYPES.has(input.event_type as EventType)) {
    throw new ValidationError(`Unknown event_type: ${input.event_type}`, {
      details: { code: AE_ERROR_CODES.UNKNOWN_EVENT_TYPE, event_type: input.event_type },
    });
  }
  const eventType = input.event_type as EventType;

  // Validate payload against the per-type schema.
  const schema = EVENT_PAYLOAD_SCHEMAS[eventType];
  const parsed = schema.safeParse(input.payload ?? {});
  if (!parsed.success) {
    throw new ValidationError(`Invalid payload for event_type ${eventType}`, {
      details: {
        code: AE_ERROR_CODES.INVALID_EVENT_PAYLOAD,
        event_type: eventType,
        issues: parsed.error.issues,
      },
    });
  }

  return withTenant(tenantId, async (client) => {
    const attempt = await repo.findAttemptById(client, input.attemptId);
    if (attempt === null) {
      throw new NotFoundError(`Attempt not found: ${input.attemptId}`, {
        details: { code: AE_ERROR_CODES.ATTEMPT_NOT_FOUND },
      });
    }
    assertAttemptOwnedBy(attempt, userId);

    if (attempt.status !== "in_progress") {
      throw new ConflictError(
        `Attempt ${attempt.id} is not writable (status: ${attempt.status})`,
        { details: { code: AE_ERROR_CODES.WRITES_LOCKED, status: attempt.status } },
      );
    }

    // Per-second rate cap — drop silently when over the bucket.
    if (!tryAdmitEvent(input.attemptId)) {
      return null;
    }

    // Per-attempt total cap — DB count, then a single 'event_volume_capped'
    // marker on overflow. The partial UNIQUE index makes the marker
    // structurally idempotent: the second overflow attempt hits 23505 and
    // we silently swallow it.
    const total = await repo.countAttemptEvents(client, input.attemptId);
    if (total >= RATE_CAP_CONSTANTS.PER_ATTEMPT_TOTAL) {
      try {
        await repo.insertAttemptEvent(client, {
          attemptId: input.attemptId,
          event_type: "event_volume_capped",
          payload: { cap: RATE_CAP_CONSTANTS.PER_ATTEMPT_TOTAL },
        });
      } catch (err) {
        // 23505 — partial unique index on event_type='event_volume_capped'
        // means a marker already exists. Swallow.
        if (
          err === null ||
          typeof err !== "object" ||
          (err as { code?: string }).code !== "23505"
        ) {
          throw err;
        }
      }
      return null;
    }

    // Insert the validated event.
    const event = await repo.insertAttemptEvent(client, {
      attemptId: input.attemptId,
      event_type: eventType,
      question_id: input.question_id ?? null,
      payload: parsed.data,
    });
    return event;
  });
}

// ===========================================================================
// submitAttempt — idempotent terminal transition
// ===========================================================================

export async function submitAttempt(
  tenantId: string,
  userId: string,
  attemptId: string,
): Promise<{ attempt: Attempt; status: "submitted" }> {
  log.info({ tenantId, userId, attemptId }, "submitAttempt");

  return withTenant(tenantId, async (client) => {
    const attempt = await repo.findAttemptById(client, attemptId);
    if (attempt === null) {
      throw new NotFoundError(`Attempt not found: ${attemptId}`, {
        details: { code: AE_ERROR_CODES.ATTEMPT_NOT_FOUND },
      });
    }
    assertAttemptOwnedBy(attempt, userId);

    // Idempotent — already-terminal states return current state without
    // re-processing (per SKILL.md § Idempotency).
    if (TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) {
      return { attempt, status: "submitted" };
    }

    if (attempt.status !== "in_progress") {
      throw new ConflictError(
        `Cannot submit attempt in status '${attempt.status}'`,
        { details: { code: AE_ERROR_CODES.WRITES_LOCKED, status: attempt.status } },
      );
    }

    const now = new Date();
    const updated = await repo.updateAttemptStatus(client, attemptId, {
      status: "submitted",
      submittedAt: now,
    });
    await repo.markInvitationSubmitted(client, attempt.assessment_id, attempt.user_id);

    return { attempt: updated, status: "submitted" };
  });
}

// ===========================================================================
// getAnswers — admin/owner read (used by the candidate result page placeholder)
// ===========================================================================

export async function listAnswersForAttempt(
  tenantId: string,
  userId: string,
  attemptId: string,
): Promise<AttemptAnswer[]> {
  return withTenant(tenantId, async (client) => {
    const attempt = await repo.findAttemptById(client, attemptId);
    if (attempt === null) {
      throw new NotFoundError(`Attempt not found: ${attemptId}`, {
        details: { code: AE_ERROR_CODES.ATTEMPT_NOT_FOUND },
      });
    }
    assertAttemptOwnedBy(attempt, userId);
    return repo.listAttemptAnswers(client, attemptId);
  });
}

// ===========================================================================
// sweepStaleTimers — pure logic, callable by future apps/worker BullMQ job
// ===========================================================================

export interface SweepResult {
  autoSubmitted: number;
  attemptIds: string[];
}

/**
 * Bulk auto-submit attempts whose timer has expired. Caller is responsible for
 * the per-tenant withTenant wrap (mirrors module 05's processBoundariesForTenant
 * pattern). Idempotent — running twice in succession is harmless because the
 * second pass finds no in_progress + expired rows.
 *
 * BullMQ runtime wiring is deferred until apps/worker exists; this function is
 * exported via index.ts so the cron handler can import it cleanly when it lands.
 */
export async function sweepStaleTimersForTenant(
  tenantId: string,
  now: Date = new Date(),
): Promise<SweepResult> {
  return withTenant(tenantId, async (client) => {
    const { count, ids } = await repo.bulkAutoSubmitExpired(client, now);
    if (count === 0) {
      return { autoSubmitted: 0, attemptIds: [] };
    }

    // Emit a time_milestone event per auto-submitted attempt so the
    // archetype computation in module 09 can distinguish auto-submit from
    // candidate submit.
    for (const attemptId of ids) {
      await repo.insertAttemptEvent(client, {
        attemptId,
        event_type: "time_milestone",
        payload: {
          seconds: 0,
          kind: "auto_submit",
        },
      });
    }

    log.info(
      { tenantId, autoSubmitted: count, attemptIds: ids },
      "sweepStaleTimers.autoSubmitted",
    );
    return { autoSubmitted: count, attemptIds: ids };
  });
}
