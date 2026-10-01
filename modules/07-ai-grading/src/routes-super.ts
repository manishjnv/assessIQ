// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./fastify.d.ts" />
// AssessIQ — modules/07-ai-grading Fastify route registrar (PLATFORM evaluation queue).
//
// Phase II (2026-10-01). AI evaluation is run ONLY by the platform super admin (the
// owner, whose Claude subscription runs Claude Code on the VPS); tenants review and
// publish. These routes are the super admin's console API, mounted by apps/api
// routes/admin-super-evaluations.ts under /api/admin/super/evaluations*.
//
// THIN route layer (validate → resolve tenant → dispatch → return). Business logic
// lives in the handlers; the AI call stays inside handlers/admin-grade.ts +
// runtimes/claude-code-vps.ts (lint:ambient-ai) — this file only CALLS the existing
// handlers, on a super admin's click (sync, single-flight, 5-minute heartbeat).
//
// Tenancy: a super_admin session carries the PLATFORM tenant, so tenantId is NEVER
// read from the session or the body here. Every per-attempt route resolves the
// attempt's tenant from the database (resolveEvaluationTenant: system-role read-only
// lookup + assertTenantActive) and then runs the handler with that tenantId and the
// super admin's userId — i.e. inside withTenant(<attempt's tenant>) with RLS applied,
// audit rows in THAT tenant's log. Candidate identity is never returned.
//
// Auth chains are injected (same DI shape as registerGradingRoutes):
//   superAdminOnly      authChain({ roles: ['super_admin'] })
//   superAdminFreshMfa  the same + freshMfaWithinMinutes (score-changing actions)
//
// Errors flow through the global Fastify error handler in apps/api/src/server.ts.

import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { ValidationError } from "@assessiq/core";
import { AI_GRADING_ERROR_CODES } from "./types.js";
import {
  ACCEPT_BODY_SCHEMA,
  GRADE_BODY_SCHEMA,
  MANUAL_SCORE_BODY_SCHEMA,
  OVERRIDE_BODY_SCHEMA,
  RERUN_BODY_SCHEMA,
  UUID_SCHEMA,
  parseSessionActivity,
} from "./routes.js";
import { handleAdminGrade } from "./handlers/admin-grade.js";
import { handleAdminAccept } from "./handlers/admin-accept.js";
import type { AcceptEdits } from "./handlers/admin-accept.js";
import { handleAdminRerun } from "./handlers/admin-rerun.js";
import { handleAdminManualScore } from "./handlers/admin-manual-score.js";
import { handleAdminOverride } from "./handlers/admin-override.js";
import {
  assertInEvaluationQueue,
  handleSuperGetEvaluation,
  handleSuperListEvaluations,
  handleSuperReleaseToTenant,
  handleSuperReleaseToTenantBulk,
  resolveEvaluationTenant,
} from "./handlers/super-evaluations.js";

export interface RegisterSuperEvaluationRoutesOptions {
  /** `authChain({ roles: ['super_admin'] })` from apps/api. */
  superAdminOnly: preHandlerHookHandler[] | preHandlerHookHandler;
  /** `authChain({ roles: ['super_admin'], freshMfaWithinMinutes: 15 })` from apps/api. */
  superAdminFreshMfa: preHandlerHookHandler[] | preHandlerHookHandler;
}

// Unknown query params (e.g. a stale `scope=`) are ignored, not rejected.
const LIST_QUERY_SCHEMA = z.object({
  tenant_id: z.string().uuid().optional(),
});

const BULK_RELEASE_BODY_SCHEMA = z
  .object({
    attempt_ids: z.array(z.string().uuid()).min(1).max(200),
  })
  .strict();

function toArray<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v];
}

function invalid(message: string, extra: Record<string, unknown>): ValidationError {
  return new ValidationError(message, {
    details: { code: AI_GRADING_ERROR_CODES.INVALID_BODY, ...extra },
  });
}

/** 400 unless every named route param is a UUID. */
function assertUuids(params: Record<string, string>): void {
  for (const [name, value] of Object.entries(params)) {
    if (!UUID_SCHEMA.safeParse(value).success) {
      throw invalid(`${name} must be a UUID`, { param: name });
    }
  }
}

export async function registerSuperEvaluationRoutes(
  app: FastifyInstance,
  opts: RegisterSuperEvaluationRoutesOptions,
): Promise<void> {
  const superAdminOnly = toArray(opts.superAdminOnly);
  const superAdminFreshMfa = toArray(opts.superAdminFreshMfa);

  // -------------------------------------------------------------------------
  // GET /api/admin/super/evaluations?tenant_id=<uuid optional>
  //
  // The platform queue across ALL tenants, oldest first, no candidate PII.
  // 200 { items: [...], counts: { pending, older_than_24h } }.
  // -------------------------------------------------------------------------

  app.get(
    "/api/admin/super/evaluations",
    { preHandler: superAdminOnly },
    async (req) => {
      const parsed = LIST_QUERY_SCHEMA.safeParse(req.query);
      if (!parsed.success) {
        throw invalid("Invalid query parameters", { issues: parsed.error.issues });
      }
      return handleSuperListEvaluations(
        parsed.data.tenant_id !== undefined ? { tenantId: parsed.data.tenant_id } : {},
      );
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/super/evaluations/:attemptId
  //
  // The attempt review payload (questions, answers, rubric / expected answers,
  // gradings, ai_proposals, grading_started_at, score) WITHOUT candidate name /
  // email, plus tenant + evaluation metadata. No side effects.
  // -------------------------------------------------------------------------

  app.get(
    "/api/admin/super/evaluations/:attemptId",
    { preHandler: superAdminOnly },
    async (req) => {
      const { attemptId } = req.params as { attemptId: string };
      assertUuids({ attemptId });
      const tenantId = await resolveEvaluationTenant(attemptId);
      return handleSuperGetEvaluation({ tenantId, attemptId });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/super/evaluations/:attemptId/grade
  //
  // THE AI trigger: synchronous grading of one attempt on the super admin's click
  // (D2/D7: single-flight, heartbeat). Returns proposals; nothing is committed until
  // accept (D8 accept-before-commit).
  // -------------------------------------------------------------------------

  app.post(
    "/api/admin/super/evaluations/:attemptId/grade",
    { preHandler: superAdminOnly },
    async (req) => {
      const userId = req.session!.userId;
      const sessionLastActivity = parseSessionActivity(req.session!.lastSeenAt);
      const { attemptId } = req.params as { attemptId: string };
      assertUuids({ attemptId });

      // Body is optional — validate if present and non-empty
      if (req.body !== undefined && req.body !== null) {
        const result = GRADE_BODY_SCHEMA.safeParse(req.body);
        if (!result.success) {
          throw invalid("Invalid request body", { issues: result.error.issues });
        }
      }

      const tenantId = await resolveEvaluationTenant(attemptId);
      await assertInEvaluationQueue(attemptId);
      return handleAdminGrade({ tenantId, userId, attemptId, sessionLastActivity });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/super/evaluations/:attemptId/accept
  //
  // Commits the (optionally edited) AI proposals as gradings rows. When this
  // completes the attempt it flips to 'graded' + bills in the same tx, but does NOT
  // release the evaluation to the tenant (markEvaluationReleased: false) — that is
  // the separate release-to-tenant step.
  // -------------------------------------------------------------------------

  app.post(
    "/api/admin/super/evaluations/:attemptId/accept",
    { preHandler: superAdminOnly },
    async (req) => {
      const userId = req.session!.userId;
      const { attemptId } = req.params as { attemptId: string };
      assertUuids({ attemptId });

      const result = ACCEPT_BODY_SCHEMA.safeParse(req.body);
      if (!result.success) {
        throw invalid("Invalid accept body", { issues: result.error.issues });
      }

      // The URL's attemptId is the canonical scope: a proposal naming another attempt
      // would write a grading onto it (same-tenant cross-attempt is not an RLS
      // concern), so every proposal's attempt_id must match — rejected loudly.
      for (const p of result.data.proposals) {
        if (p.attempt_id !== attemptId) {
          throw invalid("proposal.attempt_id must match the URL attemptId", {
            expected: attemptId,
            received: p.attempt_id,
          });
        }
      }

      // exactOptionalPropertyTypes: only include `edits` when defined, and within
      // edits only the defined fields — never `{ reasoning_band: undefined }`.
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

      const tenantId = await resolveEvaluationTenant(attemptId);
      return handleAdminAccept({
        tenantId,
        userId,
        attemptId,
        proposals,
        markEvaluationReleased: false,
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/super/evaluations/:attemptId/rerun   { forceEscalate?: boolean }
  //
  // A fresh AI pass (returns new proposals; also valid on an already-graded attempt
  // that the tenant sent back). Same single-flight + heartbeat gates as grade.
  // -------------------------------------------------------------------------

  app.post(
    "/api/admin/super/evaluations/:attemptId/rerun",
    { preHandler: superAdminOnly },
    async (req) => {
      const userId = req.session!.userId;
      const sessionLastActivity = parseSessionActivity(req.session!.lastSeenAt);
      const { attemptId } = req.params as { attemptId: string };
      assertUuids({ attemptId });

      const result = RERUN_BODY_SCHEMA.safeParse(req.body ?? {});
      if (!result.success) {
        throw invalid("Invalid rerun body", { issues: result.error.issues });
      }

      const tenantId = await resolveEvaluationTenant(attemptId);
      await assertInEvaluationQueue(attemptId);
      // exactOptionalPropertyTypes: omit forceEscalate entirely when undefined.
      return handleAdminRerun({
        tenantId,
        userId,
        attemptId,
        sessionLastActivity,
        ...(result.data.forceEscalate !== undefined
          ? { forceEscalate: result.data.forceEscalate }
          : {}),
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/super/evaluations/:attemptId/questions/:questionId/manual-score
  //   { score_earned, reason }                                  (fresh MFA)
  //
  // First human score for a question with no grading yet (KQL has no grader). NO AI.
  // -------------------------------------------------------------------------

  app.post(
    "/api/admin/super/evaluations/:attemptId/questions/:questionId/manual-score",
    { preHandler: superAdminFreshMfa },
    async (req) => {
      const userId = req.session!.userId;
      const { attemptId, questionId } = req.params as { attemptId: string; questionId: string };
      assertUuids({ attemptId, questionId });

      const result = MANUAL_SCORE_BODY_SCHEMA.safeParse(req.body);
      if (!result.success) {
        throw invalid("Invalid manual-score body", { issues: result.error.issues });
      }

      const tenantId = await resolveEvaluationTenant(attemptId);
      return handleAdminManualScore({
        tenantId,
        userId,
        attemptId,
        questionId,
        scoreEarned: result.data.score_earned,
        reason: result.data.reason,
        markEvaluationReleased: false,
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/super/evaluations/:attemptId/gradings/:gradingId/override
  //   { score_earned, reasoning_band?, ai_justification?, error_class?, reason } (fresh MFA)
  //
  // Part of the evaluation itself (no "released first" gate, unlike the tenant's own
  // override). The grading must belong to the attempt in the URL.
  // -------------------------------------------------------------------------

  app.post(
    "/api/admin/super/evaluations/:attemptId/gradings/:gradingId/override",
    { preHandler: superAdminFreshMfa },
    async (req) => {
      const userId = req.session!.userId;
      const { attemptId, gradingId } = req.params as { attemptId: string; gradingId: string };
      assertUuids({ attemptId, gradingId });

      const result = OVERRIDE_BODY_SCHEMA.safeParse(req.body);
      if (!result.success) {
        throw invalid("Invalid override body", { issues: result.error.issues });
      }

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

      const tenantId = await resolveEvaluationTenant(attemptId);
      return handleAdminOverride({
        tenantId,
        userId,
        gradingId,
        override,
        expectedAttemptId: attemptId,
        markEvaluationReleased: false,
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/super/evaluations/:attemptId/release-to-tenant
  //   → 200 { attempt_id, evaluation_released_at }
  //
  // Hand a finished evaluation to the tenant (409/422 when not complete, flagged,
  // erased, already released or already published). Audit grading.evaluation_released.
  // -------------------------------------------------------------------------

  app.post(
    "/api/admin/super/evaluations/:attemptId/release-to-tenant",
    { preHandler: superAdminOnly },
    async (req) => {
      const userId = req.session!.userId;
      const { attemptId } = req.params as { attemptId: string };
      assertUuids({ attemptId });

      const tenantId = await resolveEvaluationTenant(attemptId);
      return handleSuperReleaseToTenant({ tenantId, userId, attemptId });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/super/evaluations/release-to-tenant   { attempt_ids: uuid[1..200] }
  //   → 200 { released: [ids], skipped: [{ id, code }] }
  //
  // Bulk release; each attempt in its OWN transaction (one bad attempt never rolls
  // back the others). The static segment cannot collide with the :attemptId routes
  // (different path depth / method).
  // -------------------------------------------------------------------------

  app.post(
    "/api/admin/super/evaluations/release-to-tenant",
    { preHandler: superAdminOnly },
    async (req) => {
      const userId = req.session!.userId;
      const result = BULK_RELEASE_BODY_SCHEMA.safeParse(req.body);
      if (!result.success) {
        throw invalid("Invalid release-to-tenant body", { issues: result.error.issues });
      }
      return handleSuperReleaseToTenantBulk({ userId, attemptIds: result.data.attempt_ids });
    },
  );
}
