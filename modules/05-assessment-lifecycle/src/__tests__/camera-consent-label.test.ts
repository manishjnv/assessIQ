/**
 * GET /api/admin/assessments/:id/invitations adds camera_consent ('declined' | null) through the injected
 * enricher. Only invitations with no attempt yet are sent to the enricher, so a candidate who later agreed
 * and started never shows the label. Service stubbed: no database, no cross-module import.
 */
import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";

const rows = vi.hoisted(() => ({
  items: [
    { id: "inv-declined", attempt_id: null },
    { id: "inv-started", attempt_id: "att-1" },
    { id: "inv-none", attempt_id: null },
  ],
}));
vi.mock("../service.js", async (orig) => ({
  ...(await orig<typeof import("../service.js")>()),
  listInvitations: vi.fn(async () => ({ items: rows.items, page: 1, pageSize: 20, total: 3, resendable: 0 })),
}));

import { registerAssessmentLifecycleRoutes } from "../routes.js";

async function call(enricher?: (t: string, ids: string[]) => Promise<string[]>) {
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as unknown as { session: unknown }).session = { tenantId: "t1", userId: "u1", role: "admin" };
  });
  await registerAssessmentLifecycleRoutes(app, { adminOnly: async () => undefined, ...(enricher ? { declinedCameraInvitations: enricher } : {}) });
  const res = await app.inject({ method: "GET", url: "/api/admin/assessments/a1/invitations" });
  return res.json() as { items: Array<{ id: string; camera_consent: string | null }> };
}

describe("invitation list camera_consent", () => {
  it("labels declined rows that have no attempt; skips started rows", async () => {
    const enricher = vi.fn(async () => ["inv-declined", "inv-started"]);
    const body = await call(enricher);
    expect(enricher).toHaveBeenCalledWith("t1", ["inv-declined", "inv-none"]);
    expect(body.items.map((i) => i.camera_consent)).toEqual(["declined", null, null]);
  });

  it("is null for every row when no enricher is wired", async () => {
    const body = await call();
    expect(body.items.every((i) => i.camera_consent === null)).toBe(true);
  });
});
