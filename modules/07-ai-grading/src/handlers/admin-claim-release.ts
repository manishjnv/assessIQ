/**
 * Handlers: GET /admin/attempts/:attemptId (page-load claim) and
 *           POST /admin/attempts/:attemptId/release
 *
 * Phase 2 G2.A Session 1.b — service-layer handlers (no Fastify req/reply).
 *
 * Decision references:
 *   D3 — Claim transitions attempts.status from 'submitted' →
 *        'pending_admin_grading' (idempotent). No grading_jobs in Phase 1.
 *   D8 — Release transitions 'graded' → 'released'. This is the admin
 *        confirming the candidate can see results. Triggers result-released
 *        notification via module 13 (attempted safely, never blocks on failure).
 *
 * Cross-module SQL note:
 *   @assessiq/attempt-engine is NOT in this package's deps. Inline SQL via
 *   withTenant() — RLS on attempts, attempt_answers, attempt_questions,
 *   question_versions, gradings all enforce tenant isolation.
 *
 * Module 13 notification:
 *   Imported via dynamic try/catch. The module may not exist yet — we log a
 *   warning rather than throwing. The candidate sees results on next reload;
 *   email is best-effort.
 */

import { AppError, streamLogger } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { findGradingsForAttempt } from "../repository.js";
import { AI_GRADING_ERROR_CODES } from "../types.js";
import type { GradingsRow } from "../types.js";
import type { PoolClient } from "pg";

const log = streamLogger("grading");

// ---------------------------------------------------------------------------
// Local type aliases to avoid @assessiq/attempt-engine dep
// ---------------------------------------------------------------------------

// Re-export compatible shapes using local definitions
export interface AttemptAnswerRow {
  attempt_id: string;
  question_id: string;
  answer: unknown | null;
  flagged: boolean;
  time_spent_seconds: number;
  edits_count: number;
  client_revision: number;
  saved_at: Date | null;
}

export interface FrozenQuestionRow {
  question_id: string;
  position: number;
  question_version: number;
  type: string;
  topic: string;
  points: number;
  content: unknown;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HandleAdminClaimAttemptOutput {
  attempt: { id: string; status: string };
  answers: AttemptAnswerRow[];
  frozen_questions: FrozenQuestionRow[];
  gradings: GradingsRow[];
}

export interface HandleAdminReleaseAttemptOutput {
  attempt: { id: string; status: "released" };
}

// ---------------------------------------------------------------------------
// Helpers — inline SQL loaders
// ---------------------------------------------------------------------------

async function loadAnswers(
  client: PoolClient,
  attemptId: string,
): Promise<AttemptAnswerRow[]> {
  const result = await client.query<AttemptAnswerRow>(
    `SELECT attempt_id, question_id, answer, flagged,
            time_spent_seconds, edits_count, client_revision, saved_at
     FROM attempt_answers
     WHERE attempt_id = $1
     ORDER BY question_id ASC`,
    [attemptId],
  );
  return result.rows;
}

async function loadFrozenQuestions(
  client: PoolClient,
  attemptId: string,
): Promise<FrozenQuestionRow[]> {
  // rubric column intentionally excluded — this read is for display;
  // rubric is served only by the grading code path
  const result = await client.query<FrozenQuestionRow>(
    `SELECT
       aq.question_id,
       aq.position,
       aq.question_version,
       q.type,
       q.topic,
       q.points,
       qv.content
     FROM attempt_questions aq
     JOIN questions q ON q.id = aq.question_id
     JOIN question_versions qv
       ON qv.question_id = aq.question_id
      AND qv.version    = aq.question_version
     WHERE aq.attempt_id = $1
     ORDER BY aq.position ASC, aq.question_id ASC`,
    [attemptId],
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Page-load handler for /admin/attempts/:id.
 *
 * Idempotently transitions attempts.status from 'submitted' to
 * 'pending_admin_grading', then loads answers + frozen_questions + gradings.
 * Second call (status already 'pending_admin_grading') is a no-op on the
 * UPDATE, but still returns the full page data.
 */
export async function handleAdminClaimAttempt(input: {
  tenantId: string;
  userId: string;
  attemptId: string;
}): Promise<HandleAdminClaimAttemptOutput> {
  const { tenantId, attemptId } = input;

  return withTenant(tenantId, async (client) => {
    // Idempotent claim: transitions 'submitted' → 'pending_admin_grading'.
    // No-op when already 'pending_admin_grading' (rowCount = 0 is fine).
    await client.query(
      `UPDATE attempts
       SET status = 'pending_admin_grading'
       WHERE id = $1 AND status = 'submitted'`,
      [attemptId],
    );

    // Read current status
    const statusResult = await client.query<{ status: string }>(
      `SELECT status FROM attempts WHERE id = $1 LIMIT 1`,
      [attemptId],
    );
    const statusRow = statusResult.rows[0];
    if (statusRow === undefined) {
      throw new AppError(
        `Attempt ${attemptId} not found`,
        AI_GRADING_ERROR_CODES.ATTEMPT_NOT_FOUND,
        404,
      );
    }

    const [answers, frozen_questions, gradings] = await Promise.all([
      loadAnswers(client, attemptId),
      loadFrozenQuestions(client, attemptId),
      findGradingsForAttempt(client, attemptId),
    ]);

    return {
      attempt: { id: attemptId, status: statusRow.status },
      answers,
      frozen_questions,
      gradings,
    };
  });
}

/**
 * Release handler: transitions 'graded' → 'released'.
 *
 * Triggers 13-notifications.sendResultReleasedEmail if the module is
 * available. Notification failure is logged but does NOT block the release —
 * the candidate can see results on next reload; email is best-effort.
 */
export async function handleAdminReleaseAttempt(input: {
  tenantId: string;
  userId: string;
  attemptId: string;
}): Promise<HandleAdminReleaseAttemptOutput> {
  const { tenantId, attemptId } = input;

  await withTenant(tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      `UPDATE attempts
       SET status = 'released'
       WHERE id = $1 AND status = 'graded'
       RETURNING id`,
      [attemptId],
    );
    if (result.rowCount === 0) {
      // Either not found (RLS filters it) or wrong status
      const check = await client.query<{ status: string }>(
        `SELECT status FROM attempts WHERE id = $1 LIMIT 1`,
        [attemptId],
      );
      const row = check.rows[0];
      if (row === undefined) {
        throw new AppError(
          `Attempt ${attemptId} not found`,
          AI_GRADING_ERROR_CODES.ATTEMPT_NOT_FOUND,
          404,
        );
      }
      throw new AppError(
        `Attempt is in status '${row.status}' — must be 'graded' to release`,
        AI_GRADING_ERROR_CODES.ATTEMPT_NOT_GRADEABLE,
        422,
      );
    }
  });

  // Best-effort notification — module 13 may not exist yet.
  // Dynamic import via Function constructor avoids a hard static import that
  // would fail TS compilation when the module is absent. The indirection also
  // keeps the D2 lint clean: this file does not statically reference any
  // grading runtime symbol.
  try {
    const importFn = new Function(
      "specifier",
      "return import(specifier)",
    ) as (s: string) => Promise<unknown>;
    const notifications = (await importFn("@assessiq/notifications").catch(
      () => null,
    )) as { sendResultReleasedEmail?: (args: { tenantId: string; attemptId: string }) => Promise<void> } | null;

    if (
      notifications !== null &&
      typeof notifications.sendResultReleasedEmail === "function"
    ) {
      await notifications
        .sendResultReleasedEmail({ tenantId, attemptId })
        .catch((notifErr: unknown) => {
          log.warn(
            { attemptId, error: String(notifErr) },
            "grading.release.notification_failed",
          );
        });
    }
  } catch {
    log.warn(
      { attemptId },
      "grading.release.notifications_module_unavailable",
    );
  }

  log.info({ attemptId }, "grading.release.complete");

  return { attempt: { id: attemptId, status: "released" } };
}
