// AssessIQ — assessment-lifecycle Fastify route layer.
//
// Mounts the @assessiq/assessment-lifecycle service surface as admin
// endpoints under /api/admin/{assessments,invitations}. The 7 endpoints in
// docs/03-api-contract.md § "Admin — Assessments & invitations" are covered;
// additional endpoints (GET /:id, PATCH /:id, POST /:id/reopen,
// GET /:id/preview, GET /:id/invitations, DELETE /invitations/:id, and — added
// 2026-10-01 — POST /invitations/:id/resend + POST /assessments/:id/invitations/
// resend) extend the contract table — same admin-only gate;
// docs/03-api-contract.md is updated in the same PR per CLAUDE.md rule #5.
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
import { AuthzError, ValidationError, UUID_RE, parsePagination } from "@assessiq/core";
import { z } from "zod";
import { updateAssessmentReminders } from "./reminders.js";
import { AssessmentRemindersSettingsSchema } from "./types.js";
import {
  listAssessments,
  createAssessment,
  createAssessmentFromSet,
  createMockFromBlueprint,
  importLicensedSet,
  resyncLicensedSet,
  getAssessmentDetail,
  updateAssessment,
  updateAssessmentIntegrity,
  updateAssessmentGrading,
  updateAssessmentDuration,
  publishAssessment,
  closeAssessment,
  cancelAssessment,
  deleteAssessment,
  clearEmptyDrafts,
  reopenAssessment,
  previewAssessment,
  listInvitations,
  inviteUsers,
  revokeInvitation,
  resendInvitation,
  resendInvitations,
  grantExtraAttempt,
  reopenInvitationForRetake,
  getInvitationCounts,
} from "./service.js";
import type {
  AssessmentStatus,
  AssessmentSettings,
  InvitationStatus,
  CreateAssessmentInput,
  CreateAssessmentFromSetInput,
  UpdateAssessmentPatch,
} from "./types.js";

// ---------------------------------------------------------------------------
// Pagination helper — inlined from 04-question-bank pattern (do NOT import)
// ---------------------------------------------------------------------------


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
  /** Optional per-tenant throttle appended after adminOnly on the bulk resend route (injected from apps/api). */
  bulkResendGuard?: import("fastify").preHandlerHookHandler;
  /**
   * Optional list enricher injected from apps/api (module 06 owns camera consents; no cross-module join here).
   * Gets the invitation ids that have no attempt yet; returns the ids whose newest camera consent is 'declined'.
   */
  declinedCameraInvitations?: (tenantId: string, invitationIds: string[]) => Promise<string[]>;
}

export async function registerAssessmentLifecycleRoutes(
  app: FastifyInstance,
  opts: RegisterAssessmentLifecycleRoutesOptions,
): Promise<void> {
  const { adminOnly } = opts;
  const adminList = Array.isArray(adminOnly) ? adminOnly : [adminOnly];
  const bulkResendPreHandler = opts.bulkResendGuard ? [...adminList, opts.bulkResendGuard] : adminList;

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

      const result = await listAssessments(tenantId, filters);
      const assessmentIds = result.items.map((a) => a.id);
      const invitationCounts = await getInvitationCounts(tenantId, assessmentIds);

      return {
        ...result,
        items: result.items.map((a) => ({
          ...a,
          invitations: invitationCounts[a.id] ?? {
            total: 0, pending: 0, viewed: 0, started: 0, submitted: 0, expired: 0,
          },
        })),
      };
    },
  );

  // POST /api/admin/assessments/clear-empty-drafts  - extension (Q44); bulk hard
  // delete of EMPTY drafts (draft, no attempts, no invitations). Static segment,
  // registered before the /:id routes. tenant/user from the session only.
  const ClearEmptyDraftsBodySchema = z
    .object({ ids: z.array(z.string().uuid()).min(1).max(100) })
    .strict();
  app.post(
    "/api/admin/assessments/clear-empty-drafts",
    { preHandler: adminOnly },
    async (req) => {
      const parsed = ClearEmptyDraftsBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(
          `Invalid clear-empty-drafts body: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          { details: { code: "INVALID_PARAM", param: "body" } },
        );
      }
      return clearEmptyDrafts(req.session!.tenantId, parsed.data.ids, req.session!.userId);
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
      if (raw["passing_score_pct"] !== undefined) input.passing_score_pct = raw["passing_score_pct"] as number;
      if (raw["max_attempts"] !== undefined) input.max_attempts = raw["max_attempts"] as number | null;
      if (raw["duration_minutes"] !== undefined) input.duration_minutes = raw["duration_minutes"] as number | null;
      if (raw["delivery_mode"] !== undefined) input.delivery_mode = raw["delivery_mode"] as "real" | "mock";
      if (raw["camera_required"] !== undefined) input.camera_required = raw["camera_required"] as boolean;
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

      // Blueprint authoring is super_admin-only: it composes the tenant's
      // domain question pool by per-criterion quota (a platform-operator
      // capability). Company admins build assessments by consuming a licensed
      // library set via POST /api/admin/assessments/from-set, which stays
      // adminOnly. A non-blueprint direct create here is unaffected.
      const hasBlueprint =
        input.settings !== undefined &&
        (input.settings as Record<string, unknown>)["blueprint"] !== undefined;
      if (hasBlueprint && req.session!.role !== "super_admin") {
        throw new AuthzError("Blueprint assessments are restricted to super_admin");
      }

      const assessment = await createAssessment(tenantId, input, userId);
      return reply.code(201).send(assessment);
    },
  );

  // POST /api/admin/blueprints/:id/mock  (EXP-6)
  // "Start a full mock": a DRAFT assessment from an exam blueprint, through createAssessment.
  const MockBody = z
    .object({
      pack_id: z.string().uuid(),
      level_id: z.string().uuid(),
      opens_at: z.string().min(1),
      closes_at: z.string().min(1).nullable().optional(),
      name: z.string().trim().min(1).max(200).optional(),
      delivery_mode: z.enum(["real", "mock"]).optional(),
      camera_required: z.boolean().optional(),
    })
    .strict();
  app.post(
    "/api/admin/blueprints/:id/mock",
    { preHandler: adminOnly },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) {
        throw new ValidationError("id must be a valid UUID", { details: { code: "INVALID_PARAM", param: "id" } });
      }
      const body = MockBody.safeParse(req.body);
      if (!body.success) {
        throw new ValidationError("invalid body", { details: { code: "INVALID_PARAM", issues: body.error.issues } });
      }
      const b = body.data;
      const result = await createMockFromBlueprint(
        req.session!.tenantId,
        id,
        {
          pack_id: b.pack_id,
          level_id: b.level_id,
          opens_at: parseDate(b.opens_at, "opens_at"),
          ...(b.closes_at != null ? { closes_at: parseDate(b.closes_at, "closes_at") } : {}),
          ...(b.name !== undefined ? { name: b.name } : {}),
          ...(b.delivery_mode !== undefined ? { delivery_mode: b.delivery_mode } : {}),
          ...(b.camera_required !== undefined ? { camera_required: b.camera_required } : {}),
        },
        req.session!.userId,
      );
      return reply.code(201).send(result);
    },
  );

  // POST /api/admin/assessments/from-set
  // Step 2 — clone-on-use: create an assessment from a licensed PLATFORM-library
  // set. The source set is license-checked, cloned into this tenant (idempotent),
  // and the assessment is created from the clone. Static segment — registered
  // before the parametric :id routes below.
  // Body: { source_pack_id, level_position, name, question_count, opens_at,
  //         closes_at?, randomize?, description?, settings? }
  app.post(
    "/api/admin/assessments/from-set",
    { preHandler: adminOnly },
    async (req, reply) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const raw = req.body as Record<string, unknown>;

      if (typeof raw["source_pack_id"] !== "string" || raw["source_pack_id"].trim() === "") {
        throw new ValidationError("source_pack_id is required", {
          details: { code: "INVALID_PARAM", param: "source_pack_id" },
        });
      }
      const levelPosition = Number(raw["level_position"]);
      if (!Number.isInteger(levelPosition) || levelPosition < 1) {
        throw new ValidationError("level_position must be a positive integer", {
          details: { code: "INVALID_PARAM", param: "level_position" },
        });
      }

      const input: CreateAssessmentFromSetInput = {
        source_pack_id: (raw["source_pack_id"] as string).trim(),
        level_position: levelPosition,
        name: raw["name"] as string,
        question_count: raw["question_count"] as number,
      };
      if (raw["description"] !== undefined) input.description = raw["description"] as string;
      if (raw["randomize"] !== undefined) input.randomize = raw["randomize"] as boolean;
      if (raw["passing_score_pct"] !== undefined) input.passing_score_pct = raw["passing_score_pct"] as number;
      if (raw["max_attempts"] !== undefined) input.max_attempts = raw["max_attempts"] as number | null;
      if (raw["duration_minutes"] !== undefined) input.duration_minutes = raw["duration_minutes"] as number | null;
      if (raw["delivery_mode"] !== undefined) input.delivery_mode = raw["delivery_mode"] as "real" | "mock";
      if (raw["camera_required"] !== undefined) input.camera_required = raw["camera_required"] as boolean;
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

      const assessment = await createAssessmentFromSet(tenantId, input, userId);
      return reply.code(201).send(assessment);
    },
  );

  // POST /api/admin/sets/:sourcePackId/import
  // Clone-on-use a licensed PLATFORM-library set into THIS tenant's Question
  // Bank without creating an assessment. License-checked; idempotent (reuses an
  // existing clone). Lets a company admin stock their workspace up front.
  app.post(
    "/api/admin/sets/:sourcePackId/import",
    { preHandler: adminOnly },
    async (req, reply) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { sourcePackId } = req.params as { sourcePackId: string };
      const trimmed = typeof sourcePackId === "string" ? sourcePackId.trim() : "";
      // Validate UUID shape up front so a malformed path param returns a clean
      // 400 INVALID_PARAM instead of a Postgres cast error downstream.
      if (!UUID_RE.test(trimmed)) {
        throw new ValidationError("sourcePackId must be a valid UUID", {
          details: { code: "INVALID_PARAM", param: "sourcePackId" },
        });
      }
      const result = await importLicensedSet(tenantId, trimmed, userId);
      return reply.code(201).send(result);
    },
  );

  // POST /api/admin/sets/:sourcePackId/resync
  // Pull a newer platform-master version into the existing tenant clone.
  // License-checked (same gate as import). Returns a diff summary; 200 because
  // it mutates an existing resource (not 201 — nothing is created).
  app.post(
    "/api/admin/sets/:sourcePackId/resync",
    { preHandler: adminOnly },
    async (req, reply) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { sourcePackId } = req.params as { sourcePackId: string };
      const trimmed = typeof sourcePackId === "string" ? sourcePackId.trim() : "";
      // Validate UUID shape up front so a malformed path param returns a clean
      // 400 INVALID_PARAM instead of a Postgres cast error downstream.
      if (!UUID_RE.test(trimmed)) {
        throw new ValidationError("sourcePackId must be a valid UUID", {
          details: { code: "INVALID_PARAM", param: "sourcePackId" },
        });
      }
      const result = await resyncLicensedSet(tenantId, trimmed, userId);
      return reply.code(200).send(result);
    },
  );

  // -------------------------------------------------------------------------
  // Assessment item routes (parametric :id — registered after static segments)
  // -------------------------------------------------------------------------

  // GET /api/admin/assessments/:id
  // Uses getAssessmentDetail (instead of getAssessment) to also return
  // level_label and pack_name for the admin detail page header.
  app.get(
    "/api/admin/assessments/:id",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const { id } = req.params as { id: string };
      return getAssessmentDetail(tenantId, id);
    },
  );

  // PATCH /api/admin/assessments/:id
  app.patch(
    "/api/admin/assessments/:id",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id } = req.params as { id: string };
      const raw = req.body as Record<string, unknown>;

      const patch: UpdateAssessmentPatch = {};
      if (raw["name"] !== undefined) patch.name = raw["name"] as string;
      if (raw["description"] !== undefined) patch.description = raw["description"] as string | null;
      if (raw["question_count"] !== undefined) patch.question_count = raw["question_count"] as number;
      if (raw["randomize"] !== undefined) patch.randomize = raw["randomize"] as boolean;
      if (raw["passing_score_pct"] !== undefined) patch.passing_score_pct = raw["passing_score_pct"] as number;
      if (raw["max_attempts"] !== undefined) patch.max_attempts = raw["max_attempts"] as number | null;
      if (raw["duration_minutes"] !== undefined) patch.duration_minutes = raw["duration_minutes"] as number | null;
      if (raw["delivery_mode"] !== undefined) patch.delivery_mode = raw["delivery_mode"] as "real" | "mock";
      if (raw["camera_required"] !== undefined) patch.camera_required = raw["camera_required"] as boolean;
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

      // Same super_admin gate as create: blueprint authoring (including
      // converting an existing draft into a blueprint via PATCH) is a
      // platform-operator capability. Without this, a tenant admin could create
      // a non-blueprint draft and then PATCH a blueprint onto it.
      const hasBlueprint =
        patch.settings !== undefined &&
        (patch.settings as Record<string, unknown>)["blueprint"] !== undefined;
      if (hasBlueprint && req.session!.role !== "super_admin") {
        throw new AuthzError("Blueprint assessments are restricted to super_admin");
      }

      return updateAssessment(tenantId, id, patch, userId);
    },
  );

  // PATCH /api/admin/assessments/:id/integrity — change only the integrity
  // switches (any status); merged into settings server-side.
  const IntegrityBodySchema = z
    .object({ fullscreen: z.boolean(), block_copy_paste: z.boolean() })
    .strict();
  app.patch(
    "/api/admin/assessments/:id/integrity",
    { preHandler: adminOnly },
    async (req) => {
      const { id } = req.params as { id: string };
      const parsed = IntegrityBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(
          `Invalid integrity body: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          { details: { code: "INVALID_PARAM", param: "body" } },
        );
      }
      return updateAssessmentIntegrity(req.session!.tenantId, id, parsed.data, req.session!.userId);
    },
  );

  // PATCH /api/admin/assessments/:id/time-limit - change only duration_minutes
  // (1..600, or null = level time; any status; a running attempt is not changed).
  const TimeLimitBodySchema = z
    .object({ duration_minutes: z.number().int().min(1).max(600).nullable() })
    .strict();
  app.patch(
    "/api/admin/assessments/:id/time-limit",
    { preHandler: adminOnly },
    async (req) => {
      const { id } = req.params as { id: string };
      const parsed = TimeLimitBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(
          `Invalid time-limit body: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          { details: { code: "INVALID_PARAM", param: "duration_minutes" } },
        );
      }
      return updateAssessmentDuration(req.session!.tenantId, id, parsed.data.duration_minutes, req.session!.userId);
    },
  );

  // PATCH /api/admin/assessments/:id/grading - change only settings.high_stakes
  // (two-model grading vote; any status).
  const GradingBodySchema = z.object({ high_stakes: z.boolean() }).strict();
  app.patch(
    "/api/admin/assessments/:id/grading",
    { preHandler: adminOnly },
    async (req) => {
      const { id } = req.params as { id: string };
      const parsed = GradingBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(
          `Invalid grading body: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          { details: { code: "INVALID_PARAM", param: "body" } },
        );
      }
      return updateAssessmentGrading(req.session!.tenantId, id, parsed.data, req.session!.userId);
    },
  );

  // PATCH /api/admin/assessments/:id/reminders — change only the automatic
  // invitation-reminder setting (any status); merged into settings server-side.
  app.patch(
    "/api/admin/assessments/:id/reminders",
    { preHandler: adminOnly },
    async (req) => {
      const { id } = req.params as { id: string };
      const parsed = AssessmentRemindersSettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(
          `Invalid reminders body: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          { details: { code: "INVALID_PARAM", param: "body" } },
        );
      }
      return updateAssessmentReminders(req.session!.tenantId, id, parsed.data, req.session!.userId);
    },
  );

  // POST /api/admin/assessments/:id/publish
  app.post(
    "/api/admin/assessments/:id/publish",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id } = req.params as { id: string };
      return publishAssessment(tenantId, id, userId);
    },
  );

  // POST /api/admin/assessments/:id/close
  app.post(
    "/api/admin/assessments/:id/close",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id } = req.params as { id: string };
      return closeAssessment(tenantId, id, userId);
    },
  );

  // POST /api/admin/assessments/:id/reopen  — extension (not in api-contract.md table;
  // added in this PR with the same admin-only gate; contract updated in same PR)
  app.post(
    "/api/admin/assessments/:id/reopen",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id } = req.params as { id: string };
      return reopenAssessment(tenantId, id, userId);
    },
  );

  // POST /api/admin/assessments/:id/cancel  — extension; soft-retire (→ cancelled).
  // Legal from draft/published/active/closed; preserves attempts + audit.
  app.post(
    "/api/admin/assessments/:id/cancel",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id } = req.params as { id: string };
      return cancelAssessment(tenantId, id, userId);
    },
  );

  // DELETE /api/admin/assessments/:id  — extension; hard delete, returns 204.
  // Allowed only when the assessment has zero attempts (else 422
  // ASSESSMENT_HAS_ATTEMPTS — caller should cancel instead). RLS confines the
  // delete to the caller's tenant; invitations + frozen pool cascade.
  app.delete(
    "/api/admin/assessments/:id",
    { preHandler: adminOnly },
    async (req, reply) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id } = req.params as { id: string };
      await deleteAssessment(tenantId, id, userId);
      return reply.code(204).send();
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

      const result = await listInvitations(tenantId, id, filters);
      // "Did not consent": newest camera consent declined AND no attempt yet (a later start clears it).
      const noAttempt = result.items.filter((i) => i.attempt_id == null).map((i) => i.id);
      const declined = new Set(
        opts.declinedCameraInvitations ? (await opts.declinedCameraInvitations(tenantId, noAttempt)).filter((id) => noAttempt.includes(id)) : [],
      );
      return { ...result, items: result.items.map((i) => ({ ...i, camera_consent: declined.has(i.id) ? "declined" : null })) };
    },
  );

  // POST /api/admin/assessments/:id/invite
  // Body: { user_ids: string[] }. Z-142: the invitation takes the assessment's mode; a delivery_mode in the body is ignored.
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

  // POST /api/admin/assessments/:id/invitations/resend  — extension (2026-10-01)
  // Bulk "resend to everyone who hasn't started": every pending / viewed /
  // lapsed invitation whose candidate has no attempt (NOT revoked — only the
  // single resend revives those). Max 200 per call, oldest first; each row is
  // its own transaction and its email goes out right after its commit.
  // 200 { resent, skipped: [{ id, code }], remaining }. 404 assessment not in
  // this tenant; 409 ASSESSMENT_NOT_ACTIVE when it is draft/closed/cancelled.
  // No body.
  app.post(
    "/api/admin/assessments/:id/invitations/resend",
    { preHandler: bulkResendPreHandler },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id } = req.params as { id: string };
      return resendInvitations(tenantId, id, userId);
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
      const userId = req.session!.userId;
      const { id } = req.params as { id: string };
      await revokeInvitation(tenantId, id, userId);
      return reply.code(204).send();
    },
  );

  // POST /api/admin/invitations/:id/resend  — extension (2026-10-01)
  // Replace the link and extend: fresh token (the old link stops working),
  // expires_at = now + 7 days, status back to 'pending', one audit row in the
  // same transaction, then the invitation email after the commit. Works for
  // pending / viewed / lapsed AND revoked invitations — which makes it the
  // "extend" and "re-invite after revoke" action too. No body.
  // 200 → the updated invitation. 404 not in this tenant; 409 with
  // details.code INVITATION_ALREADY_STARTED (candidate started/submitted),
  // ASSESSMENT_NOT_ACTIVE (draft/closed/cancelled) or USER_INACTIVE; 502
  // INVITATION_EMAIL_FAILED if the email could not be queued (the new link is
  // already saved — pressing Resend again is safe).
  app.post(
    "/api/admin/invitations/:id/resend",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id } = req.params as { id: string };
      return resendInvitation(tenantId, id, userId);
    },
  );

  // POST /api/admin/invitations/:id/extra-attempt  � Z-39
  // Body { reason: string } (required, 1..500 chars). Gives this ONE candidate ONE
  // more attempt than assessments.max_attempts allows; one audit row per grant
  // (assessment.invitation.extra_attempt_granted) in the same transaction.
  // 200 { invitation, attempts_used, attempts_allowed }. 404 not in this tenant;
  // 409 ASSESSMENT_NOT_ACTIVE / EXTRA_ATTEMPT_LIMIT; 422 INVALID_PARAM (reason).
  app.post(
    "/api/admin/invitations/:id/extra-attempt",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { reason?: unknown };
      return grantExtraAttempt(tenantId, id, body.reason, userId);
    },
  );

  // POST /api/admin/invitations/:id/reopen  � Z-39
  // Re-open a SUBMITTED invitation for the next attempt: fresh link, 7 days, email.
  // No body. 200 -> the updated invitation. 409 ATTEMPTS_EXHAUSTED (limit reached),
  // RETAKE_NOT_AVAILABLE (not submitted / an attempt is unfinished),
  // ASSESSMENT_NOT_ACTIVE, USER_INACTIVE; 502 INVITATION_EMAIL_FAILED.
  app.post(
    "/api/admin/invitations/:id/reopen",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id } = req.params as { id: string };
      return reopenInvitationForRetake(tenantId, id, userId);
    },
  );
}
