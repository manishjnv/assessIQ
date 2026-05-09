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
  activateAllQuestionsForPack,
  addLevel,
  updateLevel,
  listQuestions,
  getQuestion,
  createQuestion,
  updateQuestion,
  listVersions,
  restoreVersion,
  bulkImport,
  generateQuestions,
  generateRubricForQuestion,
  saveRubric,
  bulkGenerateMissingRubrics,
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
  // Bumped from 100 to 500 on 2026-05-09: pack-detail page renders ALL questions
  // for a pack in one view; 200+ per pack is realistic when L1/L2/L3 are
  // populated. RLS bounds + LIMIT clause in the SQL query (repository.ts) cap
  // memory; 500 is a reasonable upper guard.
  // (admin-users.ts keeps its own 100 cap — user lists never need a full dump
  // in one shot, so the tighter limit there is intentional.)
  if (isNaN(pageSize) || pageSize < 1 || pageSize > 500) {
    throw new ValidationError("pageSize must be between 1 and 500", {
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

  // POST /api/admin/packs/:id/activate-questions
  // Bulk-flip every draft question in this pack to status='active' so the
  // assessment-lifecycle pool-size pre-flight and module 06's startAttempt
  // pool can see them. Closes the workflow gap RCA'd 2026-05-02.
  app.post(
    "/api/admin/packs/:id/activate-questions",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const { id } = req.params as { id: string };
      return activateAllQuestionsForPack(tenantId, id);
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
    {
      preHandler: adminOnly,
      schema: {
        body: {
          type: "object",
          required: ["pack_id", "level_id", "type", "topic", "points", "content"],
          additionalProperties: true,
          properties: {
            pack_id: { type: "string", format: "uuid" },
            level_id: { type: "string", format: "uuid" },
            type: { type: "string", enum: ["mcq", "subjective", "kql", "scenario", "log_analysis"] },
            topic: { type: "string", minLength: 1, maxLength: 200 },
            points: { type: "integer", minimum: 1 },
            content: {},
            rubric: {},
            tags: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 20 },
          },
        },
      },
    },
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

  // POST /api/admin/packs/:id/levels/:levelId/generate
  // Body: { count: number (1-30), topic_focus?: string }
  // Returns: { questionIds: string[], generated: number, skillSha: string }
  app.post(
    "/api/admin/packs/:id/levels/:levelId/generate",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id: packId, levelId } = req.params as { id: string; levelId: string };
      const body = req.body as { count?: unknown; topic_focus?: unknown };

      const count = typeof body?.count === "number" ? body.count : 5;
      if (!Number.isInteger(count) || count < 1 || count > 30) {
        throw new ValidationError("count must be an integer between 1 and 30", {
          details: { code: "INVALID_PARAM", param: "count" },
        });
      }

      const topicFocus =
        typeof body?.topic_focus === "string" && body.topic_focus.trim().length > 0
          ? body.topic_focus.trim()
          : undefined;

      return generateQuestions(tenantId, userId, packId, levelId, count, topicFocus);
    },
  );

  // POST /api/admin/questions/:id/generate-rubric
  // Returns a rubric proposal (NOT saved). Admin must POST to save-rubric to persist.
  // D2 compliant: admin-only route, no BullMQ/cron/webhook path.
  app.post(
    "/api/admin/questions/:id/generate-rubric",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const { id } = req.params as { id: string };
      return generateRubricForQuestion(tenantId, id);
    },
  );

  // POST /api/admin/questions/:id/save-rubric
  // Validates weight=100 server-side (client live total is UX only).
  // Persists the rubric as a new version. Separate from generate.
  app.post(
    "/api/admin/questions/:id/save-rubric",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id } = req.params as { id: string };
      const body = req.body as { rubric?: unknown };
      if (!body?.rubric) {
        throw new ValidationError("rubric is required", {
          details: { code: "INVALID_PARAM", param: "rubric" },
        });
      }
      return saveRubric(tenantId, id, body.rubric, userId);
    },
  );

  // POST /api/admin/packs/:id/generate-missing-rubrics
  // Finds first question in pack with rubric IS NULL and type in (subjective, scenario).
  // Returns proposal + cursor (currentQuestionId, nextQuestionId, remainingCount).
  // Does NOT auto-save — admin reviews each proposal and POSTs to save-rubric.
  app.post(
    "/api/admin/packs/:id/generate-missing-rubrics",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const { id: packId } = req.params as { id: string };
      return bulkGenerateMissingRubrics(tenantId, packId);
    },
  );

  // GET /api/admin/packs/:packId/levels/:levelId/generation-attempts
  // Returns the most recent 5 generation attempts for this pack+level so admins
  // can diagnose why a "Generate" click produced 0 rows without SSH'ing the VPS.
  // Body shape:
  //   [{ id, status, count_requested, count_inserted, error_code, error_message,
  //      stderr_tail, model, duration_ms, started_at, finished_at }]
  app.get(
    "/api/admin/packs/:packId/levels/:levelId/generation-attempts",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const { packId, levelId } = req.params as { packId: string; levelId: string };
      const { withTenant: wt } = await import("@assessiq/tenancy");
      return wt(tenantId, async (client) => {
        const result = await client.query<{
          id: string;
          status: string;
          count_requested: number;
          count_inserted: number;
          error_code: string | null;
          error_message: string | null;
          stderr_tail: string | null;
          model: string | null;
          duration_ms: number | null;
          started_at: string;
          finished_at: string | null;
        }>(
          `SELECT id, status, count_requested, count_inserted,
                  error_code, error_message, stderr_tail, model,
                  duration_ms, started_at, finished_at
           FROM generation_attempts
           WHERE pack_id = $1
             AND level_id = $2
           ORDER BY started_at DESC
           LIMIT 5`,
          [packId, levelId],
        );
        return result.rows;
      });
    },
  );
}
