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
  AppError,
  AuthzError,
  ConflictError,
  NotFoundError,
  ValidationError,
  attemptsAllowed,
  streamLogger,
  uuidv7,
} from "@assessiq/core";
import { withTenant, withSystemRole } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import type { PoolClient } from "pg";
import { scoreMcqAndFinalizeSafely } from "@assessiq/scoring";
import { emitAttemptEventAfterCommit } from "@assessiq/notifications";
import * as alRepo from "../../05-assessment-lifecycle/src/repository.js";
import { assertPoolVerifiedForInvites } from "@assessiq/assessment-lifecycle";
import * as qbRepo from "../../04-question-bank/src/repository.js";
import * as tenancyRepo from "../../02-tenancy/src/repository.js";
import * as repo from "./repository.js";
import { resolvePolicyInTx } from "./camera/gate.js";
import { cameraSetupBlocker } from "./camera/policy.js";
import { CAMERA_NOTICE_VERSION } from "./camera/constants.js";
import { latestConsentForInvitation, linkConsentToAttempt } from "./camera/repository.js";
import { groupUnits, takeUnits, type PassageFact } from "./passages.js";
import { getCompanyBranding } from "./result.js";
import {
  AE_ERROR_CODES,
  EVENT_PAYLOAD_SCHEMAS,
  KNOWN_EVENT_TYPES,
  SERVER_ONLY_EVENT_TYPES,
  TERMINAL_ATTEMPT_STATUSES,
  checkAnswerForSave,
  answerTextLength,
  MAX_ANSWER_CHARS,
} from "./types.js";
import type {
  Attempt,
  AttemptAnswer,
  AttemptEvent,
  AttemptIntegritySummary,
  AttemptStatus,
  CandidateAttemptView,
  EventType,
  RecordEventInput,
  SaveAnswerInput,
  StartAttemptInput,
  ToggleFlagInput,
} from "./types.js";
import { RATE_CAP_CONSTANTS, tryAdmitEvent } from "./rate-cap.js";
import {
  buildSectionsSummary,
  readSections,
  readWholeTestMinutes,
  plannedDurationSeconds,
  readBlueprintMarks,
  resolveSection,
  sectionDeadline,
  totalSectionSeconds,
} from "./sections.js";
import type { AssessmentSection, SectionPosition } from "./sections.js";
import {
  answerToOriginal,
  MAX_SHUFFLE_OPTIONS,
  buildOptionOrder,
  buildOrderingOrder,
  displayAnswers,
  displayQuestions,
  shuffleFieldOf,
  usableOrder,
} from "./option-shuffle.js";
import { QUESTION_TYPE_REGISTRY, isQuestionType } from "@assessiq/question-types";

const log = streamLogger("app");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** EX-1: assessment.settings.scoring.negative_marks_default; anything not a finite number >= 0 is 0 (no penalty). */
function readNegativeMarksDefault(settings: unknown): number {
  const v = (settings as { scoring?: { negative_marks_default?: unknown } } | null | undefined)?.scoring?.negative_marks_default;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

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

/**
 * Test sections: where a sectioned attempt is at `now`. Returns null when the
 * assessment has no sections (callers then behave exactly as before). Advances the
 * stored position when a deadline has passed (lazy, see sections.ts); `pos` null =
 * every section has ended.
 */
async function sectionStateFor(
  client: PoolClient,
  attempt: Attempt,
  now: Date,
): Promise<{ sections: AssessmentSection[]; pos: SectionPosition | null } | null> {
  const assessment = await alRepo.findAssessmentById(client, attempt.assessment_id);
  const sections = readSections(assessment?.settings);
  if (sections === null) return null;
  // Z-42: one whole-test timer = no section lock; ends_at (server, stored at start) is the only deadline.
  if (readWholeTestMinutes(assessment?.settings) !== null) return null;
  const stored = await repo.getSectionProgress(client, attempt.id);
  const pos = resolveSection(sections, stored, attempt.started_at ?? now, now);
  if (pos !== null && pos.current !== (stored?.current ?? 0)) {
    await repo.setSectionProgress(client, attempt.id, {
      ...(stored ?? {}),
      current: pos.current,
      started_at: pos.startedAt.toISOString(),
    });
  }
  return { sections, pos };
}

/** Reject a write to a question whose section is finished (or not open yet). */
async function assertSectionOpen(
  client: PoolClient,
  attempt: Attempt,
  sectionIndex: number | null,
  now: Date,
): Promise<void> {
  if (sectionIndex === null) return; // no sections: nothing to check, no extra query
  const st = await sectionStateFor(client, attempt, now);
  if (st === null) {
    await assertFreeMovementSection(client, attempt, sectionIndex, now);
    return;
  }
  if (st.pos === null || st.pos.current !== sectionIndex) {
    throw new ConflictError("This section is closed", {
      details: { code: AE_ERROR_CODES.SECTION_LOCKED, section_index: sectionIndex },
    });
  }
}

/**
 * FUT-4: move the free-movement position to section `index` (writes only on a change).
 * A locked block records its first entry time in `entered`; that is what closes it later.
 */
async function moveFreeMovementSection(
  client: PoolClient,
  attempt: Attempt,
  stored: repo.SectionProgressRecord | null,
  index: number,
  locked: boolean,
  now: Date,
): Promise<void> {
  const key = String(index);
  const entered = stored?.entered ?? {};
  const firstEntry = locked && entered[key] === undefined;
  if (stored?.current === index && !firstEntry) return;
  await repo.setSectionProgress(client, attempt.id, {
    ...(stored ?? {}),
    current: index,
    started_at: stored?.started_at ?? (attempt.started_at ?? now).toISOString(),
    ...(locked ? { entered: firstEntry ? { ...entered, [key]: now.toISOString() } : entered } : {}),
  });
}

/**
 * FUT-4: free movement (whole_test_minutes) with locked blocks. A locked block that was entered
 * and then left (the position moved to another section) is closed for good. A write to any
 * section moves the position there, so a candidate cannot leave a block without the server knowing.
 * Assessments without a locked block return at once: byte-identical to before.
 */
async function assertFreeMovementSection(
  client: PoolClient,
  attempt: Attempt,
  sectionIndex: number,
  now: Date,
): Promise<void> {
  const assessment = await alRepo.findAssessmentById(client, attempt.assessment_id);
  const sections = readSections(assessment?.settings);
  if (sections === null || readWholeTestMinutes(assessment?.settings) === null) return;
  if (!sections.some((s) => s.locked === true)) return;
  const stored = await repo.getSectionProgress(client, attempt.id);
  const locked = sections[sectionIndex]?.locked === true;
  const enteredBefore = stored !== null && stored.entered?.[String(sectionIndex)] !== undefined;
  if (locked && enteredBefore && stored?.current !== sectionIndex) {
    throw new ConflictError("This section is closed", {
      details: { code: AE_ERROR_CODES.SECTION_LOCKED, section_index: sectionIndex },
    });
  }
  // A first write into a locked block enters it here (a save can land before the position call).
  await moveFreeMovementSection(client, attempt, stored, sectionIndex, locked, now);
}

/**
 * FUT-7: when the question's own time runs out. The clock starts at the first view (position call)
 * or, if that never came, at the first save or flag. Null = this section has no question timer.
 */
async function questionDeadline(
  client: PoolClient,
  attempt: Attempt,
  questionId: string,
  sectionIndex: number,
  now: Date,
): Promise<Date | null> {
  const assessment = await alRepo.findAssessmentById(client, attempt.assessment_id);
  const section = readSections(assessment?.settings)?.[sectionIndex];
  const seconds = section?.seconds_per_question;
  if (seconds === undefined) return null;
  const stored = await repo.getSectionProgress(client, attempt.id);
  const questions = stored?.questions ?? {};
  let started = questions[questionId];
  if (started === undefined) {
    started = now.toISOString();
    await repo.setSectionProgress(client, attempt.id, {
      ...(stored ?? {}),
      current: stored?.current ?? 0,
      started_at: stored?.started_at ?? (attempt.started_at ?? now).toISOString(),
      questions: { ...questions, [questionId]: started },
    });
  }
  return new Date(new Date(started).getTime() + seconds * 1000);
}

/** FUT-7: a save or flag on a question whose own time is up is rejected; the answer already saved stands. */
async function assertQuestionTimeOpen(
  client: PoolClient,
  attempt: Attempt,
  questionId: string,
  sectionIndex: number | null,
  now: Date,
): Promise<void> {
  if (sectionIndex === null) return;
  const deadline = await questionDeadline(client, attempt, questionId, sectionIndex, now);
  if (deadline !== null && deadline.getTime() <= now.getTime()) {
    throw new ConflictError("This question's time is up", {
      details: { code: AE_ERROR_CODES.QUESTION_TIME_UP, question_id: questionId },
    });
  }
}

// ===========================================================================
// startAttempt — idempotent resume; a retake only when asked for (Z-39)
// ===========================================================================

/** Z-39: an attempt the candidate has not finished yet ('draft' / 'in_progress') — resume it, never start another. */
const isUnfinished = (status: AttemptStatus): boolean => status === "draft" || status === "in_progress";

export async function startAttempt(
  tenantId: string,
  input: StartAttemptInput,
): Promise<Attempt> {
  log.info(
    { tenantId, userId: input.userId, assessmentId: input.assessmentId },
    "startAttempt",
  );

  return withTenant(tenantId, async (client) => {
    // a. If an attempt already exists, return it (idempotent) — unless the caller asked
    //    for the NEXT attempt (Z-39 retake) and the latest one is finished. Resume of an
    //    unfinished attempt is always idempotent, so a double click never opens attempt 2.
    let existing = await repo.findAttemptByAssessmentAndUser(
      client,
      input.assessmentId,
      input.userId,
    );
    if (existing !== null) {
      assertAttemptOwnedBy(existing, input.userId);
      if (isUnfinished(existing.status) || input.newAttempt !== true) return existing;
    }
    let nextAttemptNumber = existing === null ? 1 : existing.attempt_number + 1;

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

    // b2. EXP-18 review gate: no NEW attempt while the pool holds an unverified question. Runs for the
    //     embed path too (it skips the invitation check below). NULL review_state passes.
    await assertPoolVerifiedForInvites(client, assessment, "start the assessment");

    // c. Invitation check — skipped for embed-origin attempts (embed JWT IS the authorization).
    //    For standard attempts, invitation must exist and be valid.
    let invitationId: string | undefined;
    let extraAttempts = 0;
    // Z-89: the attempt's test type comes from the INVITATION row, read here under the row lock.
    // It is never read from the request. Embed attempts have no invitation and stay 'real'.
    let deliveryMode: "real" | "mock" = "real";
    let cameraRequired = false; // Batch A: set by the camera gate below; links the consent once the attempt row exists
    if (!input.embedOrigin) {
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
      if (invitation.status === "submitted" && existing === null) {
        throw new ValidationError("Attempt already submitted", {
          details: { code: AE_ERROR_CODES.ALREADY_SUBMITTED },
        });
      }
      if (invitation.expires_at.getTime() < Date.now()) {
        throw new ValidationError("Invitation expired", {
          details: { code: AE_ERROR_CODES.INVITATION_EXPIRED, expires_at: invitation.expires_at },
        });
      }
      // Z-39: the invitation row lock serialises concurrent starts. A start that waited on
      // it must decide on FRESH state: the winner's new attempt is now the latest, so
      // resume it instead of opening another.
      existing = await repo.findAttemptByAssessmentAndUser(client, input.assessmentId, input.userId);
      if (existing !== null) {
        assertAttemptOwnedBy(existing, input.userId);
        if (isUnfinished(existing.status) || input.newAttempt !== true) return existing;
      }
      nextAttemptNumber = existing === null ? 1 : existing.attempt_number + 1;
      invitationId = invitation.id;
      extraAttempts = invitation.extra_attempts;
      deliveryMode = invitation.delivery_mode;

      // c2. Consent invariant (R4) — enforced HERE so EVERY non-embed path that
      //     creates a new attempt (/take/start Begin, /api/me/assessments/:id/start)
      //     needs a consent_events row for the current policy version. Resume
      //     (step a) never reaches this point. Embed attempts are exempt:
      //     consent is host-asserted (the host app's signed JWT authorises the
      //     candidate and the host collects consent under its own terms).
      if (!(await repo.hasConsentEvent(client, {
        userId: input.userId,
        policyVersion: TAKE_CONSENT_POLICY_VERSION,
      }))) {
        throw new AppError(
          "Consent is required before beginning the assessment.",
          AE_ERROR_CODES.CONSENT_REQUIRED,
          422,
          { details: { code: AE_ERROR_CODES.CONSENT_REQUIRED } },
        );
      }

      // c3. Z-87 / Z-91 invariant — enforced HERE so EVERY non-embed path that creates a NEW attempt of a
      //     REAL exam (/take/start, /api/me/assessments/:id/start incl. a retake) is laptop/desktop only and
      //     has passed the readiness check. The two request-facing callers (routes.take.ts and
      //     routes.candidate.ts) ALWAYS pass `gate`; direct service callers (tests, internal tools) do not
      //     and are not request-facing. Route tests prove both routes pass it.
      if (deliveryMode === "real" && input.gate !== undefined) {
        if (input.gate.mobile) {
          throw new AppError(
            "Please open this link on a laptop or desktop computer to take this test",
            "DEVICE_NOT_ALLOWED",
            403,
            { details: { code: "DEVICE_NOT_ALLOWED" } },
          );
        }
        const rd = input.readiness as { passed?: unknown } | undefined;
        if (rd === undefined || rd === null || rd.passed !== true) {
          throw new AppError(
            "Your device is not ready for this test. Run the readiness check first.",
            "READINESS_FAILED",
            422,
            { details: { code: "READINESS_FAILED" } },
          );
        }

        // c4. Real-exam camera gate (Batch A). Same condition as above: request-facing starts only.
        //     CAMERA_ENFORCED=false, a mock test, an embed attempt (accepted gap) or a school with the
        //     camera off all resolve to required=false, so nothing changes for them.
        const { policy, tenantCamera } = await resolvePolicyInTx(client, tenantId, deliveryMode, false);
        if (policy.required) {
          if (cameraSetupBlocker(policy, tenantCamera) !== null) {
            throw new AppError(
              "The test organiser has not finished the camera set-up. Contact your test organiser.",
              "CAMERA_SETUP_REQUIRED",
              422,
              { details: { code: "CAMERA_SETUP_REQUIRED" } },
            );
          }
          const consent = await latestConsentForInvitation(client, invitation.id);
          if (consent === null || consent.decision !== "agreed" || consent.noticeVersion !== CAMERA_NOTICE_VERSION || consent.attemptId !== null) {
            throw new AppError(
              "Camera consent is required before this test starts.",
              "CAMERA_CONSENT_REQUIRED",
              422,
              { details: { code: "CAMERA_CONSENT_REQUIRED" } },
            );
          }
          cameraRequired = true;
        }
      }
    }

    // c3. Retake limit (Z-39): attempt n+1 is allowed only while n < max_attempts + extras.
    //     Checked under the invitation row lock (non-embed); the unique key on
    //     (assessment, user, attempt_number) is the backstop for the embed path.
    //     Z-89: counts only attempts of the SAME test type, so a mock never uses up the real allowance.
    if (existing !== null) {
      const allowed = attemptsAllowed(assessment.max_attempts, extraAttempts);
      const used = await repo.countAttemptsByMode(client, input.assessmentId, input.userId, deliveryMode);
      if (used >= allowed) {
        throw new ConflictError(`All ${String(allowed)} allowed attempts are used`, {
          details: {
            code: AE_ERROR_CODES.ATTEMPTS_EXHAUSTED,
            attempts_used: used,
            attempts_allowed: allowed,
          },
        });
      }
    }

    // d. Resolve level for duration_minutes (timer source).
    const level = await qbRepo.findLevelById(client, assessment.level_id);
    if (level === null) {
      throw new NotFoundError(`Level not found: ${assessment.level_id}`, {
        details: { code: AE_ERROR_CODES.ASSESSMENT_NOT_ACTIVE },
      });
    }

    // e. Draw question pool — blueprint path (C3) or legacy path.
    //
    // BLUEPRINT PATH (C3):
    //   assessment.settings.blueprint present → per-criterion draw.
    //   For each criterion: filtered pool query (pack_id, level_id, domain_id,
    //   category_id, type, status='active') → Fisher-Yates (decision #20) →
    //   take criterion.count → concat all criteria → optional final shuffle.
    //   Defensive: if a criterion yields fewer than count at draw time (pool
    //   shrank post-publish), draw what is available and continue — log it;
    //   never crash an in-flight candidate. Domain/category came from write-time-
    //   guarded settings (C1 assertBlueprintFKOwnership) + runs inside withTenant
    //   RLS; defence-in-depth for cross-tenant integrity.
    //
    // NO-BLUEPRINT PATH (legacy, regression-critical):
    //   Existing full-pool listActiveQuestionPoolForPick → size check → shuffle
    //   → take N. Behaviour UNCHANGED — any modification here is a regression.

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blueprint = (assessment.settings as any)?.blueprint as
      | {
          domain_id: string;
          level: string;
          criteria: Array<{
            category_id?: string;
            node_id?: string;
            difficulty_min?: number;
            difficulty_max?: number;
            type: string;
            count: number;
          }>;
        }
      | undefined;

    let chosen: Array<{ id: string; version: number }>;

    // "Lock at assignment" (migration 0096) — ADDITIVE. If this assessment was
    // frozen at publish (assessment_frozen_pool has rows), draw from that frozen
    // snapshot so master-pack revisions / clone auto-sync never change an
    // already-published assessment's content. If it was NEVER frozen
    // (legacy/pre-0096 assessment), useFrozen is false and the existing live
    // queries run exactly as before — the un-frozen path is unchanged. The
    // frozen list helpers return the identical { id, version } shape and order,
    // so the shuffle/size-check/snapshot logic below is byte-for-byte the same.
    const useFrozen = (await repo.countFrozenPool(client, input.assessmentId)) > 0;

    // Test sections (migration 0132): the pool is partitioned per section, in section
    // order, and the resulting order is frozen. sectionOf[i] = section of chosen[i].
    const sections = readSections(assessment.settings);
    // Fail closed: configured but unreadable sections must not fall back to an unsectioned draw.
    const rawSections = (assessment.settings as { sections?: unknown } | null | undefined)?.sections;
    if (sections === null && Array.isArray(rawSections) && rawSections.length > 0) {
      throw new ValidationError("This test's sections are misconfigured. Ask your administrator.", {
        details: { code: AE_ERROR_CODES.SECTIONS_INVALID },
      });
    }
    let sectionOf: number[] | null = null;

    if (sections !== null) {
      const pool = await repo.listPoolWithCategory(client, {
        assessmentId: input.assessmentId,
        packId: assessment.pack_id,
        levelId: assessment.level_id,
        useFrozen,
      });
      const used = new Set<string>();
      const passageInfo = await repo.listPassageInfo(client, pool.map((q) => q.id)); // EXP-8
      chosen = [];
      sectionOf = [];
      for (const [si, s] of sections.entries()) {
        // Z-123: a node_id section draws by taxonomy descendants (imported questions have no category_id).
        const underNode = s.node_id !== undefined ? await repo.listQuestionIdsUnderNode(client, s.node_id, useFrozen ? input.assessmentId : undefined) : null;
        const cats = underNode === null && s.category_ids !== undefined ? new Set(s.category_ids) : null;
        const cand = pool.filter(
          (q) =>
            !used.has(q.id) &&
            (q.pack_id ?? assessment.pack_id) === (s.pack_id ?? assessment.pack_id) && // EXP-23: a section draws only from its own pack (NULL = old pool = the assessment pack)
            (underNode !== null
              ? underNode.has(q.id)
              : cats === null || (q.category_id !== null && cats.has(q.category_id))),
        );
        if (assessment.randomize) shuffleInPlace(cand);
        const n = s.question_count ?? cand.length;
        // EXP-8: whole passages only; a passage that does not fit the section is skipped whole.
        const taken = takeUnits(cand, n, passageInfo);
        if (taken.length < n) {
          throw new ValidationError(
            `Question pool too small for section "${s.name}": ${taken.length} < ${n}`,
            {
              details: {
                code: AE_ERROR_CODES.POOL_TOO_SMALL,
                section: s.name,
                available: taken.length,
                required: n,
              },
            },
          );
        }
        for (const q of taken) {
          used.add(q.id);
          chosen.push({ id: q.id, version: q.version });
          sectionOf.push(si);
        }
      }
    } else if (blueprint !== undefined) {
      // ── Blueprint draw (C3) ─────────────────────────────────────────────────
      const allPicks: Array<{ id: string; version: number }> = [];
      const bpInfo = new Map<string, PassageFact>(); // EXP-8

      for (const criterion of blueprint.criteria) {
        // Z-43: a node_id criterion with no category_id draws by taxonomy node (+ descendants).
        const scope =
          criterion.category_id === undefined && criterion.node_id !== undefined
            ? {
                nodeId: criterion.node_id,
                difficultyMin: criterion.difficulty_min,
                difficultyMax: criterion.difficulty_max,
              }
            : undefined;
        const criterionPool = useFrozen
          ? await repo.listFrozenPoolForCriterion(
              client,
              input.assessmentId,
              blueprint.domain_id,
              criterion.category_id,
              criterion.type,
              scope,
            )
          : await repo.listActiveQuestionPoolForCriterion(
              client,
              assessment.pack_id,
              assessment.level_id,
              blueprint.domain_id,
              criterion.category_id,
              criterion.type,
              scope,
            );

        const picks = [...criterionPool];
        shuffleInPlace(picks);

        const critInfo = await repo.listPassageInfo(client, picks.map((q) => q.id));
        for (const [k, v] of critInfo) bpInfo.set(k, v);
        // EXP-8: whole passages only (a passage counts as its number of children).
        const drawn = takeUnits(picks, criterion.count, critInfo);
        if (drawn.length < criterion.count) {
          // Pool shrank post-publish — draw what is available, continue (defensive).
          log.warn(
            {
              assessmentId: input.assessmentId,
              category_id: criterion.category_id,
              type: criterion.type,
              required: criterion.count,
              available: picks.length,
            },
            "startAttempt(blueprint): criterion pool shrank post-publish or passages do not pack into the count; drawing available subset",
          );
        }
        allPicks.push(...drawn);
      }

      // Optional final shuffle across all criteria (assessment.randomize still governs)
      if (assessment.randomize) {
        shuffleInPlace(allPicks);
      }
      // EXP-8: the final shuffle must not split a passage; no passages = unchanged order.
      chosen = bpInfo.size === 0 ? allPicks : groupUnits(allPicks, bpInfo).flat();
    } else {
      // ── Full-pool draw (no blueprint) ───────────────────────────────────────
      // Frozen snapshot when locked at publish; otherwise the UNCHANGED legacy
      // live-pool query (any modification to the live branch is a regression).
      const pool = useFrozen
        ? await repo.listFrozenPoolForPick(client, input.assessmentId)
        : await repo.listActiveQuestionPoolForPick(
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

      const picks = [...pool];
      if (assessment.randomize) {
        shuffleInPlace(picks);
      }
      // EXP-8: whole passages only. No passages in the pool = picks.slice(0, N) as before.
      chosen = takeUnits(picks, assessment.question_count, await repo.listPassageInfo(client, picks.map((q) => q.id)));
      if (chosen.length < assessment.question_count) {
        throw new ValidationError(
          `Question pool too small at start: ${chosen.length} < ${assessment.question_count}`,
          {
            details: {
              code: AE_ERROR_CODES.POOL_TOO_SMALL,
              available: chosen.length,
              required: assessment.question_count,
            },
          },
        );
      }
    }

    // g. Compute timer.
    const startedAt = new Date();
    // Z-134: one shared helper decides the length (also used by the candidate list and the take preview).
    const blueprintMarks = sections === null ? readBlueprintMarks(assessment.settings) : null;
    const durationSeconds = plannedDurationSeconds(
      assessment.settings,
      assessment.duration_minutes,
      level.duration_minutes,
    );
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
      embedOrigin: input.embedOrigin ?? false,
      attemptNumber: nextAttemptNumber,
      deliveryMode,
      ...(input.readiness !== undefined ? { readiness: input.readiness } : {}),
    });
    if (attempt === null) {
      // Lost a concurrent-Begin race (UNIQUE(assessment_id,user_id,attempt_number)): return the
      // winner's attempt, clock untouched.
      const winner = await repo.findAttemptByAssessmentAndUser(
        client,
        input.assessmentId,
        input.userId,
      );
      if (winner === null) throw new Error("startAttempt: unique violation but no attempt found");
      assertAttemptOwnedBy(winner, input.userId);
      return winner;
    }

    // h2. Camera: tie the agreed consent to this attempt (same tx; uploads check this link).
    if (cameraRequired && invitationId !== undefined) {
      await linkConsentToAttempt(client, invitationId, attempt.id);
    }

    // i. Snapshot the question set + empty answer rows.
    //
    // Per-student MCQ option shuffle (migration 0119): every attempt draws its own
    // option permutation for each eligible MCQ (option_order[display] = original
    // index); NULL = authored order (non-MCQ, or options that refer to each other —
    // "All of the above", "Both A and B" — see option-shuffle.ts). This is the ONLY
    // place attempt_questions rows are created — standard and embed starts both
    // arrive here — so every new attempt gets its order from this one site. Old and
    // in-flight attempts keep NULL. Follows assessments.randomize (default true), the
    // same switch as question order: randomize=false keeps the authored option order.
    const mcqOptions = assessment.randomize
      ? await repo.listMcqOptionsForPicks(client, chosen)
      : new Map<string, unknown>();
    // Ordering questions are ALWAYS shuffled (independent of `randomize`): the authored item
    // order is the answer key, so the candidate must never be shown it.
    const orderingKeys = await repo.listOrderingKeysForPicks(client, chosen);
    const chosenPassages = await repo.listPassageInfo(client, chosen.map((q) => q.id)); // EXP-8: frozen below
    const aqRows = chosen.map((q, i) => ({
      questionId: q.id,
      passageId: chosenPassages.get(q.id)?.passageId ?? null,
      position: i + 1,
      questionVersion: q.version,
      optionOrder: orderingKeys.has(q.id)
        ? buildOrderingOrder(orderingKeys.get(q.id)?.items, orderingKeys.get(q.id)?.correct_order)
        : buildOptionOrder(mcqOptions.get(q.id), Math.random, MAX_SHUFFLE_OPTIONS),
      sectionIndex: sectionOf !== null ? (sectionOf[i] as number) : null,
      // Z-42: marks of the section, frozen here. Absent = the question's own points / penalty as before.
      ...(sections !== null && sectionOf !== null && sections[sectionOf[i] as number]?.marks_per_question !== undefined
        ? {
            pointsOverride: sections[sectionOf[i] as number]!.marks_per_question as number,
            negativeOverride: sections[sectionOf[i] as number]!.negative_marks_per_question ?? 0,
          }
        : {}),
      // S42: blueprint marks per question, frozen here; the penalty stays the question's own / assessment default.
      ...(blueprintMarks !== null ? { pointsOverride: blueprintMarks } : {}),
    }));
    await repo.insertAttemptQuestions(client, attempt.id, aqRows, readNegativeMarksDefault(assessment.settings));
    await repo.insertEmptyAttemptAnswers(client, attempt.id, chosen.map((q) => q.id));

    // j. Mark invitation 'started' — skipped for embed-origin attempts (no invitation row).
    if (!input.embedOrigin && invitationId !== undefined) {
      await repo.markInvitationStarted(client, invitationId);
    }

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
// getTakePreview — read-only landing data; NEVER creates an attempt / starts
// the clock. The timer starts only when startAttempt runs (candidate clicks
// Begin on /take/:token).
// ===========================================================================

export interface TakePreview {
  existing: Attempt | null;
  questionCount: number;
  companyName: string;
  /** Logo L3a: tenant logo URL for the landing header; null when none or on any failure. */
  companyLogoUrl: string | null;
  /** Z-39: the attempt this page is about (the one in progress, or the next one) and how many are allowed. */
  attemptNumber: number;
  attemptsAllowed: number;
  /** Z-89: the invitation's test type, so the page can pick the right screen BEFORE start. */
  deliveryMode: "real" | "mock";
}

export async function getTakePreview(
  tenantId: string,
  input: StartAttemptInput,
): Promise<TakePreview> {
  const base = await loadTakePreview(tenantId, input);
  const branding = await getCompanyBranding(tenantId);
  return { ...base, companyLogoUrl: branding.logoUrl };
}

async function loadTakePreview(
  tenantId: string,
  input: StartAttemptInput,
): Promise<Omit<TakePreview, "companyLogoUrl">> {
  return withTenant(tenantId, async (client) => {
    const assessment = await alRepo.findAssessmentById(client, input.assessmentId);
    if (assessment === null) {
      throw new NotFoundError(`Assessment not found: ${input.assessmentId}`, {
        details: { code: AE_ERROR_CODES.ASSESSMENT_NOT_FOUND },
      });
    }
    const latest = await repo.findAttemptByAssessmentAndUser(
      client,
      input.assessmentId,
      input.userId,
    );
    if (latest !== null) assertAttemptOwnedBy(latest, input.userId);
    // Z-39: a finished attempt with attempts left is NOT "existing" - the landing offers the next attempt.
    const allowed = attemptsAllowed(
      assessment.max_attempts,
      await repo.getInvitationExtraAttempts(client, input.assessmentId, input.userId),
    );
    const deliveryMode = await repo.getInvitationDeliveryMode(client, input.assessmentId, input.userId);
    const used = await repo.countAttemptsByMode(client, input.assessmentId, input.userId, deliveryMode);
    const retakeOffered = latest !== null && !isUnfinished(latest.status) && used < allowed;
    const existing = retakeOffered ? null : latest;
    const attemptNumber = latest === null ? 1 : retakeOffered ? used + 1 : latest.attempt_number;
    if (existing === null && assessment.status !== "active") {
      throw new ConflictError(
        `Assessment must be 'active' to start an attempt (current: '${assessment.status}')`,
        { details: { code: AE_ERROR_CODES.ASSESSMENT_NOT_ACTIVE, status: assessment.status } },
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const criteria = (assessment.settings as any)?.blueprint?.criteria as
      | Array<{ count: number }>
      | undefined;
    const secs = readSections(assessment.settings);
    const questionCount = Array.isArray(criteria)
      ? criteria.reduce((n, c) => n + c.count, 0)
      : secs !== null && secs.every((s) => s.question_count !== undefined)
        ? secs.reduce((n, s) => n + (s.question_count as number), 0)
        : assessment.question_count;
    const tenant = await tenancyRepo.findTenantById(client, tenantId);
    return { existing, questionCount, companyName: tenant?.name?.trim() ?? "", attemptNumber, attemptsAllowed: allowed, deliveryMode };
  });
}

/**
 * Policy text version recorded with each Begin consent (bump when Terms/Privacy/AI-use copy changes).
 * 2026-10-02: the consent copy now says written answers are evaluated by AssessIQ
 * evaluators with AI assistance before the organisation releases results (platform
 * evaluation queue). Candidates who consented to the older text are asked again.
 */
export const TAKE_CONSENT_POLICY_VERSION = "2026-10-02";

export async function recordTakeConsent(
  tenantId: string,
  input: { userId: string; ip: string | null; userAgent: string | null },
): Promise<void> {
  await withTenant(tenantId, async (client) => {
    // Serialise per (tenant,user) so double-click / retry can't race past the
    // existence check; skip the INSERT when a row for this policy version exists.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `consent:${tenantId}:${input.userId}`,
    ]);
    if (
      await repo.hasConsentEvent(client, {
        userId: input.userId,
        policyVersion: TAKE_CONSENT_POLICY_VERSION,
      })
    ) {
      return;
    }
    await repo.insertConsentEvent(client, {
      tenantId,
      userId: input.userId,
      policyVersion: TAKE_CONSENT_POLICY_VERSION,
      ip: input.ip,
      userAgent: input.userAgent,
    });
  });
}

// ===========================================================================
// getAttemptForCandidate — server-authoritative view (timer + frozen Qs)
// ===========================================================================

export async function getAttemptForCandidate(
  tenantId: string,
  attemptId: string,
  userId: string,
): Promise<CandidateAttemptView & { company_name: string; company_logo_url: string | null }> {
  const view = await loadAttemptForCandidate(tenantId, attemptId, userId);
  // Logo L3a: co-branding for the attempt top bar. Never throws (null on failure).
  const branding = await getCompanyBranding(tenantId);
  return { ...view, company_name: branding.name, company_logo_url: branding.logoUrl };
}

async function loadAttemptForCandidate(
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
      attempt.ends_at.getTime() <= now.getTime() &&
      // A3-3: re-read under FOR UPDATE; a parallel submit may have finalised it.
      (await repo.findAttemptByIdForUpdate(client, attempt.id))?.status === "in_progress"
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
      await emitAttemptEventAfterCommit(client, tenantId, attempt.id, "attempt.submitted");
      // Same deterministic MCQ scoring as submitAttempt (no AI). After the
      // event insert so archetype signals see the auto_submit milestone.
      await scoreMcqAndFinalizeSafely(client, tenantId, attempt.id);
    }

    const questions = await repo.listFrozenQuestionsForAttempt(client, attempt.id);
    const answers = await repo.listAttemptAnswers(client, attempt.id);
    // Candidate-facing: serve shuffled MCQs in THIS attempt's order and the saved
    // selection as the displayed position. The order itself is never returned.
    const orders = await repo.listOptionOrders(client, attempt.id);

    // Integrity v1: read the runner switches from the assessment settings.
    const assessment = await alRepo.findAssessmentById(client, attempt.assessment_id);
    const integ = (assessment?.settings as { integrity?: { fullscreen?: unknown; block_copy_paste?: unknown } } | undefined)
      ?.integrity;

    // Test sections: while running, show ONLY the current section's questions and
    // answers (later sections stay hidden; finished ones are closed for good).
    let visibleQuestions = questions;
    let visibleAnswers = answers;
    let sectionsView: CandidateAttemptView["sections"];
    let sectionsSummary: CandidateAttemptView["sections_summary"];
    if (
      effectiveAttempt.status === "in_progress" &&
      questions.some((q) => (q.section_index ?? null) !== null)
    ) {
      const st = await sectionStateFor(client, effectiveAttempt, now);
      if (st !== null && st.pos !== null) {
        const cur = st.pos.current;
        const s = st.sections[cur] as AssessmentSection;
        const deadline = sectionDeadline(st.sections, st.pos);
        visibleQuestions = questions.filter((q) => q.section_index === cur);
        const ids = new Set(visibleQuestions.map((q) => q.question_id));
        visibleAnswers = answers.filter((a) => ids.has(a.question_id));
        sectionsSummary = buildSectionsSummary(st.sections, cur, questions, answers);
        sectionsView = {
          current: cur,
          total: st.sections.length,
          name: s.name,
          calculator: s.calculator === true,
          ends_at: deadline.toISOString(),
          remaining_seconds: Math.max(0, Math.floor((deadline.getTime() - now.getTime()) / 1000)),
        };
      }
    }

    // Z-42: whole-test mode has no `sections` view; send the names so the take page can group the navigator.
    const wholeSections = sectionsView === undefined ? readSections(assessment?.settings) : null;
    const sectionNames =
      wholeSections !== null && readWholeTestMinutes(assessment?.settings) !== null
        ? wholeSections.map((s) => s.name)
        : undefined;
    // FUT-4 / FUT-7 (read-only): the take page needs the flags. Absent for assessments without them.
    const timedSections = readSections(assessment?.settings);
    const sectionTiming =
      timedSections !== null && timedSections.some((s) => s.locked === true || s.seconds_per_question !== undefined)
        ? timedSections.map((s) => ({ locked: s.locked === true, seconds_per_question: s.seconds_per_question ?? null }))
        : undefined;

    return {
      attempt: effectiveAttempt,
      questions: displayQuestions(visibleQuestions, orders),
      answers: displayAnswers(
        visibleAnswers,
        orders,
        new Set(questions.filter((q) => shuffleFieldOf(q.type) === "items").map((q) => q.question_id)),
      ),
      remaining_seconds: computeRemainingSeconds(effectiveAttempt, now),
      integrity: {
        fullscreen: integ?.fullscreen === true,
        block_copy_paste: integ?.block_copy_paste === true,
      },
      ...(sectionsView !== undefined ? { sections: sectionsView } : {}),
      ...(sectionsSummary !== undefined ? { sections_summary: sectionsSummary } : {}),
      ...(sectionNames !== undefined ? { section_names: sectionNames } : {}),
      ...(sectionTiming !== undefined ? { section_timing: sectionTiming } : {}),
    };
  });
}

// ===========================================================================
// getAttemptIntegritySummary — admin card (counts only, never scores)
// ===========================================================================

export async function getAttemptIntegritySummary(
  tenantId: string,
  attemptId: string,
): Promise<AttemptIntegritySummary> {
  return withTenant(tenantId, async (client) => {
    const attempt = await repo.findAttemptById(client, attemptId);
    if (attempt === null) {
      throw new NotFoundError(`Attempt not found: ${attemptId}`, {
        details: { code: AE_ERROR_CODES.ATTEMPT_NOT_FOUND },
      });
    }
    return repo.countIntegrityEvents(client, attemptId);
  });
}

// ===========================================================================
// listAttemptsOnOlderVersions — EXP-12, read only, no rescoring
// ===========================================================================

export type AffectedReviewOutcome = "no_change_needed" | "needs_follow_up";

export interface AffectedAttemptItem {
  attempt_id: string;
  assessment_id: string;
  assessment_name: string;
  candidate_user_id: string;
  status: string;
  released: boolean;
  question_id: string;
  question_version: number;
  current_version: number;
  score_earned: number | null;
  score_max: number | null;
  submitted_at: string | null;
  review: { outcome: AffectedReviewOutcome; note: string | null; reviewed_by_name: string | null; reviewed_at: string } | null;
}

export interface AffectedAttempts {
  question_id: string;
  current_version: number;
  total: number;
  items: AffectedAttemptItem[];
}

const AFFECTED_ATTEMPTS_CAP = 200;
const FINISHED_STATUSES = ["submitted", "auto_submitted", "pending_admin_grading", "graded", "released"];

/** Finished attempts that froze an older version of the question (an answer-key correction made a newer one). Read only. */
export async function listAttemptsOnOlderVersions(
  tenantId: string,
  questionId: string,
  filter: { reviewed?: "yes" | "no" } = {},
): Promise<AffectedAttempts> {
  return withTenant(tenantId, async (client) => {
    await client.query("SET TRANSACTION READ ONLY");
    // RLS on questions: a question of another tenant reads as null.
    const q = await qbRepo.findQuestionById(client, questionId);
    if (q === null) {
      throw new NotFoundError(`Question not found: ${questionId}`, {
        details: { code: "QUESTION_NOT_FOUND" },
      });
    }
    const reviewedSql =
      filter.reviewed === "yes" ? "AND r.id IS NOT NULL" : filter.reviewed === "no" ? "AND r.id IS NULL" : "";
    const from = `
      FROM attempt_questions aq
      JOIN attempts a ON a.id = aq.attempt_id
      JOIN assessments s ON s.id = a.assessment_id
      LEFT JOIN affected_attempt_reviews r ON r.attempt_id = a.id AND r.question_id = aq.question_id
      WHERE aq.question_id = $1 AND aq.question_version < $2 AND a.status = ANY($3::text[]) ${reviewedSql}`;
    const params = [questionId, q.version, FINISHED_STATUSES];
    const total = await client.query<{ n: number }>(`SELECT count(*)::int AS n ${from}`, params);
    const rows = await client.query<{
      attempt_id: string;
      assessment_id: string;
      assessment_name: string;
      candidate_user_id: string;
      status: string;
      question_version: number;
      submitted_at: Date | null;
      score_earned: string | null;
      score_max: string | null;
      r_outcome: AffectedReviewOutcome | null;
      r_note: string | null;
      r_at: Date | null;
      r_by_name: string | null;
    }>(
      `SELECT a.id AS attempt_id, a.assessment_id, s.name AS assessment_name, a.user_id AS candidate_user_id,
              a.status, aq.question_version, a.submitted_at,
              g.score_earned, g.score_max,
              r.outcome AS r_outcome, r.note AS r_note, r.reviewed_at AS r_at, ru.name AS r_by_name
       FROM attempt_questions aq
       JOIN attempts a ON a.id = aq.attempt_id
       JOIN assessments s ON s.id = a.assessment_id
       LEFT JOIN affected_attempt_reviews r ON r.attempt_id = a.id AND r.question_id = aq.question_id
       LEFT JOIN users ru ON ru.id = r.reviewed_by
       LEFT JOIN LATERAL (SELECT score_earned, score_max FROM gradings
                          WHERE attempt_id = a.id AND question_id = aq.question_id
                          ORDER BY graded_at DESC, id LIMIT 1) g ON true
       WHERE aq.question_id = $1 AND aq.question_version < $2 AND a.status = ANY($3::text[]) ${reviewedSql}
       ORDER BY a.submitted_at DESC NULLS LAST, a.id
       LIMIT ${AFFECTED_ATTEMPTS_CAP}`,
      params,
    );
    return {
      question_id: questionId,
      current_version: q.version,
      total: total.rows[0]!.n,
      items: rows.rows.map((r) => ({
        attempt_id: r.attempt_id,
        assessment_id: r.assessment_id,
        assessment_name: r.assessment_name,
        candidate_user_id: r.candidate_user_id,
        status: r.status,
        released: r.status === "released",
        question_id: questionId,
        question_version: r.question_version,
        current_version: q.version,
        score_earned: r.score_earned === null ? null : Number(r.score_earned),
        score_max: r.score_max === null ? null : Number(r.score_max),
        submitted_at: r.submitted_at?.toISOString() ?? null,
        review:
          r.r_outcome === null
            ? null
            : { outcome: r.r_outcome, note: r.r_note, reviewed_by_name: r.r_by_name, reviewed_at: r.r_at!.toISOString() },
      })),
    };
  });
}

/**
 * EXP-12 wave 1: an admin marks one affected attempt as reviewed by hand. Writes ONLY affected_attempt_reviews
 * and one audit row (ids + outcome, never the note). No mark, status, certificate or report is touched.
 */
export async function setAffectedAttemptReview(
  tenantId: string,
  adminUserId: string,
  questionId: string,
  attemptId: string,
  input: { outcome: AffectedReviewOutcome; note?: string | null },
): Promise<{ outcome: AffectedReviewOutcome; reviewed_at: string }> {
  return withTenant(tenantId, async (client) => {
    const q = await qbRepo.findQuestionById(client, questionId);
    if (q === null) {
      throw new NotFoundError(`Question not found: ${questionId}`, { details: { code: "QUESTION_NOT_FOUND" } });
    }
    // RLS scopes attempts to the tenant, so a foreign attempt reads as no row.
    const aq = await client.query<{ question_version: number }>(
      `SELECT aq.question_version FROM attempt_questions aq JOIN attempts a ON a.id = aq.attempt_id
       WHERE aq.attempt_id = $1 AND aq.question_id = $2 AND a.status = ANY($3::text[])`,
      [attemptId, questionId, FINISHED_STATUSES],
    );
    if (aq.rows.length === 0) {
      throw new NotFoundError("Affected attempt not found", { details: { code: "AFFECTED_ATTEMPT_NOT_FOUND" } });
    }
    const used = aq.rows[0]!.question_version;
    if (used >= q.version) {
      throw new ConflictError("The attempt used the current version of this question", {
        details: { code: "ATTEMPT_NOT_ON_OLDER_VERSION" },
      });
    }
    const res = await client.query<{ reviewed_at: Date }>(
      `INSERT INTO affected_attempt_reviews
         (tenant_id, question_id, attempt_id, question_version_used, current_version, outcome, note, reviewed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, question_id, attempt_id) DO UPDATE SET
         question_version_used = EXCLUDED.question_version_used, current_version = EXCLUDED.current_version,
         outcome = EXCLUDED.outcome, note = EXCLUDED.note, reviewed_by = EXCLUDED.reviewed_by, reviewed_at = now()
       RETURNING reviewed_at`,
      [tenantId, questionId, attemptId, used, q.version, input.outcome, input.note ?? null, adminUserId],
    );
    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: adminUserId,
      action: "question.affected_attempt.reviewed",
      entityType: "attempt",
      entityId: attemptId,
      after: { question_id: questionId, outcome: input.outcome, question_version_used: used, current_version: q.version },
    });
    return { outcome: input.outcome, reviewed_at: res.rows[0]!.reviewed_at.toISOString() };
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
    // Row lock: serialise with submit/auto-submit so a save can't land after
    // the status flip + MCQ scoring (status is re-read under the lock).
    const attempt = await repo.findAttemptByIdForUpdate(client, input.attemptId);
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

    // Test sections: a finished (or not-yet-open) section is read-only.
    await assertSectionOpen(client, attempt, aq.section_index, now);
    // FUT-7: the question's own time may be up.
    await assertQuestionTimeOpen(client, attempt, input.questionId, aq.section_index, now);

    const incomingRevision = input.client_revision ?? 0;

    // Scenario answers must be {steps:[{stepIndex, response}]} (see checkAnswerForSave).
    const savedType = input.answer === null ? null : await repo.findQuestionType(client, input.questionId, aq.question_version);
    const checked = checkAnswerForSave(
      savedType,
      input.answer,
      savedType !== null && isQuestionType(savedType) && QUESTION_TYPE_REGISTRY[savedType].checkAnswer !== undefined // ponytail: types with a save-time check get the frozen content (one extra read for scenario)
        ? await repo.findFrozenContent(client, input.questionId, aq.question_version)
        : undefined,
    );
    if (!checked.ok) {
      throw new ValidationError(`answer does not have the shape of a ${savedType ?? "scenario"} answer`, {
        details: { code: AE_ERROR_CODES.INVALID_PARAM, param: "answer" },
      });
    }

    if (answerTextLength(checked.answer) > MAX_ANSWER_CHARS) {
      throw new ValidationError(`answer is longer than ${MAX_ANSWER_CHARS} characters`, {
        details: { code: "ANSWER_TOO_LONG", param: "answer", limit: MAX_ANSWER_CHARS },
      });
    }

    // Shuffled MCQ: the candidate sent the DISPLAYED index; store the ORIGINAL index
    // so scoring, admin review, exports and analytics stay in original-index space.
    // An out-of-range / malformed answer is stored exactly as sent (as before the
    // shuffle) and still scores 0 — a translation never makes an invalid answer valid.
    const order = usableOrder(aq.option_order);
    const answerKey =
      order !== null && (await repo.listOrderingQuestionIds(client, input.attemptId)).has(input.questionId)
        ? "order"
        : "selected";
    const answer = order === null ? checked.answer : answerToOriginal(checked.answer, order, answerKey);

    const repoInput: Parameters<typeof repo.saveAttemptAnswer>[1] = {
      attemptId: input.attemptId,
      questionId: input.questionId,
      answer,
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
    // Row lock: assertSectionOpen and assertQuestionTimeOpen below can write section_progress, as in saveAnswer.
    const attempt = await repo.findAttemptByIdForUpdate(client, input.attemptId);
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

    const now = new Date();
    if (attempt.ends_at !== null && attempt.ends_at.getTime() <= now.getTime()) {
      throw new ConflictError("Timer has expired", {
        details: { code: AE_ERROR_CODES.TIMER_EXPIRED },
      });
    }
    await assertSectionOpen(client, attempt, aq.section_index, now);
    await assertQuestionTimeOpen(client, attempt, input.questionId, aq.section_index, now);

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
// finishSection — candidate ends the running section early (no way back)
// ===========================================================================

/**
 * Opens the next section NOW. The whole test's end moves earlier accordingly
 * (attempts.ends_at = now + the minutes of the sections still to come), so the
 * sweep and the expiry checks stay correct. Finishing the LAST section is a
 * normal submit, not this call.
 */
export async function finishSection(
  tenantId: string,
  userId: string,
  attemptId: string,
): Promise<{ section_index: number }> {
  return withTenant(tenantId, async (client) => {
    const attempt = await repo.findAttemptByIdForUpdate(client, attemptId);
    if (attempt === null) {
      throw new NotFoundError(`Attempt not found: ${attemptId}`, {
        details: { code: AE_ERROR_CODES.ATTEMPT_NOT_FOUND },
      });
    }
    assertAttemptOwnedBy(attempt, userId);
    if (attempt.status !== "in_progress") {
      throw new ConflictError(`Attempt ${attempt.id} is not writable (status: ${attempt.status})`, {
        details: { code: AE_ERROR_CODES.WRITES_LOCKED, status: attempt.status },
      });
    }
    const now = new Date();
    if (attempt.ends_at !== null && attempt.ends_at.getTime() <= now.getTime()) {
      throw new ConflictError("Timer has expired", {
        details: { code: AE_ERROR_CODES.TIMER_EXPIRED },
      });
    }
    const st = await sectionStateFor(client, attempt, now);
    if (st === null || st.pos === null || st.pos.current >= st.sections.length - 1) {
      throw new ConflictError("There is no later section to move to", {
        details: { code: AE_ERROR_CODES.SECTION_NOT_FINISHABLE },
      });
    }
    const next = st.pos.current + 1;
    const prev = await repo.getSectionProgress(client, attempt.id);
    await repo.setSectionProgress(
      client,
      attempt.id,
      { ...(prev ?? {}), current: next, started_at: now.toISOString() },
      new Date(now.getTime() + totalSectionSeconds(st.sections, next) * 1000),
    );
    return { section_index: next };
  });
}

// ===========================================================================
// recordPosition — FUT-4 / FUT-7: the take page reports where the candidate is
// ===========================================================================

/**
 * Free movement: `section_index` = the candidate entered that section (closes a locked block
 * they leave). `question_id` = the candidate viewed that question (starts its own timer, if the
 * section has one). Returns when the question's time ends, or null.
 */
export async function recordPosition(
  tenantId: string,
  userId: string,
  attemptId: string,
  input: { section_index?: number; question_id?: string },
): Promise<{ question_ends_at: string | null }> {
  return withTenant(tenantId, async (client) => {
    const attempt = await repo.findAttemptByIdForUpdate(client, attemptId);
    if (attempt === null) {
      throw new NotFoundError(`Attempt not found: ${attemptId}`, {
        details: { code: AE_ERROR_CODES.ATTEMPT_NOT_FOUND },
      });
    }
    assertAttemptOwnedBy(attempt, userId);
    if (attempt.status !== "in_progress") {
      throw new ConflictError(`Attempt ${attempt.id} is not writable (status: ${attempt.status})`, {
        details: { code: AE_ERROR_CODES.WRITES_LOCKED, status: attempt.status },
      });
    }
    const now = new Date();
    if (attempt.ends_at !== null && attempt.ends_at.getTime() <= now.getTime()) {
      throw new ConflictError("Timer has expired", {
        details: { code: AE_ERROR_CODES.TIMER_EXPIRED },
      });
    }

    if (input.section_index !== undefined) {
      const assessment = await alRepo.findAssessmentById(client, attempt.assessment_id);
      const sections = readSections(assessment?.settings);
      if (
        sections === null ||
        readWholeTestMinutes(assessment?.settings) === null ||
        sections[input.section_index] === undefined
      ) {
        throw new ConflictError("This section cannot be entered", {
          details: { code: AE_ERROR_CODES.SECTION_NOT_ENTERABLE, section_index: input.section_index },
        });
      }
      await assertFreeMovementSection(client, attempt, input.section_index, now);
    }

    let questionEndsAt: Date | null = null;
    if (input.question_id !== undefined) {
      const aq = await repo.findAttemptQuestion(client, attemptId, input.question_id);
      if (aq === null) {
        throw new NotFoundError(`Question ${input.question_id} not in attempt ${attemptId}`, {
          details: { code: AE_ERROR_CODES.UNKNOWN_QUESTION },
        });
      }
      if (aq.section_index !== null) {
        questionEndsAt = await questionDeadline(client, attempt, input.question_id, aq.section_index, now);
      }
    }
    return { question_ends_at: questionEndsAt?.toISOString() ?? null };
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
  if (!KNOWN_EVENT_TYPES.has(input.event_type as EventType) || SERVER_ONLY_EVENT_TYPES.has(input.event_type)) {
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
    const attempt = await repo.findAttemptByIdForUpdate(client, attemptId);
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
    await emitAttemptEventAfterCommit(client, tenantId, attemptId, "attempt.submitted");

    // Deterministic MCQ scoring (no AI call — compliant with the no-ambient-AI
    // rule). MCQ-only attempts are finalised (graded + billed) in this same tx;
    // mixed attempts just get their MCQ gradings rows. Nothing is returned to
    // the candidate about correctness.
    await scoreMcqAndFinalizeSafely(client, tenantId, attemptId);

    return { attempt: updated, status: "submitted" };
  });
}

/**
 * GATE-8 A3-2: an admin ended the candidate's attempt (invitation revoke). Same submit-and-grade as a
 * candidate submit, inside the caller's transaction: answers already saved are scored (MCQ) and an MCQ-only
 * attempt is finalised, so the marks earned are kept. The invitation row stays as the caller set it (expired).
 * No-op when the attempt is not in_progress.
 */
export async function submitAttemptForRevokeInTx(
  client: PoolClient,
  tenantId: string,
  attemptId: string,
): Promise<void> {
  const attempt = await repo.findAttemptByIdForUpdate(client, attemptId);
  if (attempt === null || attempt.status !== "in_progress") return;
  await repo.updateAttemptStatus(client, attemptId, { status: "submitted", submittedAt: new Date() });
  await emitAttemptEventAfterCommit(client, tenantId, attemptId, "attempt.submitted");
  await scoreMcqAndFinalizeSafely(client, tenantId, attemptId);
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
    // Owner-facing read: same display-space translation as the candidate view.
    const answers = await repo.listAttemptAnswers(client, attemptId);
    return displayAnswers(
      answers,
      await repo.listOptionOrders(client, attemptId),
      await repo.listOrderingQuestionIds(client, attemptId),
    );
  });
}

// ===========================================================================
// sweepStaleTimers — pure logic, callable by future apps/worker BullMQ job
// ===========================================================================

export interface SweepResult {
  autoSubmitted: number;
  attemptIds: string[];
}

/** Active tenants with at least one expired in_progress attempt (one cross-tenant query). */
export async function listTenantsWithExpiredAttempts(now: Date): Promise<string[]> {
  return withSystemRole("timer-sweep: tenants with expired attempts", (client) =>
    repo.listTenantsWithExpiredAttempts(client, now),
  );
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
      await emitAttemptEventAfterCommit(client, tenantId, attemptId, "attempt.submitted");
      // Same deterministic MCQ scoring as submitAttempt (no AI). After the
      // event insert so archetype signals see the auto_submit milestone.
      await scoreMcqAndFinalizeSafely(client, tenantId, attemptId);
    }

    log.info(
      { tenantId, autoSubmitted: count, attemptIds: ids },
      "sweepStaleTimers.autoSubmitted",
    );
    return { autoSubmitted: count, attemptIds: ids };
  });
}
