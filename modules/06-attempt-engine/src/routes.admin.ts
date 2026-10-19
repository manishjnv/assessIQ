// AssessIQ — attempt-engine admin route: GET /api/admin/attempts/:id/integrity.
// Counts of recorded integrity events (tab leaves, copy/paste, full-screen exits).
// Not scores, so visible regardless of result-release state. Tenant comes from
// the session, never the URL; RLS on attempt_events scopes the rows.

import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { ValidationError } from "@assessiq/core";
import { getAttemptIntegritySummary, listAttemptsOnOlderVersions } from "./service.js";

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
    return listAttemptsOnOlderVersions(req.session!.tenantId, id.data);
  });
}
