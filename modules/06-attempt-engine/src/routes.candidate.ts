// AssessIQ — attempt-engine candidate-facing Fastify route layer.
//
// Mounts seven endpoints under /api/me/* per docs/03-api-contract.md
// § "Candidate (self) — `me`":
//
//   GET    /api/me/assessments
//   POST   /api/me/assessments/:id/start
//   GET    /api/me/attempts/:id
//   POST   /api/me/attempts/:id/answer
//   POST   /api/me/attempts/:id/flag
//   POST   /api/me/attempts/:id/event
//   POST   /api/me/attempts/:id/submit
//   GET    /api/me/attempts/:id/result
//
// Auth chain: candidate-only — `roles: ['candidate']`. Phase 1 admin
// preview/result is OUT of scope here; admin-side attempt routes will land
// alongside grading in Phase 2.
//
// Errors flow through the global Fastify error handler in apps/api/src/server.ts;
// this layer does not try/catch service throws.

import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { ValidationError, NotFoundError } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import {
  startAttempt,
  getAttemptForCandidate,
  saveAnswer,
  toggleFlag,
  recordEvent,
  submitAttempt,
} from "./service.js";
import * as repo from "./repository.js";
import { AE_ERROR_CODES } from "./types.js";
import type { RecordEventInput, SaveAnswerInput, ToggleFlagInput } from "./types.js";

// ---------------------------------------------------------------------------
// Plugin registrar
// ---------------------------------------------------------------------------

export interface RegisterAttemptCandidateRoutesOptions {
  /**
   * The candidate auth-chain — `authChain({ roles: ['candidate'] })` from
   * apps/api. Same DI shape as 04-question-bank / 05-assessment-lifecycle so
   * the module stays Fastify-shape-compatible without a hard apps/api dep.
   */
  candidateOnly: preHandlerHookHandler[] | preHandlerHookHandler;
}

export async function registerAttemptCandidateRoutes(
  app: FastifyInstance,
  opts: RegisterAttemptCandidateRoutesOptions,
): Promise<void> {
  const { candidateOnly } = opts;

  // -------------------------------------------------------------------------
  // GET /api/me/assessments — assessments this candidate is invited to
  // -------------------------------------------------------------------------
  //
  // Listing is read-only against assessment_invitations + assessments. Implemented
  // inline as a small SQL JOIN since module 05's invitation listing is admin-
  // facing and would expose more fields than a candidate should see.

  app.get(
    "/api/me/assessments",
    { preHandler: candidateOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;

      return withTenant(tenantId, async (client) => {
        interface Row {
          assessment_id: string;
          name: string;
          description: string | null;
          status: string;
          opens_at: Date | null;
          closes_at: Date | null;
          duration_minutes: number;
          invitation_status: string;
          invitation_expires_at: Date;
        }
        const result = await client.query<Row>(
          `SELECT
             a.id              AS assessment_id,
             a.name            AS name,
             a.description     AS description,
             a.status          AS status,
             a.opens_at        AS opens_at,
             a.closes_at       AS closes_at,
             l.duration_minutes AS duration_minutes,
             ai.status         AS invitation_status,
             ai.expires_at     AS invitation_expires_at
           FROM assessment_invitations ai
           JOIN assessments a ON a.id = ai.assessment_id
           JOIN levels      l ON l.id = a.level_id
           WHERE ai.user_id = $1
             AND ai.status IN ('pending', 'viewed', 'started')
             AND a.status IN ('published', 'active')
           ORDER BY a.created_at DESC, a.id DESC`,
          [userId],
        );
        return { items: result.rows };
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/me/assessments/:id/start — create or return existing attempt
  // -------------------------------------------------------------------------

  app.post(
    "/api/me/assessments/:id/start",
    { preHandler: candidateOnly },
    async (req, reply) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id } = req.params as { id: string };

      const attempt = await startAttempt(tenantId, {
        userId,
        assessmentId: id,
      });
      return reply.code(201).send(attempt);
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/me/attempts/:id — full attempt view (server-authoritative timer)
  // -------------------------------------------------------------------------

  app.get(
    "/api/me/attempts/:id",
    { preHandler: candidateOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id } = req.params as { id: string };
      return getAttemptForCandidate(tenantId, id, userId);
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/me/attempts/:id/answer
  // -------------------------------------------------------------------------

  app.post(
    "/api/me/attempts/:id/answer",
    { preHandler: candidateOnly },
    async (req, reply) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id } = req.params as { id: string };
      const body = req.body as Record<string, unknown>;

      const questionId = body["question_id"];
      if (typeof questionId !== "string" || questionId.length === 0) {
        throw new ValidationError("question_id is required", {
          details: { code: AE_ERROR_CODES.INVALID_PARAM, param: "question_id" },
        });
      }
      if (body["answer"] === undefined) {
        throw new ValidationError("answer is required", {
          details: { code: AE_ERROR_CODES.INVALID_PARAM, param: "answer" },
        });
      }

      const input: SaveAnswerInput = {
        attemptId: id,
        questionId,
        answer: body["answer"],
      };
      if (typeof body["client_revision"] === "number") {
        input.client_revision = body["client_revision"];
      }
      if (typeof body["edits_count"] === "number") {
        input.edits_count = body["edits_count"];
      }
      if (typeof body["time_spent_seconds"] === "number") {
        input.time_spent_seconds = body["time_spent_seconds"];
      }

      const result = await saveAnswer(tenantId, userId, input);
      return reply.code(204).header("X-Client-Revision", String(result.client_revision)).send();
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/me/attempts/:id/flag
  // -------------------------------------------------------------------------

  app.post(
    "/api/me/attempts/:id/flag",
    { preHandler: candidateOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id } = req.params as { id: string };
      const body = req.body as Record<string, unknown>;

      const questionId = body["question_id"];
      if (typeof questionId !== "string" || questionId.length === 0) {
        throw new ValidationError("question_id is required", {
          details: { code: AE_ERROR_CODES.INVALID_PARAM, param: "question_id" },
        });
      }
      if (typeof body["flagged"] !== "boolean") {
        throw new ValidationError("flagged must be a boolean", {
          details: { code: AE_ERROR_CODES.INVALID_PARAM, param: "flagged" },
        });
      }

      const input: ToggleFlagInput = {
        attemptId: id,
        questionId,
        flagged: body["flagged"],
      };
      return toggleFlag(tenantId, userId, input);
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/me/attempts/:id/event
  // -------------------------------------------------------------------------

  app.post(
    "/api/me/attempts/:id/event",
    { preHandler: candidateOnly },
    async (req, reply) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id } = req.params as { id: string };
      const body = req.body as Record<string, unknown>;

      const eventType = body["event_type"];
      if (typeof eventType !== "string" || eventType.length === 0) {
        throw new ValidationError("event_type is required", {
          details: { code: AE_ERROR_CODES.INVALID_PARAM, param: "event_type" },
        });
      }

      const input: RecordEventInput = {
        attemptId: id,
        event_type: eventType,
      };
      if (typeof body["question_id"] === "string") {
        input.question_id = body["question_id"];
      }
      if (body["payload"] !== undefined) {
        input.payload = body["payload"];
      }

      const event = await recordEvent(tenantId, userId, input);
      // Drop / cap returns null — surface as 204 (success but no body so the
      // candidate cannot infer whether the rate cap fired).
      if (event === null) {
        return reply.code(204).send();
      }
      return reply.code(201).send(event);
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/me/attempts/:id/submit
  // -------------------------------------------------------------------------

  app.post(
    "/api/me/attempts/:id/submit",
    { preHandler: candidateOnly },
    async (req, reply) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id } = req.params as { id: string };

      const result = await submitAttempt(tenantId, userId, id);
      // Phase 1 stops at 'submitted' — the response shape promises a future
      // grading status; the body { status: 'grading' } is preserved in the
      // contract but the actual attempt.status is 'submitted'. Per
      // docs/03-api-contract.md Worked example § 4 (`/submit → 202`).
      return reply.code(202).send({
        attempt_id: result.attempt.id,
        status: "submitted",
        // Phase 1 placeholder — Phase 2 will replace with a real ETA once
        // the grading job is enqueued. Keep the field so the SDK shape
        // doesn't change between phases.
        estimated_grading_seconds: null,
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/me/attempts/:id/result — Phase 1: returns 202 grading-pending
  // -------------------------------------------------------------------------

  app.get(
    "/api/me/attempts/:id/result",
    { preHandler: candidateOnly },
    async (req, reply) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id } = req.params as { id: string };

      return withTenant(tenantId, async (client) => {
        const attempt = await repo.findAttemptById(client, id);
        if (attempt === null) {
          throw new NotFoundError(`Attempt not found: ${id}`, {
            details: { code: AE_ERROR_CODES.ATTEMPT_NOT_FOUND },
          });
        }
        if (attempt.user_id !== userId) {
          throw new NotFoundError(`Attempt not found: ${id}`, {
            details: { code: AE_ERROR_CODES.ATTEMPT_NOT_FOUND },
          });
        }
        // Phase 1: every result endpoint returns 202 grading-pending until
        // module 07 + 08 land in Phase 2. The `attempt.status` itself can be
        // 'submitted', 'auto_submitted', 'pending_admin_grading', or 'graded'
        // — but candidates only see results after 'released', which never
        // happens in Phase 1.
        return reply.code(202).send({
          attempt_id: attempt.id,
          status: "grading_pending",
          message:
            "Your attempt is submitted. Results will be available after admin review.",
        });
      });
    },
  );
}
