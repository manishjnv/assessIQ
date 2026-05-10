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
import { ValidationError, NotFoundError } from "@assessiq/core";
import {
  scoreQuestion,
  loadFixture,
  loadRuntimeThresholds,
  loadBaseline,
  scoreRuntimeMetrics,
} from "@assessiq/ai-grading/eval";
import type {
  GoldenQuestion,
  KbSourceRef,
  EvalType,
  EvalRuntimeMetricRow,
} from "@assessiq/ai-grading/eval";
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
// Generate-body parser — exported for unit testing
// ---------------------------------------------------------------------------

/** Allowed per-type override keys. */
const GENERATE_TYPE_KEYS = ["mcq", "log_analysis", "scenario", "kql", "subjective"] as const;
type GenerateTypeKey = typeof GENERATE_TYPE_KEYS[number];

/**
 * Parse and validate the body for POST .../generate.
 *
 * @internal Exported so the unit tests in __tests__/generate-body-validation.test.ts
 *   can exercise the validation rules without starting a Fastify server.
 */
export function parseGenerateBody(raw: unknown): {
  count: number;
  topicFocus: string | undefined;
  typeCounts: Partial<Record<GenerateTypeKey, number>> | undefined;
} {
  const body = raw as {
    count?: unknown;
    topic_focus?: unknown;
    type_counts?: unknown;
  } | null | undefined;

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

  if (body?.type_counts === undefined || body?.type_counts === null) {
    return { count, topicFocus, typeCounts: undefined };
  }

  if (typeof body.type_counts !== "object" || Array.isArray(body.type_counts)) {
    throw new ValidationError("type_counts must be an object", {
      details: { code: "INVALID_PARAM", param: "type_counts" },
    });
  }

  const tc = body.type_counts as Record<string, unknown>;
  const parsed: Partial<Record<GenerateTypeKey, number>> = {};
  for (const key of GENERATE_TYPE_KEYS) {
    const v = tc[key];
    if (v !== undefined) {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 30) {
        throw new ValidationError(
          `type_counts.${key} must be an integer between 0 and 30`,
          { details: { code: "INVALID_PARAM", param: `type_counts.${key}` } },
        );
      }
      parsed[key] = v;
    }
  }

  const sum = (Object.values(parsed) as number[]).reduce((acc, v) => acc + v, 0);
  if (sum !== count) {
    throw new ValidationError("type_counts values must sum to count", {
      details: { code: "INVALID_TYPE_COUNTS_SUM", sum, count },
    });
  }

  return { count, topicFocus, typeCounts: parsed };
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
  // Body: { count: number (1-30), topic_focus?: string,
  //         type_counts?: { mcq?, log_analysis?, scenario?, kql?, subjective? } }
  // Returns: { questionIds: string[], generated: number, skillSha: string }
  app.post(
    "/api/admin/packs/:id/levels/:levelId/generate",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id: packId, levelId } = req.params as { id: string; levelId: string };

      const { count, topicFocus, typeCounts } = parseGenerateBody(req.body);
      return generateQuestions(tenantId, userId, packId, levelId, count, topicFocus, typeCounts);
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

  // GET /api/admin/generation-attempts
  // Cross-pack history view for AI question-generation attempts.
  // Query params (all optional):
  //   status   — filter by status enum (success/partial/failed/running)
  //   model    — substring match on model column
  //   pack_id  — exact UUID match
  //   level_id — exact UUID match
  //   since    — ISO-8601; only attempts with started_at >= since
  //   limit    — int 1-100, default 50
  //   offset   — int >= 0, default 0
  // Returns: { items: GenerationAttempt[], total: number, limit, offset }
  app.get(
    "/api/admin/generation-attempts",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const q = req.query as Record<string, string | undefined>;

      const rawStatus = q["status"];
      const rawModel = q["model"];
      const rawPackId = q["pack_id"];
      const rawLevelId = q["level_id"];
      const rawSince = q["since"];

      const rawLimit = parseInt(q["limit"] ?? "50", 10);
      const rawOffset = parseInt(q["offset"] ?? "0", 10);

      const limitVal = !isNaN(rawLimit) && rawLimit >= 1 && rawLimit <= 100 ? rawLimit : 50;
      const offsetVal = !isNaN(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

      const validStatuses = ["success", "partial", "failed", "running"];
      const statusVal = rawStatus && validStatuses.includes(rawStatus) ? rawStatus : null;

      const { withTenant: wt } = await import("@assessiq/tenancy");
      return wt(tenantId, async (client) => {
        // Build dynamic WHERE clause — always tenant-scoped (RLS enforces it, but
        // explicit params give the query planner better selectivity).
        const conditions: string[] = [];
        const params: unknown[] = [];

        if (statusVal) {
          params.push(statusVal);
          conditions.push(`status = $${params.length}`);
        }
        if (rawModel) {
          params.push(`%${rawModel}%`);
          conditions.push(`model ILIKE $${params.length}`);
        }
        if (rawPackId) {
          params.push(rawPackId);
          conditions.push(`pack_id = $${params.length}`);
        }
        if (rawLevelId) {
          params.push(rawLevelId);
          conditions.push(`level_id = $${params.length}`);
        }
        if (rawSince) {
          const sinceDate = new Date(rawSince);
          if (!isNaN(sinceDate.getTime())) {
            params.push(sinceDate.toISOString());
            conditions.push(`started_at >= $${params.length}`);
          }
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

        // Two-query pattern (mirrors the existing list endpoints in this file):
        // 1. COUNT(*) — cheap planning estimate
        // 2. Page select with ORDER BY + LIMIT/OFFSET
        const countResult = await client.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM generation_attempts ${where}`,
          params,
        );
        const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

        params.push(limitVal);
        const limitParam = params.length;
        params.push(offsetVal);
        const offsetParam = params.length;

        const itemsResult = await client.query<{
          id: string;
          status: string;
          count_requested: number;
          count_inserted: number;
          error_code: string | null;
          error_message: string | null;
          stderr_tail: string | null;
          skill_sha: string | null;
          model: string | null;
          chunks_planned: number | null;
          chunks_failed: number | null;
          dedupe_dropped: number | null;
          duration_ms: number | null;
          started_at: string;
          finished_at: string | null;
          pack_id: string;
          level_id: string;
          user_id: string | null;
        }>(
          `SELECT id, status, count_requested, count_inserted,
                  error_code, error_message, stderr_tail, skill_sha,
                  model, chunks_planned, chunks_failed, dedupe_dropped,
                  duration_ms, started_at, finished_at, pack_id, level_id, user_id
           FROM generation_attempts
           ${where}
           ORDER BY started_at DESC
           LIMIT $${limitParam} OFFSET $${offsetParam}`,
          params,
        );

        return { items: itemsResult.rows, total, limit: limitVal, offset: offsetVal };
      });
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

  // POST /api/admin/generation-attempts/:id/score
  //
  // Server-side structural + runtime scoring for a single generation attempt.
  // READ-ONLY — no writes to any table. Sub-100ms for typical attempt sizes
  // (≤30 questions × Zod parse + fixture file reads cached by Node's module loader).
  //
  // Behavior:
  //   1. Resolves the attempt row via RLS (tenant-scoped; 404 if not in this tenant).
  //   2. Loads inserted questions for the attempt (same filter as cli-typed.ts cmdScoreCandidate).
  //   3. Resolves level label → L1/L2/L3 for fixture lookup.
  //   4. Loads eval/fixtures/{level}-sources.json; if absent, uses a synthetic
  //      fixture so that citationsResolve is effectively n/a (passes) for all candidates.
  //   5. Runs scoreQuestion (pure; from eval/runner.ts) per inserted question.
  //   6. Compares per-type pass rates against eval/baseline.json regression_thresholds.
  //   7. Loads eval/runtime-baseline.json regression_thresholds; skips gracefully if absent.
  //   8. Computes runtime metrics (chunk_success_rate, total_inserted_pct, n/a for the rest).
  //   9. Derives overall verdict: pass / regression / warning / n/a.
  //
  // Returns: ScoreAttemptResponse (documented in modules/10-admin-dashboard/src/api.ts).
  app.post(
    "/api/admin/generation-attempts/:id/score",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const { id } = req.params as { id: string };

      // ── Step 1: Resolve attempt row + level label + inserted questions ──────
      // All within a single withTenant call so RLS is consistently applied.
      const { withTenant: wt } = await import("@assessiq/tenancy");

      interface AttemptRow {
        id: string;
        status: string;
        pack_id: string;
        level_id: string;
        count_requested: number;
        count_inserted: number;
        duration_ms: number | null;
        chunks_planned: number | null;
        chunks_failed: number | null;
        dedupe_dropped: number | null;
        citation_dropped: number | null;
        model: string | null;
        skill_sha: string | null;
        error_code: string | null;
        error_message: string | null;
        stderr_tail: string | null;
        started_at: Date;
        finished_at: Date | null;
      }

      interface QuestionRow {
        id: string;
        type: string;
        topic: string;
        points: number;
        content: unknown;
        knowledge_base_sources: Array<{ id: string }>;
      }

      const dbResult = await wt(tenantId, async (client) => {
        const attemptRes = await client.query<AttemptRow>(
          `SELECT id, status, pack_id, level_id,
                  count_requested, count_inserted,
                  duration_ms, chunks_planned, chunks_failed,
                  dedupe_dropped, citation_dropped,
                  model, skill_sha, error_code, error_message, stderr_tail,
                  started_at, finished_at
             FROM generation_attempts
            WHERE id = $1`,
          [id],
        );

        const attempt = attemptRes.rows[0];
        if (!attempt) return null;

        // Level label — needed to derive L1/L2/L3 for fixture path.
        const levelRes = await client.query<{ label: string }>(
          `SELECT label FROM levels WHERE id = $1`,
          [attempt.level_id],
        );
        const levelLabel = levelRes.rows[0]?.label ?? "";

        // Inserted questions — same filter as cmdScoreCandidate in cli-typed.ts.
        const qParams: unknown[] = [attempt.pack_id, attempt.level_id, attempt.started_at];
        const finishedClause = attempt.finished_at !== null ? "AND created_at <= $4" : "";
        if (attempt.finished_at !== null) qParams.push(attempt.finished_at);

        const questionsRes = await client.query<QuestionRow>(
          `SELECT id, type, topic, points, content, knowledge_base_sources
             FROM questions
            WHERE pack_id = $1 AND level_id = $2
              AND created_at >= $3
              ${finishedClause}
              AND status IN ('ai_draft', 'active')
            ORDER BY created_at ASC`,
          qParams,
        );

        return { attempt, levelLabel, questions: questionsRes.rows };
      });

      if (dbResult === null) {
        throw new NotFoundError(`generation attempt ${id} not found`);
      }

      const { attempt: attemptRow, levelLabel, questions: questionRows } = dbResult;

      // ── Step 2: Determine SOC level from label ─────────────────────────────
      const SOC_LEVELS = ["L1", "L2", "L3"] as const;
      const socLevel: "L1" | "L2" | "L3" =
        SOC_LEVELS.find((l) => levelLabel.includes(l)) ?? "L2";

      // ── Step 3: Load fixture — graceful degradation when missing ───────────
      let fixture: KbSourceRef[];
      let fixtureSkipped = false;

      try {
        fixture = await loadFixture(socLevel);
      } catch {
        fixtureSkipped = true;
        fixture = [];
      }

      // ── Step 4: Map question rows to GoldenQuestion shape ─────────────────
      const candidates: GoldenQuestion[] = questionRows.map((row) => ({
        type: row.type as EvalType,
        topic: row.topic,
        points: row.points,
        content: row.content,
        knowledge_base_source_ids: (row.knowledge_base_sources ?? []).map((s) => s.id),
      }));

      // Build synthetic fixture when no fixture file exists — same as CLI.
      // citationsResolve becomes effectively n/a (passes) for all candidates.
      if (fixtureSkipped) {
        const allSourceIds = new Set(candidates.flatMap((q) => q.knowledge_base_source_ids));
        fixture = Array.from(allSourceIds).map((sid) => ({
          id: sid,
          name: sid,
          citation: sid,
          url: "n/a",
          level_fit: socLevel,
          function: "n/a",
          description: "n/a",
          tags: [],
          kb_version: "n/a",
        }));
      }

      // ── Step 5: Score per candidate, aggregate by type ─────────────────────
      type TypeStats = { total: number; passed: number; failed: number; failures: string[] };
      const byType = new Map<string, TypeStats>();

      for (const [i, candidate] of candidates.entries()) {
        const score = scoreQuestion(candidate, fixture, i);
        const isPass =
          score.schemaValid &&
          score.citationsResolve &&
          score.structuralCompleteness &&
          score.topicNonEmpty;

        const entry: TypeStats = byType.get(candidate.type) ?? {
          total: 0,
          passed: 0,
          failed: 0,
          failures: [],
        };
        entry.total++;
        if (isPass) {
          entry.passed++;
        } else {
          entry.failed++;
          entry.failures.push(...score.failures.slice(0, 2));
        }
        byType.set(candidate.type, entry);
      }

      const perType = Array.from(byType.entries()).map(([type, stats]) => ({
        type,
        total: stats.total,
        passed: stats.passed,
        failed: stats.failed,
        failures: stats.failures.slice(0, 3),
      }));

      const totalPassed = perType.reduce((s, r) => s + r.passed, 0);
      const totalTotal = perType.reduce((s, r) => s + r.total, 0);
      const totalFailed = perType.reduce((s, r) => s + r.failed, 0);

      // ── Step 6: Baseline regression comparison ─────────────────────────────
      const baseline = await loadBaseline();

      type BaselineDiffEntry = { level: string; type: string; was_passed: number; now_passed: number };
      const regressions: BaselineDiffEntry[] = [];
      const improvements: BaselineDiffEntry[] = [];

      for (const [type, stats] of byType.entries()) {
        const key = `${socLevel}-${type}`;
        const base = baseline[key];
        if (base === undefined) continue;
        // Compare pass-rates to handle different question counts vs golden counts.
        const candidateRate = stats.total > 0 ? stats.passed / stats.total : 0;
        const baseRate = base.total > 0 ? base.passed / base.total : 0;
        if (candidateRate < baseRate) {
          regressions.push({ level: socLevel, type, was_passed: base.passed, now_passed: stats.passed });
        } else if (candidateRate > baseRate) {
          improvements.push({ level: socLevel, type, was_passed: base.passed, now_passed: stats.passed });
        }
      }

      // ── Step 7: Runtime threshold comparison ───────────────────────────────
      const thresholds = await loadRuntimeThresholds();
      const runtimeMetrics = scoreRuntimeMetrics(
        {
          chunks_planned: attemptRow.chunks_planned,
          chunks_failed: attemptRow.chunks_failed,
          count_inserted: attemptRow.count_inserted,
          count_requested: attemptRow.count_requested,
        },
        thresholds,
      );

      // ── Step 8: Overall verdict ────────────────────────────────────────────
      // "n/a"         — no fixtures AND no thresholds (degenerate scoring)
      // "regression"  — structural regression vs baseline
      // "warning"     — structural pass but at least one runtime metric fails
      // "pass"        — structural pass + no runtime failures (or no thresholds)
      let overall: "pass" | "regression" | "warning" | "n/a";
      if (fixtureSkipped && !runtimeMetrics.hasThresholds) {
        overall = "n/a";
      } else if (regressions.length > 0) {
        overall = "regression";
      } else if (runtimeMetrics.anyFail) {
        overall = "warning";
      } else {
        overall = "pass";
      }

      // Narrow the runtime metric rows to the serialisable shape expected by the UI
      const runtimeRows: EvalRuntimeMetricRow[] = runtimeMetrics.rows;

      return {
        attempt: {
          id: attemptRow.id,
          status: attemptRow.status,
          count_requested: attemptRow.count_requested,
          count_inserted: attemptRow.count_inserted,
          duration_ms: attemptRow.duration_ms,
          chunks_planned: attemptRow.chunks_planned,
          chunks_failed: attemptRow.chunks_failed,
          dedupe_dropped: attemptRow.dedupe_dropped,
          citation_dropped: attemptRow.citation_dropped,
          model: attemptRow.model,
          skill_sha: attemptRow.skill_sha,
          error_code: attemptRow.error_code,
          error_message: attemptRow.error_message,
          stderr_tail: attemptRow.stderr_tail,
          started_at: attemptRow.started_at.toISOString(),
          finished_at: attemptRow.finished_at?.toISOString() ?? null,
        },
        structural: {
          per_type: perType,
          total: totalTotal,
          passed: totalPassed,
          failed: totalFailed,
          baseline_diff: { regressions, improvements },
        },
        runtime: {
          metrics: runtimeRows,
        },
        overall,
      };
    },
  );
}
