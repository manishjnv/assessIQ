// AssessIQ — assessment-lifecycle Fastify route layer.
//
// Mounts the @assessiq/assessment-lifecycle service surface as 11 admin
// endpoints under /api/admin/{assessments,invitations}. The 7 endpoints in
// docs/03-api-contract.md § "Admin — Assessments & invitations" are covered;
// four additional endpoints (GET /:id, PATCH /:id, POST /:id/reopen,
// GET /:id/preview, GET /:id/invitations, DELETE /invitations/:id) extend the
// contract table — same admin-only gate; docs/03-api-contract.md is updated in
// the same PR per CLAUDE.md rule #5.
//
// Auth: every route uses the same admin-gated authChain injected via
// RegisterAssessmentLifecycleRoutesOptions.adminOnly —
// rateLimit → sessionLoader → apiKeyAuth → syncCtx → requireAuth({roles:['admin']})
// → extendOnPass. No fresh-MFA gate (Phase 1 admin-write paths don't require
// step-up; reserve fresh-MFA for grading override / embed-secret rotation per
// modules/01-auth/SKILL.md addendum §9).
//
// Errors: service methods throw AppError-derived exceptions (ValidationError,
// NotFoundError, ConflictError). The global Fastify error handler in
// apps/api/src/server.ts maps them to JSON envelopes with the {code, message,
// details} shape — routes do NOT need their own try/catch.
//
// RLS: the service layer wraps every DB op in withTenant which SETs LOCAL ROLE
// assessiq_app + app.current_tenant from the session. Routes pull tenantId from
// req.session (populated by the auth chain). Cross-tenant reads are impossible
// at the DB layer.
//
// Date deserialisation: opens_at / closes_at arrive as ISO strings in JSON.
// Each route that accepts them calls parseDate() below before passing into the
// service. parseDate() throws ValidationError on NaN timestamps so the service
// never receives a broken Date.

import type { FastifyInstance } from "fastify";
import { ValidationError } from "@assessiq/core";
import {
  listAssessments,
  createAssessment,
  getAssessment,
  updateAssessment,
  publishAssessment,
  closeAssessment,
  reopenAssessment,
  previewAssessment,
  listInvitations,
  inviteUsers,
  revokeInvitation,
} from "./service.js";
import type {
  AssessmentStatus,
  AssessmentSettings,
  InvitationStatus,
  CreateAssessmentInput,
  UpdateAssessmentPatch,
} from "./types.js";

// ---------------------------------------------------------------------------
// Pagination helper — inlined from 04-question-bank pattern (do NOT import)
// ---------------------------------------------------------------------------

function parsePagination(q: Record<string, string | undefined>): { page: number; pageSize: number } {
  const pageRaw = q["page"] ?? "1";
  const pageSizeRaw = q["pageSize"] ?? "20";
  const page = parseInt(pageRaw, 10);
  const pageSize = parseInt(pageSizeRaw, 10);

  if (isNaN(page) || page < 1) {
    throw new ValidationError("page must be a positive integer", {
      details: { code: "INVALID_PARAM", param: "page" },
    });
  }
  if (isNaN(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new ValidationError("pageSize must be between 1 and 100", {
      details: { code: "INVALID_PARAM", param: "pageSize" },
    });
  }
  return { page, pageSize };
}

// ---------------------------------------------------------------------------
// Date deserialisation helper
// ---------------------------------------------------------------------------
//
// Used for opens_at / closes_at — both arrive as ISO strings in the JSON body.
// If the value is null or undefined the caller decides whether to forward it.

function parseDate(raw: unknown, param: string): Date {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ValidationError(`${param} must be a valid ISO date string`, {
      details: { code: "INVALID_PARAM", param },
    });
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError(`${param} must be a valid ISO date`, {
      details: { code: "INVALID_PARAM", param },
    });
  }
  return d;
}

// ---------------------------------------------------------------------------
// Plugin registrar
// ---------------------------------------------------------------------------

export interface RegisterAssessmentLifecycleRoutesOptions {
  // The admin auth-chain factory from apps/api/src/middleware/auth-chain.ts.
  // Injected (not deep-imported) so the module stays structurally typed against
  // Fastify-shaped preHandlers without a hard dep on the apps/api package —
  // same pattern as 02-tenancy / 04-question-bank.
  adminOnly: import("fastify").preHandlerHookHandler[] | import("fastify").preHandlerHookHandler;
}

export async function registerAssessmentLifecycleRoutes(
  app: FastifyInstance,
  opts: RegisterAssessmentLifecycleRoutesOptions,
): Promise<void> {
  const { adminOnly } = opts;

  // -------------------------------------------------------------------------
  // Assessment collection routes (static segments first)
  // -------------------------------------------------------------------------

  // GET /api/admin/assessments
  app.get(
    "/api/admin/assessments",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const q = req.query as Record<string, string | undefined>;
      const { page, pageSize } = parsePagination(q);

      const filters: { status?: AssessmentStatus; packId?: string; page: number; pageSize: number } = {
        page,
        pageSize,
      };
      if (q["status"] !== undefined) filters.status = q["status"] as AssessmentStatus;
      if (q["pack_id"] !== undefined) filters.packId = q["pack_id"];

      return listAssessments(tenantId, filters);
    },
  );

  // POST /api/admin/assessments
  app.post(
    "/api/admin/assessments",
    { preHandler: adminOnly },
    async (req, reply) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const raw = req.body as Record<string, unknown>;

      const input: CreateAssessmentInput = {
        pack_id: raw["pack_id"] as string,
        level_id: raw["level_id"] as string,
        name: raw["name"] as string,
        question_count: raw["question_count"] as number,
      };

      // Optional fields — build conditionally to honour exactOptionalPropertyTypes
      if (raw["description"] !== undefined) input.description = raw["description"] as string;
      if (raw["randomize"] !== undefined) input.randomize = raw["randomize"] as boolean;
      if (raw["settings"] !== undefined) input.settings = raw["settings"] as AssessmentSettings;

      if (raw["opens_at"] !== undefined && raw["opens_at"] !== null) {
        input.opens_at = parseDate(raw["opens_at"], "opens_at");
      } else if (raw["opens_at"] === null) {
        input.opens_at = null;
      }

      if (raw["closes_at"] !== undefined && raw["closes_at"] !== null) {
        input.closes_at = parseDate(raw["closes_at"], "closes_at");
      } else if (raw["closes_at"] === null) {
        input.closes_at = null;
      }

      const assessment = await createAssessment(tenantId, input, userId);
      return reply.code(201).send(assessment);
    },
  );

  // -------------------------------------------------------------------------
  // Assessment item routes (parametric :id — registered after static segments)
  // -------------------------------------------------------------------------

  // GET /api/admin/assessments/:id
  app.get(
    "/api/admin/assessments/:id",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const { id } = req.params as { id: string };
      return getAssessment(tenantId, id);
    },
  );

  // PATCH /api/admin/assessments/:id
  app.patch(
    "/api/admin/assessments/:id",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const { id } = req.params as { id: string };
      const raw = req.body as Record<string, unknown>;

      const patch: UpdateAssessmentPatch = {};
      if (raw["name"] !== undefined) patch.name = raw["name"] as string;
      if (raw["description"] !== undefined) patch.description = raw["description"] as string | null;
      if (raw["question_count"] !== undefined) patch.question_count = raw["question_count"] as number;
      if (raw["randomize"] !== undefined) patch.randomize = raw["randomize"] as boolean;
      if (raw["settings"] !== undefined) patch.settings = raw["settings"] as AssessmentSettings;

      if (raw["opens_at"] !== undefined && raw["opens_at"] !== null) {
        patch.opens_at = parseDate(raw["opens_at"], "opens_at");
      } else if (raw["opens_at"] === null) {
        patch.opens_at = null;
      }

      if (raw["closes_at"] !== undefined && raw["closes_at"] !== null) {
        patch.closes_at = parseDate(raw["closes_at"], "closes_at");
      } else if (raw["closes_at"] === null) {
        patch.closes_at = null;
      }

      return updateAssessment(tenantId, id, patch);
    },
  );

  // POST /api/admin/assessments/:id/publish
  app.post(
    "/api/admin/assessments/:id/publish",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const { id } = req.params as { id: string };
      return publishAssessment(tenantId, id);
    },
  );

  // POST /api/admin/assessments/:id/close
  app.post(
    "/api/admin/assessments/:id/close",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const { id } = req.params as { id: string };
      return closeAssessment(tenantId, id);
    },
  );

  // POST /api/admin/assessments/:id/reopen  — extension (not in api-contract.md table;
  // added in this PR with the same admin-only gate; contract updated in same PR)
  app.post(
    "/api/admin/assessments/:id/reopen",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const { id } = req.params as { id: string };
      return reopenAssessment(tenantId, id);
    },
  );

  // GET /api/admin/assessments/:id/preview  — extension
  app.get(
    "/api/admin/assessments/:id/preview",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const { id } = req.params as { id: string };
      return previewAssessment(tenantId, id);
    },
  );

  // GET /api/admin/assessments/:id/invitations  — extension
  app.get(
    "/api/admin/assessments/:id/invitations",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const { id } = req.params as { id: string };
      const q = req.query as Record<string, string | undefined>;
      const { page, pageSize } = parsePagination(q);

      const filters: { status?: InvitationStatus; page: number; pageSize: number } = { page, pageSize };
      if (q["status"] !== undefined) filters.status = q["status"] as InvitationStatus;

      return listInvitations(tenantId, id, filters);
    },
  );

  // POST /api/admin/assessments/:id/invite
  // Body: { user_ids: string[] }
  app.post(
    "/api/admin/assessments/:id/invite",
    { preHandler: adminOnly },
    async (req, reply) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id } = req.params as { id: string };
      const body = req.body as { user_ids?: unknown };

      if (!Array.isArray(body?.user_ids) || body.user_ids.length === 0) {
        throw new ValidationError("user_ids must be a non-empty array of strings", {
          details: { code: "INVALID_PARAM", param: "user_ids" },
        });
      }

      const result = await inviteUsers(tenantId, id, body.user_ids as string[], userId);
      return reply.code(201).send(result);
    },
  );

  // -------------------------------------------------------------------------
  // Invitation item routes (separate resource path — /api/admin/invitations/:id)
  // -------------------------------------------------------------------------

  // DELETE /api/admin/invitations/:id  — extension; returns 204
  app.delete(
    "/api/admin/invitations/:id",
    { preHandler: adminOnly },
    async (req, reply) => {
      const tenantId = req.session!.tenantId;
      const { id } = req.params as { id: string };
      await revokeInvitation(tenantId, id);
      return reply.code(204).send();
    },
  );
}
