// AssessIQ — modules/09-scoring Fastify route registrar.
//
// Phase 2 G2.B Session 3.
//
// Four admin-gated endpoints per PHASE_2_KICKOFF.md § Session 3 scope:
//   GET /api/admin/attempts/:id/score            — score row for one attempt
//   GET /api/admin/reports/cohort/:assessmentId  — cohort aggregate stats
//   GET /api/admin/reports/individual/:userId    — progression for one candidate
//   GET /api/admin/reports/leaderboard/:assessmentId?topN=&anonymize= — top-N
//
// All paths start with /api/ — covered by the Caddy @api matcher; no edge-routing
// lint violation.
//
// Multi-tenancy: tenantId always read from req.session (never URL/body).
// Auth: all routes require admin role; caller injects the preHandler chain.

import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { ValidationError } from "@assessiq/core";
import {
  computeAttemptScore,
  getAttemptScoreRow,
  cohortStats,
  leaderboard,
  individualReport,
} from "./service.js";

// ---------------------------------------------------------------------------
// DI options — mirrors the pattern in modules/07-ai-grading/src/routes.ts
// ---------------------------------------------------------------------------

export interface RegisterScoringRoutesOptions {
  /** Admin-gated preHandler — `authChain({ roles: ['admin'] })` from apps/api. */
  adminOnly: preHandlerHookHandler[] | preHandlerHookHandler;
}

// ---------------------------------------------------------------------------
// Inline Zod schemas
// ---------------------------------------------------------------------------

const LEADERBOARD_QUERY_SCHEMA = z.object({
  topN: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? parseInt(v, 10) : 10))
    .pipe(z.number().int().min(1).max(200)),
  anonymize: z
    .string()
    .optional()
    .transform((v) => v === "true"),
});

// ---------------------------------------------------------------------------
// Route registrar
// ---------------------------------------------------------------------------

export async function registerScoringRoutes(
  app: FastifyInstance,
  opts: RegisterScoringRoutesOptions,
): Promise<void> {
  const { adminOnly } = opts;
  const preHandler = Array.isArray(adminOnly) ? adminOnly : [adminOnly];

  // GET /api/admin/attempts/:id/score
  // Returns the current score row (computes on demand if not yet present).
  app.get(
    "/api/admin/attempts/:id/score",
    { preHandler },
    async (req, reply) => {
      const tenantId = (req as unknown as { session: { tenantId: string } }).session
        .tenantId;
      const attemptId = (req.params as { id: string }).id;

      // Try cached row first; if absent, compute on demand.
      let score = await getAttemptScoreRow(tenantId, attemptId);
      if (score === null) {
        score = await computeAttemptScore(tenantId, attemptId);
      }

      return reply.code(200).send({ score });
    },
  );

  // GET /api/admin/reports/cohort/:assessmentId
  app.get(
    "/api/admin/reports/cohort/:assessmentId",
    { preHandler },
    async (req, reply) => {
      const tenantId = (req as unknown as { session: { tenantId: string } }).session
        .tenantId;
      const { assessmentId } = req.params as { assessmentId: string };

      const stats = await cohortStats(tenantId, assessmentId);
      return reply.code(200).send({ stats });
    },
  );

  // GET /api/admin/reports/individual/:userId
  app.get(
    "/api/admin/reports/individual/:userId",
    { preHandler },
    async (req, reply) => {
      const tenantId = (req as unknown as { session: { tenantId: string } }).session
        .tenantId;
      const { userId } = req.params as { userId: string };

      const scores = await individualReport(tenantId, userId);
      return reply.code(200).send({ scores });
    },
  );

  // GET /api/admin/reports/leaderboard/:assessmentId?topN=10&anonymize=false
  app.get(
    "/api/admin/reports/leaderboard/:assessmentId",
    { preHandler },
    async (req, reply) => {
      const tenantId = (req as unknown as { session: { tenantId: string } }).session
        .tenantId;
      const { assessmentId } = req.params as { assessmentId: string };

      const parseResult = LEADERBOARD_QUERY_SCHEMA.safeParse(req.query);
      if (!parseResult.success) {
        throw new ValidationError(
          "Invalid query parameters",
          { details: { issues: parseResult.error.issues } },
        );
      }
      const { topN, anonymize } = parseResult.data;

      const rows = await leaderboard(tenantId, assessmentId, {
        topN,
        anonymize,
      });
      return reply.code(200).send({ leaderboard: rows });
    },
  );
}
