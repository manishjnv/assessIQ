// EXP-18 part 2: review gate routes (Verify, Needs fix, Withdraw, bulk Verify all, review list).
// Mounted on the adminOnly chain (rate limit, session, tenant context, role admin; super_admin passes the
// hierarchy). The handler checks the role again and the service checks tenant and platform ownership.
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { AuthzError, ValidationError } from "@assessiq/core";
import {
  assertReviewRole, reviewQuestion, bulkVerifyPack, getPackReview, listReviewQueue, getReviewNotes,
  REVIEW_ACTIONS, REVIEW_FILTERS, NOTE_MAX,
  type ReviewActor,
} from "./service/review.js";

const IdParams = z.object({ id: z.string().uuid() });
const ListQuery = z.object({
  state: z.enum(REVIEW_FILTERS).default("open"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const ActionBody = z.object({
  action: z.enum(REVIEW_ACTIONS),
  note: z.string().max(NOTE_MAX).optional(),
});
const VerifyAllBody = z.object({
  confirm: z.literal(true),
  expected_count: z.number().int().min(0).max(100_000).optional(),
  // Z-52: the exact set the admin saw; when present the operation affects exactly this set.
  expected_ids: z.array(z.string().uuid()).max(100_000).optional(),
}).refine((b) => b.expected_count !== undefined || b.expected_ids !== undefined, {
  message: "expected_count or expected_ids is required",
});

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, v: unknown, what: string): T {
  const r = schema.safeParse(v);
  if (!r.success) {
    throw new ValidationError(`invalid ${what}`, { details: { code: "INVALID_PARAM", issues: r.error.issues } });
  }
  return r.data;
}

function actorOf(req: { session?: { tenantId: string; userId: string; role?: string } }): ReviewActor {
  const s = req.session;
  if (s === undefined) throw new AuthzError("session required");
  assertReviewRole(s.role);
  return { tenantId: s.tenantId, userId: s.userId, role: s.role };
}

export function registerReviewRoutes(
  app: FastifyInstance,
  preHandler: preHandlerHookHandler[] | preHandlerHookHandler,
): void {
  // Literal paths on purpose: tools/lint-ui-api-contract.ts matches route strings, not template variables.

  app.get(`/api/admin/packs/:id/review`, { preHandler }, async (req) => {
    const { id } = parse(IdParams, req.params, "params");
    const q = parse(ListQuery, req.query, "query");
    return getPackReview(actorOf(req), id, q.state, q.page, q.pageSize);
  });

  app.get(`/api/admin/review-queue`, { preHandler }, async (req) => {
    const q = parse(ListQuery, req.query, "query");
    return listReviewQueue(actorOf(req), q.state, q.page, q.pageSize);
  });

  app.get(`/api/admin/questions/:id/review-notes`, { preHandler }, async (req) => {
    const { id } = parse(IdParams, req.params, "params");
    return getReviewNotes(actorOf(req), id);
  });

  app.post(`/api/admin/questions/:id/review`, { preHandler }, async (req) => {
    const { id } = parse(IdParams, req.params, "params");
    const body = parse(ActionBody, req.body, "body");
    return reviewQuestion(actorOf(req), id, body.action, body.note);
  });

  app.post(`/api/admin/packs/:id/review/verify-all`, { preHandler }, async (req) => {
    const { id } = parse(IdParams, req.params, "params");
    const body = parse(VerifyAllBody, req.body, "body");
    return bulkVerifyPack(actorOf(req), id, body.expected_count, body.expected_ids);
  });
}
