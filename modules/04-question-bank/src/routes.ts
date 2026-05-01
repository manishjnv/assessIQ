// AssessIQ — question-bank Fastify route layer.
//
// Mounts the @assessiq/question-bank service surface as 15 admin endpoints
// under /api/admin/{packs,levels,questions}. The 12 endpoints in
// docs/03-api-contract.md § "Admin — Question bank" are covered; three
// additional endpoints (POST /admin/packs/:id/archive, PATCH /admin/levels/:id,
// POST /admin/questions/:id/restore) expose service methods that aren't in
// the contract table — same admin-only gate; api-contract.md is updated in
// the same PR per CLAUDE.md rule #5.
//
// Auth: every route uses the same admin-gated authChain — full
// rateLimit → sessionLoader → apiKeyAuth → syncCtx → requireAuth({roles:['admin']})
// → extendOnPass stack. No fresh-MFA gate (Phase 1 admin-write paths don't
// require step-up; reserve fresh-MFA for grading override and embed-secret
// rotation per modules/01-auth/SKILL.md addendum §9).
//
// Errors: every service method throws AppError-derived exceptions
// (ValidationError, NotFoundError, ConflictError). The global error handler
// in apps/api/src/server.ts maps them to JSON envelopes with the {code,
// message, details} shape — routes do not need their own try/catch.
//
// IMPORTANT — RLS: the service layer wraps every DB op in withTenant which
// SETs LOCAL ROLE assessiq_app + app.current_tenant from the session. Routes
// pull tenantId from req.session (populated by the auth chain). Cross-tenant
// reads are impossible at the DB layer.

import type { FastifyInstance } from "fastify";
import { ValidationError } from "@assessiq/core";
import {
  listPacks,
  createPack,
  getPack,
  getPackWithLevels,
  updatePack,
  publishPack,
  archivePack,
  addLevel,
  updateLevel,
  listQuestions,
  getQuestion,
  createQuestion,
  updateQuestion,
  listVersions,
  restoreVersion,
  bulkImport,
} from "./service.js";
import type {
  AddLevelInput,
  CreatePackInput,
  CreateQuestionInput,
  ListPacksInput,
  ListQuestionsInput,
  PackStatus,
  QuestionStatus,
  QuestionType,
  UpdateLevelPatch,
  UpdateQuestionPatch,
} from "./types.js";

// ---------------------------------------------------------------------------
// Pagination helper — shared by list endpoints
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
  // The service-layer assertPageSize() also enforces the upper bound (100) —
  // we re-check here so the failure mode is a 400 INVALID_PARAM at parse-time
  // rather than reaching the service. Keeps the upper bound parity with
  // admin-users.ts.
  if (isNaN(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new ValidationError("pageSize must be between 1 and 100", {
      details: { code: "INVALID_PARAM", param: "pageSize" },
    });
  }
  return { page, pageSize };
}

// ---------------------------------------------------------------------------
// Plugin registrar
// ---------------------------------------------------------------------------

export interface RegisterQuestionBankRoutesOptions {
  // The auth chain factory from apps/api/src/middleware/auth-chain.ts.
  // Passing it in (rather than deep-importing) keeps the question-bank
  // module structurally typed against Fastify-shaped preHandlers without a
  // hard dep on the apps/api package — same pattern 02-tenancy uses for
  // tenantContextMiddleware.
  adminOnly: import("fastify").preHandlerHookHandler[] | import("fastify").preHandlerHookHandler;
}

export async function registerQuestionBankRoutes(
  app: FastifyInstance,
  opts: RegisterQuestionBankRoutesOptions,
): Promise<void> {
  const { adminOnly } = opts;

  // -------------------------------------------------------------------------
  // Pack routes
  // -------------------------------------------------------------------------

  // GET /api/admin/packs
  app.get(
    "/api/admin/packs",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const q = req.query as Record<string, string | undefined>;
      const { page, pageSize } = parsePagination(q);

      const filters: ListPacksInput = { page, pageSize };
      if (q["domain"] !== undefined) filters.domain = q["domain"];
      if (q["status"] !== undefined) filters.status = q["status"] as PackStatus;
      return listPacks(tenantId, filters);
    },
  );

  // POST /api/admin/packs
  app.post(
    "/api/admin/packs",
    { preHandler: adminOnly },
    async (req, reply) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const body = req.body as CreatePackInput;
      const pack = await createPack(tenantId, body, userId);
      return reply.code(201).send(pack);
    },
  );

  // GET /api/admin/packs/:id  — pack with ordered levels
  app.get(
    "/api/admin/packs/:id",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const { id } = req.params as { id: string };
      return getPackWithLevels(tenantId, id);
    },
  );

  // PATCH /api/admin/packs/:id
  app.patch(
    "/api/admin/packs/:id",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const { id } = req.params as { id: string };
      const body = req.body as { name?: string; domain?: string; description?: string };
      return updatePack(tenantId, id, body);
    },
  );

  // POST /api/admin/packs/:id/publish
  app.post(
    "/api/admin/packs/:id/publish",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id } = req.params as { id: string };
      return publishPack(tenantId, id, userId);
    },
  );

  // POST /api/admin/packs/:id/archive  — extension (service has it, contract gets it in this PR)
  app.post(
    "/api/admin/packs/:id/archive",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const { id } = req.params as { id: string };
      return archivePack(tenantId, id);
    },
  );

  // -------------------------------------------------------------------------
  // Level routes
  // -------------------------------------------------------------------------

  // POST /api/admin/packs/:id/levels
  app.post(
    "/api/admin/packs/:id/levels",
    { preHandler: adminOnly },
    async (req, reply) => {
      const tenantId = req.session!.tenantId;
      const { id } = req.params as { id: string };
      const body = req.body as AddLevelInput;
      const level = await addLevel(tenantId, id, body);
      return reply.code(201).send(level);
    },
  );

  // PATCH /api/admin/levels/:id  — extension
  app.patch(
    "/api/admin/levels/:id",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const { id } = req.params as { id: string };
      const body = req.body as UpdateLevelPatch;
      return updateLevel(tenantId, id, body);
    },
  );

  // -------------------------------------------------------------------------
  // Question routes
  // -------------------------------------------------------------------------
  //
  // Fastify-routing trap: register the static segment "/import" BEFORE the
  // parametric "/:id" routes. Fastify matches static before parametric so
  // order is a safety net — but explicit order keeps the trap from biting if
  // someone reorders later.

  // POST /api/admin/questions/import  — JSON-only Phase 1 (decision #4)
  app.post(
    "/api/admin/questions/import",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      // Body arrives as already-parsed JSON; bulkImport() takes a Buffer +
      // performs its own parse + Zod-validate. Round-trip via JSON.stringify
      // keeps the service-layer surface uniform between CLI (file → buffer)
      // and HTTP (parsed body → buffer) callers. Cheap on the small files
      // this endpoint handles (single pack, hundreds of questions max).
      const buffer = Buffer.from(JSON.stringify(req.body));
      return bulkImport(tenantId, buffer, "json", userId);
    },
  );

  // GET /api/admin/questions
  app.get(
    "/api/admin/questions",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const q = req.query as Record<string, string | undefined>;
      const { page, pageSize } = parsePagination(q);

      const filters: ListQuestionsInput = { page, pageSize };
      if (q["pack_id"] !== undefined) filters.pack_id = q["pack_id"];
      if (q["level_id"] !== undefined) filters.level_id = q["level_id"];
      if (q["type"] !== undefined) filters.type = q["type"] as QuestionType;
      if (q["status"] !== undefined) filters.status = q["status"] as QuestionStatus;
      if (q["tag"] !== undefined) filters.tag = q["tag"];
      if (q["search"] !== undefined) filters.search = q["search"];
      return listQuestions(tenantId, filters);
    },
  );

  // POST /api/admin/questions
  app.post(
    "/api/admin/questions",
    { preHandler: adminOnly },
    async (req, reply) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const body = req.body as CreateQuestionInput;
      const question = await createQuestion(tenantId, body, userId);
      return reply.code(201).send(question);
    },
  );

  // GET /api/admin/questions/:id
  app.get(
    "/api/admin/questions/:id",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const { id } = req.params as { id: string };
      return getQuestion(tenantId, id);
    },
  );

  // PATCH /api/admin/questions/:id  — implicit new version on content/rubric change
  app.patch(
    "/api/admin/questions/:id",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id } = req.params as { id: string };
      const body = req.body as UpdateQuestionPatch;
      return updateQuestion(tenantId, id, body, userId);
    },
  );

  // GET /api/admin/questions/:id/versions
  app.get(
    "/api/admin/questions/:id/versions",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const { id } = req.params as { id: string };
      return listVersions(tenantId, id);
    },
  );

  // POST /api/admin/questions/:id/restore  — extension (body: { version: number })
  app.post(
    "/api/admin/questions/:id/restore",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id } = req.params as { id: string };
      const body = req.body as { version: number };
      if (typeof body?.version !== "number" || !Number.isInteger(body.version) || body.version < 1) {
        throw new ValidationError("version must be a positive integer", {
          details: { code: "INVALID_PARAM", param: "version" },
        });
      }
      return restoreVersion(tenantId, id, body.version, userId);
    },
  );

  // GET /api/admin/packs/:id/levels NOT exposed — getPackWithLevels covers it.
  // PATCH /api/admin/questions/:id/tags NOT exposed — tags are part of PATCH body.
  // DELETE on packs/levels/questions NOT supported in Phase 1 — soft-delete via
  // status='archived' is the only path. Hard delete is a Phase 3 admin tool.
}
