/**
 * Z-152 POST /api/admin/assessments/precheck-invites - body validation and wiring (service mocked).
 * The credit and cap logic itself is covered with a real database in invite-credit-hold.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { AppError, ConflictError } from "@assessiq/core";

const precheckInvites = vi.hoisted(() => vi.fn());
vi.mock("../service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  precheckInvites,
}));

import { registerAssessmentLifecycleRoutes } from "../routes.js";

async function build(role: "admin" | "super_admin" = "admin") {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.toJson() });
    return reply.code(500).send({ error: { code: "INTERNAL", message: String(err) } });
  });
  await registerAssessmentLifecycleRoutes(app, {
    adminOnly: async (req) => {
      (req as { session?: unknown }).session = { tenantId: "t1", userId: "u1", role };
    },
  });
  return app;
}

const post = (app: Awaited<ReturnType<typeof build>>, payload: unknown) =>
  app.inject({ method: "POST", url: "/api/admin/assessments/precheck-invites", payload: payload as object });

beforeEach(() => {
  precheckInvites.mockReset();
  precheckInvites.mockResolvedValue(undefined);
});

describe("POST /api/admin/assessments/precheck-invites", () => {
  it("passes the tenant, the type and the caller's role to the service", async () => {
    const res = await post(await build(), { candidates: 4, delivery_mode: "real", camera_required: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(precheckInvites).toHaveBeenCalledWith("t1", { candidates: 4, deliveryMode: "real", cameraRequired: true }, "u1", false);
  });

  it("camera_required is ignored for a mock; a super admin is passed as skip", async () => {
    await post(await build("super_admin"), { candidates: 1, delivery_mode: "mock", camera_required: true });
    expect(precheckInvites).toHaveBeenCalledWith("t1", { candidates: 1, deliveryMode: "mock", cameraRequired: false }, "u1", true);
  });

  it.each([
    [{ candidates: 0, delivery_mode: "real" }],
    [{ candidates: 201, delivery_mode: "real" }],
    [{ candidates: 1.5, delivery_mode: "real" }],
    [{ candidates: "3", delivery_mode: "real" }],
    [{ candidates: 3, delivery_mode: "fast" }],
    [{ candidates: 3, delivery_mode: "real", camera_required: "yes" }],
    [{}],
  ])("rejects a bad body %j with 4xx and calls nothing", async (body) => {
    const res = await post(await build(), body);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(precheckInvites).not.toHaveBeenCalled();
  });

  it("relays the 409 CREDITS_INSUFFICIENT with its details", async () => {
    precheckInvites.mockRejectedValue(new ConflictError("You need 40 credits.", { details: { code: "CREDITS_INSUFFICIENT", need: 40, available: 10, canInvite: 0, cost: 20 } }));
    const res = await post(await build(), { candidates: 2, delivery_mode: "real" });
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.json())).toContain("CREDITS_INSUFFICIENT");
  });
});
