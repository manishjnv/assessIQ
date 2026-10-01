// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./fastify.d.ts" />
// AssessIQ — modules/07-ai-grading Fastify route registrar (TENANT admin surface).
//
// Mounts the tenant admin endpoints under /api/admin/* per docs/03-api-contract.md
// § "Admin — Grading & review". This file is the THIN route layer only:
// validate → dispatch → return. No business logic lives here.
//
// Phase II (2026-10-01) — platform evaluation queue. AI evaluation is run ONLY by
// the platform super admin (routes-super.ts, mounted by apps/api
// routes/admin-super-evaluations.ts). The tenant routes that used to grade
// (grade / accept / rerun / manual-score / grading-jobs retry) are kept so a stale
// client gets a clear, stable answer: 403 AI_EVALUATION_BY_ASSESSIQ for everyone.
// Tenants review released evaluations, override a score (only after the platform
// released it), send it back, and publish.
//
// Auth chains are injected via RegisterGradingRoutesOptions (DI shape identical
// to modules/04-question-bank, modules/05-assessment-lifecycle, and
// modules/06-attempt-engine) so this module stays Fastify-shape-compatible
// without coupling to apps/api internals.
//
// Multi-tenancy guard: tenantId is ALWAYS read from req.session — never from
// the request body. Hard rule per CLAUDE.md § AssessIQ-specific hard rules #4.
// (The platform routes are the one deliberate exception: they resolve the
// attempt's tenant from the DB — see routes-super.ts.)
//
// Errors flow through the global Fastify error handler in apps/api/src/server.ts;
// this layer throws ValidationError from @assessiq/core on bad input and does
// NOT try/catch service throws (AppError subclasses are caught by the global
// error handler and mapped to HTTP).

import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { AppError, ValidationError } from "@assessiq/core";
import { AnchorFindingSchema, BandFindingSchema, AI_GRADING_ERROR_CODES } from "./types.js";

import { handleAdminOverride } from "./handlers/admin-override.js";
import { handleAdminSendBack } from "./handlers/admin-send-back.js";
import { handleAdminQueue } from "./handlers/admin-queue.js";
import { handleAdminClaimAttempt, handleAdminReleaseAttempt } from "./handlers/admin-claim-release.js";
import { handleAdminReleaseAll } from "./handlers/admin-release-all.js";
import { handleAdminListGradingJobs } from "./handlers/admin-grading-jobs.js";
import { handleAdminBudget } from "./handlers/admin-budget.js";
import { handleAdminListAttempts } from "./handlers/admin-attempts-list.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RegisterGradingRoutesOptions {
  /**
   * Admin-gated preHandler chain — `authChain({ roles: ['admin'] })` from
   * apps/api. Mirrors the DI shape used by modules/04-question-bank and
   * modules/06-attempt-engine so this module stays Fastify-shape-compatible
   * without a hard apps/api dependency.
   */
  adminOnly: preHandlerHookHandler[] | preHandlerHookHandler;

  /**
   * Admin + fresh-MFA chain — `authChain({ roles: ['admin'], freshMfaWithinMinutes: 5 })`.
   * Required by POST /api/admin/gradings/:id/override per D8 and
   * docs/05-ai-pipeline.md § "Override requires fresh MFA (5min)".
   */
  adminFreshMfa: preHandlerHookHandler[] | preHandlerHookHandler;
}

// ---------------------------------------------------------------------------
// Inline Zod schemas
//
// Each schema is defined at module level so it is constructed once and reused
// across requests. `safeParse` is used instead of `parse` so we can throw
// ValidationError with structured `issues` rather than a raw ZodError.
// ---------------------------------------------------------------------------

// The body schemas below are shared with routes-super.ts (the platform evaluator's
// routes validate the same contracts); they are exported for that reason only.

/**
 * POST …/grade — no required body.
 * Optional `override_skill` for future skill-selection (reserved, not used in Phase 1).
 */
export const GRADE_BODY_SCHEMA = z.object({
  override_skill: z.enum(["anchors", "band", "escalate"]).optional(),
}).strict();

/**
 * AcceptEdits schema — matches AcceptEdits in handlers/admin-accept.ts.
 * `question_id` is required so the handler knows which question the edit applies to.
 */
const ACCEPT_EDITS_SCHEMA = z.object({
  question_id: z.string().uuid(),
  reasoning_band: z.number().int().min(0).max(4).optional(),
  ai_justification: z.string().optional(),
  anchor_hits: z.array(AnchorFindingSchema).optional(),
  error_class: z.string().nullable().optional(),
  score_earned: z.number().optional(),
});

/**
 * POST /api/admin/attempts/:id/accept — array of GradingProposal-shaped objects
 * with an optional `edits` field for admin corrections.
 *
 * The schema mirrors GradingProposalSchema from types.ts extended with `edits`.
 * The handler merges edits onto the AI proposal before writing the `gradings` row.
 */
const PROPOSAL_WITH_EDITS_SCHEMA = z.object({
  attempt_id: z.string().uuid(),
  question_id: z.string().uuid(),
  anchors: z.array(AnchorFindingSchema),
  band: BandFindingSchema,
  score_earned: z.number(),
  score_max: z.number(),
  prompt_version_sha: z.string(),
  prompt_version_label: z.string(),
  model: z.string(),
  escalation_chosen_stage: z.enum(["2", "3", "manual"]).nullable(),
  generated_at: z.string().datetime(),
  edits: ACCEPT_EDITS_SCHEMA.optional(),
});

// Exported so the FE accept-contract regression test
// (__tests__/accept-contract.test.ts) can validate FE-shape payloads against
// the exact backend schema. Prevents recurrence of the 2026-05-26 contract
// drift where the UI sent `{question_id}` and silently 422'd.
export const ACCEPT_BODY_SCHEMA = z.object({
  proposals: z.array(PROPOSAL_WITH_EDITS_SCHEMA).min(1),
});

/**
 * POST /api/admin/gradings/:id/override (tenant) and
 * POST /api/admin/super/evaluations/:attemptId/gradings/:gradingId/override (platform)
 * — manual score correction. `reason` is mandatory so every override has an audit trail.
 */
export const OVERRIDE_BODY_SCHEMA = z.object({
  score_earned: z.number(),
  reasoning_band: z.number().int().min(0).max(4).optional(),
  ai_justification: z.string().optional(),
  error_class: z.string().nullable().optional(),
  reason: z.string().min(1),
});

/**
 * POST …/questions/:questionId/manual-score (platform evaluator only) — first human
 * score for a question that has no grading yet (KQL, or any ungraded question).
 * `reason` is mandatory (stored on the immutable gradings row, never in audit).
 * The upper bound (score_max = questions.points) is enforced by the handler.
 */
export const MANUAL_SCORE_BODY_SCHEMA = z
  .object({
    score_earned: z.number().finite().min(0),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const UUID_SCHEMA = z.string().uuid();

/**
 * POST …/rerun (platform evaluator only) — force a fresh grading run.
 * `forceEscalate` is not set by default (standard automatic escalation).
 */
export const RERUN_BODY_SCHEMA = z.object({
  forceEscalate: z.boolean().optional(),
}).strict();

/**
 * POST /api/admin/attempts/:id/send-back — tenant returns a released evaluation to the
 * platform queue. The note is stored on attempts.evaluation_note, never in audit.
 */
const SEND_BACK_BODY_SCHEMA = z
  .object({
    note: z.string().trim().min(1).max(500),
  })
  .strict();

/**
 * GET /api/admin/dashboard/queue — optional query-string filters.
 */
const QUEUE_QUERY_SCHEMA = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * GET /api/admin/attempts — paged, optionally status-filtered attempt list.
 *
 * `status` uses z.enum (not z.string) to close the SQL-injection vector at
 * the parser layer — only the 5 FE-visible statuses are accepted; draft,
 * in_progress, and cancelled are intentionally excluded (admin list shows
 * actionable and completed attempts only).
 *
 * `limit` is clamped to [1, 100]; `offset` to [0, ∞). Defaults match the FE
 * default call of limit=100 / no offset.
 */
const LIST_ATTEMPTS_QUERY_SCHEMA = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  // max(10_000) caps offset to prevent DoS via a giant OFFSET forcing a full
  // index scan per request. FE never paginates past ~100 anyway.
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
  status: z
    .enum([
      "submitted",
      "pending_admin_grading",
      "graded",
      "released",
      "auto_submitted",
    ])
    .optional(),
});

// ---------------------------------------------------------------------------
// Helper — normalise preHandler to always be an array.
//
// Fastify accepts both a single hook and an array. Our DI options declare
// `T | T[]` so callers can pass either. This helper normalises to array so
// every `{ preHandler: ... }` config is uniform.
// ---------------------------------------------------------------------------

function toArray<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v];
}

// ---------------------------------------------------------------------------
// Helper — convert ISO-8601 session timestamp to Date for handler heartbeat check.
//
// The Session type stores lastSeenAt as an ISO-8601 string; handler signatures
// take `Date | null`. A parse failure (malformed string in the session store)
// falls back to null so the handler rejects with HEARTBEAT_STALE rather than
// crashing.
// ---------------------------------------------------------------------------

export function parseSessionActivity(lastSeenAt: string): Date | null {
  const d = new Date(lastSeenAt);
  return isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

/**
 * Tenant routes that used to run or commit AI evaluation. Phase II: AssessIQ's
 * platform evaluator does that, from the super-admin queue — these answer 403 for
 * every caller (the admin chain still runs first, so anonymous callers still get 401).
 */
const AI_EVALUATION_ROUTES = [
  "/api/admin/attempts/:id/grade",
  "/api/admin/attempts/:id/accept",
  "/api/admin/attempts/:id/rerun",
  "/api/admin/attempts/:id/questions/:questionId/manual-score",
  "/api/admin/grading-jobs/:id/retry",
] as const;

export async function registerGradingRoutes(
  app: FastifyInstance,
  opts: RegisterGradingRoutesOptions,
): Promise<void> {
  const adminOnly = toArray(opts.adminOnly);
  const adminFreshMfa = toArray(opts.adminFreshMfa);

  // -------------------------------------------------------------------------
  // POST grade | accept | rerun | manual-score | grading-jobs/:id/retry
  //
  // 403 AI_EVALUATION_BY_ASSESSIQ — see AI_EVALUATION_ROUTES. No handler is
  // reachable from here, so no tenant request can start an AI run (D2/D7 stay
  // admin-click-only: the clicker is now the platform super admin).
  // -------------------------------------------------------------------------

  for (const url of AI_EVALUATION_ROUTES) {
    app.post(url, { preHandler: adminOnly }, async () => {
      throw new AppError(
        "AI evaluation is performed by AssessIQ. Your results are released to you for review and publishing once they have been evaluated.",
        AI_GRADING_ERROR_CODES.AI_EVALUATION_BY_ASSESSIQ,
        403,
      );
    });
  }

  // -------------------------------------------------------------------------
  // POST /api/admin/attempts/:id/send-back
  //
  // The tenant returns a released (unpublished) evaluation to the platform queue
  // with a note. Clears evaluation_released_at; status stays 'graded' (no
  // re-billing); audit grading.sent_back without the note. 409 unless the
  // evaluation is currently with the tenant. Admin chain, no fresh MFA — same as
  // publishing (it only withdraws a result from publication).
  // -------------------------------------------------------------------------

  app.post(
    "/api/admin/attempts/:id/send-back",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id: attemptId } = req.params as { id: string };

      if (!UUID_SCHEMA.safeParse(attemptId).success) {
        throw new ValidationError("id must be a UUID", {
          details: { code: AI_GRADING_ERROR_CODES.INVALID_BODY, param: "id" },
        });
      }
      const result = SEND_BACK_BODY_SCHEMA.safeParse(req.body);
      if (!result.success) {
        throw new ValidationError("Invalid send-back body", {
          details: {
            code: AI_GRADING_ERROR_CODES.INVALID_BODY,
            issues: result.error.issues,
          },
        });
      }

      return handleAdminSendBack({ tenantId, userId, attemptId, note: result.data.note });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/attempts
  //
  // Returns the tenant-scoped paged list of attempts for the admin dashboard.
  // Registered BEFORE /api/admin/attempts/:id so the literal route wins on
  // Fastify's radix-tree match (no ambiguity even though Fastify prefers
  // literals, explicit ordering removes any router-version risk).
  //
  // Status filter uses z.enum — only the 5 FE-visible statuses are accepted;
  // draft/in_progress/cancelled are intentionally excluded.
  // -------------------------------------------------------------------------

  app.get(
    "/api/admin/attempts",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;

      const parsed = LIST_ATTEMPTS_QUERY_SCHEMA.safeParse(req.query);
      if (!parsed.success) {
        throw new ValidationError("Invalid query parameters", {
          details: {
            code: AI_GRADING_ERROR_CODES.INVALID_BODY,
            issues: parsed.error.issues,
          },
        });
      }

      // exactOptionalPropertyTypes: only spread status when it is defined so
      // we don't pass `{ status: undefined }` where the handler expects
      // `status?: string`.
      return handleAdminListAttempts({
        tenantId,
        userId,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
        ...(parsed.data.status !== undefined
          ? { status: parsed.data.status }
          : {}),
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/attempts/:id
  //
  // Returns the attempt review payload for the tenant. READ-ONLY since Phase II:
  // no claim transition, no audit row. While the evaluation is still with
  // AssessIQ (evaluation_status 'awaiting_evaluation') gradings are [] and score
  // is null; ai_proposals is always null for tenants.
  // -------------------------------------------------------------------------

  app.get(
    "/api/admin/attempts/:id",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id: attemptId } = req.params as { id: string };

      return handleAdminClaimAttempt({ tenantId, userId, attemptId });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/attempts/:id/release
  //
  // Publishes a finished result to the candidate (graded -> released). Needs the
  // platform to have released the evaluation to the tenant first (09 core: 409
  // RESULT_NOT_READY). No body required.
  // -------------------------------------------------------------------------

  app.post(
    "/api/admin/attempts/:id/release",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id: attemptId } = req.params as { id: string };

      return handleAdminReleaseAttempt({ tenantId, userId, attemptId });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/assessments/:id/release-all
  //
  // "Release all ready" (SP2 / A9): publishes every finished result of the
  // assessment (status 'graded' + evaluation released + non-erased candidate),
  // each in its own tx via module 09 releaseAttemptInTx, emailing after each
  // commit. 200 { released: [attemptIds], skipped: [{ id, code }] }.
  // -------------------------------------------------------------------------

  app.post(
    "/api/admin/assessments/:id/release-all",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id: assessmentId } = req.params as { id: string };

      if (!UUID_SCHEMA.safeParse(assessmentId).success) {
        throw new ValidationError("id must be a UUID", {
          details: { code: AI_GRADING_ERROR_CODES.INVALID_BODY, param: "id" },
        });
      }

      return handleAdminReleaseAll({ tenantId, userId, assessmentId });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/dashboard/queue
  //
  // Returns the admin grading queue snapshot. Optional ?status= and ?limit=
  // query-string filters. Tenant-scoped: only shows the current tenant's
  // attempts. Note: handleAdminQueue does not take userId — queue is tenant-wide.
  // -------------------------------------------------------------------------

  app.get(
    "/api/admin/dashboard/queue",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;

      const result = QUEUE_QUERY_SCHEMA.safeParse(req.query);
      if (!result.success) {
        throw new ValidationError("Invalid query parameters", {
          details: {
            code: AI_GRADING_ERROR_CODES.INVALID_BODY,
            issues: result.error.issues,
          },
        });
      }

      // exactOptionalPropertyTypes: build filters object conditionally to
      // avoid passing `{ status: undefined, limit: undefined }` where the
      // handler expects `{ status?: string; limit?: number }`.
      const filters: { status?: string; limit?: number } = {};
      if (result.data.status !== undefined) filters.status = result.data.status;
      if (result.data.limit !== undefined) filters.limit = result.data.limit;
      const hasFilters = result.data.status !== undefined || result.data.limit !== undefined;

      return handleAdminQueue(hasFilters ? { tenantId, filters } : { tenantId });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/gradings/:id/override
  //
  // Requires fresh MFA (5 minutes) per D8.
  // Immutable audit trail: creates a NEW gradings row (override_of = prior id),
  // never mutates the existing row.
  // The override payload is nested under `override` in the handler input.
  // Phase II: a tenant may override only once the platform released the evaluation
  // to it (requireEvaluationReleased) — 409 EVALUATION_NOT_RELEASED before that,
  // 409 RESULT_ALREADY_PUBLISHED after publishing.
  // -------------------------------------------------------------------------

  app.post(
    "/api/admin/gradings/:id/override",
    { preHandler: adminFreshMfa },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id: gradingId } = req.params as { id: string };

      const result = OVERRIDE_BODY_SCHEMA.safeParse(req.body);
      if (!result.success) {
        throw new ValidationError("Invalid override body", {
          details: {
            code: AI_GRADING_ERROR_CODES.INVALID_BODY,
            issues: result.error.issues,
          },
        });
      }

      // Build the `override` sub-object conditionally to satisfy
      // exactOptionalPropertyTypes — only include optional fields when defined.
      const override: {
        score_earned: number;
        reason: string;
        reasoning_band?: number;
        ai_justification?: string;
        error_class?: string | null;
      } = {
        score_earned: result.data.score_earned,
        reason: result.data.reason,
      };
      if (result.data.reasoning_band !== undefined) override.reasoning_band = result.data.reasoning_band;
      if (result.data.ai_justification !== undefined) override.ai_justification = result.data.ai_justification;
      if (result.data.error_class !== undefined) override.error_class = result.data.error_class;

      return handleAdminOverride({
        tenantId,
        userId,
        gradingId,
        override,
        requireEvaluationReleased: true,
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/grading-jobs
  //
  // Lists grading job records (Phase 2: grading_jobs table; Phase 1: derived
  // from attempts.status). Tenant-scoped. (POST …/retry is a 403 stub above.)
  // -------------------------------------------------------------------------

  app.get(
    "/api/admin/grading-jobs",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;

      return handleAdminListGradingJobs({ tenantId, userId });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/settings/billing
  //
  // Returns the tenant's grading budget (TenantGradingBudget). Phase 1:
  // always returns a zero-cost record (claude-code-vps has no API budget).
  // Phase 2: reflects anthropic-api token costs via D6 budget enforcement.
  // -------------------------------------------------------------------------

  app.get(
    "/api/admin/settings/billing",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;

      return handleAdminBudget({ tenantId, userId });
    },
  );
}
