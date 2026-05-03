// AssessIQ — modules/07-ai-grading Fastify route registrar.
//
// Mounts 10 admin endpoints under /api/admin/* per docs/03-api-contract.md
// § "Admin — Grading & review". This file is the THIN route layer only:
// validate → dispatch → return. No business logic lives here.
//
// Auth chains are injected via RegisterGradingRoutesOptions (DI shape identical
// to modules/04-question-bank, modules/05-assessment-lifecycle, and
// modules/06-attempt-engine) so this module stays Fastify-shape-compatible
// without coupling to apps/api internals.
//
// Multi-tenancy guard: tenantId is ALWAYS read from req.session — never from
// the request body. Hard rule per CLAUDE.md § AssessIQ-specific hard rules #4.
//
// Errors flow through the global Fastify error handler in apps/api/src/server.ts;
// this layer throws ValidationError from @assessiq/core on bad input and does
// NOT try/catch service throws (AppError subclasses are caught by the global
// error handler and mapped to HTTP).
//
// Session heartbeat field: `req.session.lastSeenAt` (string, ISO-8601) is the
// canonical "last active" timestamp — it is updated by extendOnPassMiddleware on
// every authenticated request via modules/01-auth/src/sessions.ts refreshSession.
// The admin-grade and admin-rerun handlers take `sessionLastActivity: Date | null`
// so the route layer converts the string to Date before dispatch.

import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { ValidationError } from "@assessiq/core";
import { AnchorFindingSchema, BandFindingSchema, AI_GRADING_ERROR_CODES } from "./types.js";

import { handleAdminGrade } from "./handlers/admin-grade.js";
import { handleAdminAccept } from "./handlers/admin-accept.js";
import type { AcceptEdits } from "./handlers/admin-accept.js";
import { handleAdminOverride } from "./handlers/admin-override.js";
import { handleAdminRerun } from "./handlers/admin-rerun.js";
import { handleAdminQueue } from "./handlers/admin-queue.js";
import { handleAdminClaimAttempt, handleAdminReleaseAttempt } from "./handlers/admin-claim-release.js";
import { handleAdminListGradingJobs, handleAdminRetryGradingJob } from "./handlers/admin-grading-jobs.js";
import { handleAdminBudget } from "./handlers/admin-budget.js";

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

/**
 * POST /api/admin/attempts/:id/grade — no required body.
 * Optional `override_skill` for future skill-selection (reserved, not used in Phase 1).
 */
const GRADE_BODY_SCHEMA = z.object({
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

const ACCEPT_BODY_SCHEMA = z.object({
  proposals: z.array(PROPOSAL_WITH_EDITS_SCHEMA).min(1),
});

/**
 * POST /api/admin/gradings/:id/override — admin manual score correction.
 * `reason` is mandatory so every override has an audit trail.
 */
const OVERRIDE_BODY_SCHEMA = z.object({
  score_earned: z.number(),
  reasoning_band: z.number().int().min(0).max(4).optional(),
  ai_justification: z.string().optional(),
  error_class: z.string().nullable().optional(),
  reason: z.string().min(1),
});

/**
 * POST /api/admin/attempts/:id/rerun — force a fresh grading run.
 * `forceEscalate` defaults to true in the handler when absent.
 */
const RERUN_BODY_SCHEMA = z.object({
  forceEscalate: z.boolean().optional(),
}).strict();

/**
 * GET /api/admin/dashboard/queue — optional query-string filters.
 */
const QUEUE_QUERY_SCHEMA = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
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

function parseSessionActivity(lastSeenAt: string): Date | null {
  const d = new Date(lastSeenAt);
  return isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export async function registerGradingRoutes(
  app: FastifyInstance,
  opts: RegisterGradingRoutesOptions,
): Promise<void> {
  const adminOnly = toArray(opts.adminOnly);
  const adminFreshMfa = toArray(opts.adminFreshMfa);

  // -------------------------------------------------------------------------
  // POST /api/admin/attempts/:id/grade
  //
  // Triggers synchronous AI grading for the given attempt. Single-flight
  // mutex inside handler prevents concurrent runs per D7.
  // sessionLastActivity is forwarded so the handler can enforce the 60s
  // heartbeat invariant (D2 + D7) — lastSeenAt is updated by extendOnPass on
  // every authenticated request, making it the canonical heartbeat signal.
  // -------------------------------------------------------------------------

  app.post(
    "/api/admin/attempts/:id/grade",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id: attemptId } = req.params as { id: string };
      const sessionLastActivity = parseSessionActivity(req.session!.lastSeenAt);

      // Body is optional — validate if present and non-empty
      if (req.body !== undefined && req.body !== null) {
        const result = GRADE_BODY_SCHEMA.safeParse(req.body);
        if (!result.success) {
          throw new ValidationError("Invalid request body", {
            details: {
              code: AI_GRADING_ERROR_CODES.INVALID_BODY,
              issues: result.error.issues,
            },
          });
        }
      }

      return handleAdminGrade({ tenantId, userId, attemptId, sessionLastActivity });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/attempts/:id/accept
  //
  // Commits AI proposals (with optional admin edits) to the `gradings` table.
  // Requires a non-empty `proposals` array.
  // The `edits` field in each proposal is omitted (not set to undefined) when
  // absent so exactOptionalPropertyTypes is satisfied.
  // -------------------------------------------------------------------------

  app.post(
    "/api/admin/attempts/:id/accept",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id: attemptId } = req.params as { id: string };

      const result = ACCEPT_BODY_SCHEMA.safeParse(req.body);
      if (!result.success) {
        throw new ValidationError("Invalid accept body", {
          details: {
            code: AI_GRADING_ERROR_CODES.INVALID_BODY,
            issues: result.error.issues,
          },
        });
      }

      // Multi-tenancy guard (Phase 3 critique C1): the URL's attemptId is the
      // canonical scope. A body field setting proposal.attempt_id to a
      // different attempt would let an admin write a gradings row attached to
      // an unrelated attempt within the same tenant. RLS does not catch this
      // (same-tenant cross-attempt is allowed by RLS). Defence: every
      // proposal's attempt_id is FORCED to match the URL — if a client sent
      // a mismatched value we reject loudly.
      for (const p of result.data.proposals) {
        if (p.attempt_id !== attemptId) {
          throw new ValidationError(
            "proposal.attempt_id must match the URL attemptId",
            {
              details: {
                code: AI_GRADING_ERROR_CODES.INVALID_BODY,
                expected: attemptId,
                received: p.attempt_id,
              },
            },
          );
        }
      }

      // exactOptionalPropertyTypes: only include `edits` when it is defined,
      // and within edits only include fields that are defined — so we never
      // pass `{ reasoning_band: undefined }` where AcceptEdits wants `reasoning_band?: number`.
      const proposals = result.data.proposals.map((p) => {
        const base = {
          attempt_id: p.attempt_id,
          question_id: p.question_id,
          anchors: p.anchors,
          band: p.band,
          score_earned: p.score_earned,
          score_max: p.score_max,
          prompt_version_sha: p.prompt_version_sha,
          prompt_version_label: p.prompt_version_label,
          model: p.model,
          escalation_chosen_stage: p.escalation_chosen_stage,
          generated_at: p.generated_at,
        };
        if (p.edits !== undefined) {
          const edits: AcceptEdits = { question_id: p.edits.question_id };
          if (p.edits.reasoning_band !== undefined) edits.reasoning_band = p.edits.reasoning_band;
          if (p.edits.ai_justification !== undefined) edits.ai_justification = p.edits.ai_justification;
          if (p.edits.anchor_hits !== undefined) edits.anchor_hits = p.edits.anchor_hits;
          if (p.edits.error_class !== undefined) edits.error_class = p.edits.error_class;
          if (p.edits.score_earned !== undefined) edits.score_earned = p.edits.score_earned;
          return { ...base, edits };
        }
        return base;
      });

      return handleAdminAccept({ tenantId, userId, attemptId, proposals });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/attempts/:id
  //
  // Returns the full attempt view for admin review. Also claims the attempt
  // for this admin (optimistic lock / claim semantic) so two admins don't
  // grade the same attempt concurrently.
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
  // Releases the claim on an attempt so another admin can grade it.
  // No body required.
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
  // POST /api/admin/attempts/:id/rerun
  //
  // Discards existing proposals and triggers a fresh grading run.
  // forceEscalate defaults to true in the handler when absent.
  // -------------------------------------------------------------------------

  app.post(
    "/api/admin/attempts/:id/rerun",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id: attemptId } = req.params as { id: string };
      const sessionLastActivity = parseSessionActivity(req.session!.lastSeenAt);

      const result = RERUN_BODY_SCHEMA.safeParse(req.body ?? {});
      if (!result.success) {
        throw new ValidationError("Invalid rerun body", {
          details: {
            code: AI_GRADING_ERROR_CODES.INVALID_BODY,
            issues: result.error.issues,
          },
        });
      }

      // exactOptionalPropertyTypes: omit forceEscalate entirely when undefined
      // so we don't pass `forceEscalate: undefined` to HandleAdminRerunInput.
      const rerunInput: {
        tenantId: string;
        userId: string;
        attemptId: string;
        sessionLastActivity: Date | null;
        forceEscalate?: boolean;
      } = { tenantId, userId, attemptId, sessionLastActivity };
      if (result.data.forceEscalate !== undefined) rerunInput.forceEscalate = result.data.forceEscalate;
      return handleAdminRerun(rerunInput);
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

      return handleAdminOverride({ tenantId, userId, gradingId, override });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/grading-jobs
  //
  // Lists grading job records (Phase 2: grading_jobs table; Phase 1: derived
  // from attempts.status). Tenant-scoped.
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
  // POST /api/admin/grading-jobs/:id/retry
  //
  // Re-triggers a failed grading job. No body required.
  // sessionLastActivity forwarded for the same heartbeat check as /grade.
  // -------------------------------------------------------------------------

  app.post(
    "/api/admin/grading-jobs/:id/retry",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id: jobId } = req.params as { id: string };
      const sessionLastActivity = parseSessionActivity(req.session!.lastSeenAt);

      return handleAdminRetryGradingJob({ tenantId, userId, jobId, sessionLastActivity });
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
