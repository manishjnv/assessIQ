/** GATE-8 A1-9: an API-key request (no req.session) gets 401, not a TypeError 500. */
import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { AppError } from "@assessiq/core";

vi.mock("../service.js", () => ({
  getHelpForPage: vi.fn().mockResolvedValue([]),
  getHelpKey: vi.fn().mockResolvedValue({}),
}));

import { registerHelpAuthRoutes } from "../routes-auth.js";

async function build(session?: { tenantId: string }) {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    const e = err as Partial<AppError> & { statusCode?: number };
    void reply.code(e.status ?? e.statusCode ?? 500).send({ error: { message: e.message } });
  });
  await registerHelpAuthRoutes(app, {
    authChain: () => [
      async (req: unknown) => {
        if (session !== undefined) (req as { session?: unknown }).session = session;
      },
    ],
  });
  return app;
}

describe("help auth routes without a session", () => {
  it("GET /api/help and /api/help/:key answer 401 when there is no session", async () => {
    const app = await build();
    expect((await app.inject({ url: "/api/help?page=admin.users" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/help/admin.users.list" })).statusCode).toBe(401);
  });

  it("answers 200 with a session", async () => {
    const app = await build({ tenantId: "t1" });
    expect((await app.inject({ url: "/api/help?page=admin.users" })).statusCode).toBe(200);
  });
});
