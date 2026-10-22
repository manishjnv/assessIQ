import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";

vi.mock("../service.js", () => ({
  shouldSampleHelpEvent: () => false,
  recordHelpEvent: vi.fn().mockResolvedValue(undefined),
}));
import { registerHelpTrackRoutes } from "../routes-track.js";

describe("POST /api/help/track rate limit (A6-3)", () => {
  it("runs the injected rateLimit preHandler and honours a 429", async () => {
    const app = Fastify();
    await registerHelpTrackRoutes(app, {
      rateLimit: async (_req, reply) => { await reply.code(429).send({ error: "limited" }); },
    });
    const res = await app.inject({ method: "POST", url: "/api/help/track", payload: { event: "feedback", key: "a.b" } });
    expect(res.statusCode).toBe(429);
  });

  it("still returns 204 when the limiter passes", async () => {
    const app = Fastify();
    await registerHelpTrackRoutes(app, { rateLimit: async () => undefined });
    const res = await app.inject({ method: "POST", url: "/api/help/track", payload: { event: "feedback", key: "a.b" } });
    expect(res.statusCode).toBe(204);
  });
});
