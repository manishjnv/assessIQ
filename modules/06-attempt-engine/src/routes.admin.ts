// AssessIQ — attempt-engine admin route: GET /api/admin/attempts/:id/integrity.
// Counts of recorded integrity events (tab leaves, copy/paste, full-screen exits).
// Not scores, so visible regardless of result-release state. Tenant comes from
// the session, never the URL; RLS on attempt_events scopes the rows.

import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { ValidationError } from "@assessiq/core";
import { getAttemptIntegritySummary, listAttemptsOnOlderVersions, setAffectedAttemptReview } from "./service.js";

export interface RegisterAttemptAdminRoutesOptions {
  adminOnly: preHandlerHookHandler[] | preHandlerHookHandler;
}

export async function registerAttemptAdminRoutes(
  app: FastifyInstance,
  opts: RegisterAttemptAdminRoutesOptions,
): Promise<void> {
  app.get("/api/admin/attempts/:id/integrity", { preHandler: opts.adminOnly }, async (req) => {
    const id = z.string().uuid().safeParse((req.params as { id: string }).id);
    if (!id.success) throw new ValidationError("invalid attempt id");
    return getAttemptIntegritySummary(req.session!.tenantId, id.data);
  });

  // EXP-12: finished attempts that froze an older version of this question. Read only.
  app.get("/api/admin/questions/:id/affected-attempts", { preHandler: opts.adminOnly }, async (req) => {
    const id = z.string().uuid().safeParse((req.params as { id: string }).id);
    if (!id.success) throw new ValidationError("invalid question id");
    const q = z.object({ reviewed: z.enum(["yes", "no"]).optional() }).safeParse(req.query);
    if (!q.success) throw new ValidationError("invalid reviewed filter");
    return listAttemptsOnOlderVersions(req.session!.tenantId, id.data, q.data.reviewed ? { reviewed: q.data.reviewed } : {});
  });

  // EXP-12 wave 1: manual review mark. Writes a note row + audit row only; never a mark, status or certificate.
  app.put(
    "/api/admin/questions/:questionId/affected-attempts/:attemptId/review",
    { preHandler: opts.adminOnly },
    async (req) => {
      const p = z.object({ questionId: z.string().uuid(), attemptId: z.string().uuid() }).safeParse(req.params);
      if (!p.success) throw new ValidationError("invalid id");
      const b = z
        .object({ outcome: z.enum(["no_change_needed", "needs_follow_up"]), note: z.string().max(1000).nullish() })
        .strict()
        .safeParse(req.body);
      if (!b.success) throw new ValidationError("invalid review body");
      const note = b.data.note?.trim() ? b.data.note.trim() : null;
      return setAffectedAttemptReview(req.session!.tenantId, req.session!.userId, p.data.questionId, p.data.attemptId, {
        outcome: b.data.outcome,
        note,
      });
    },
  );
}
