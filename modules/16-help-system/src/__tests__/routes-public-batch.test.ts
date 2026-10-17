/**
 * Anonymous GET /api/help/public allowlist + rate-limit tests (service mocked;
 * tenant-override isolation of null-tenant reads is covered in help-system.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

const getHelpForPage = vi.fn();
vi.mock("../service.js", () => ({
  getHelpForPage: (...a: unknown[]) => getHelpForPage(...a),
  getHelpKey: vi.fn(),
}));

import { registerHelpPublicRoutes } from "../routes-public.js";
import { registerHelpAuthRoutes } from "../routes-auth.js";

const ROW = { key: "candidate.take.landing.logo", audience: "candidate", locale: "en", shortText: "x", longMd: null };

async function build(rateLimit?: (req: unknown, reply: { code: (n: number) => { send: (b: unknown) => void } }) => Promise<void>) {
  const app = Fastify();
  app.setErrorHandler((err: { statusCode?: number; message: string }, _req, reply) => {
    void reply.code(err.statusCode ?? 400).send({ error: { message: err.message } });
  });
  await registerHelpPublicRoutes(app, rateLimit ? { rateLimit: rateLimit as never } : {});
  return app;
}

describe("GET /api/help/public", () => {
  beforeEach(() => {
    getHelpForPage.mockReset().mockResolvedValue([ROW]);
  });

  it("anonymous candidate.take -> 200, globals-only candidate audience, short public cache", async () => {
    const app = await build(async () => undefined);
    const res = await app.inject({ url: "/api/help/public?page=candidate.take" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([ROW]);
    expect(getHelpForPage).toHaveBeenCalledWith(null, "candidate.take", "candidate", "en");
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it.each([
    "admin.users.list",
    "candidate.attemptX",
    "candidate.attempt.timer",
    "candidate",
    "candidate.takeover",
    "candidate.take.landing",
    "candidate.take%",
    "",
  ])("rejects page %j without touching the DB", async (page) => {
    const app = await build(async () => undefined);
    const res = await app.inject({ url: `/api/help/public?page=${page}` });
    expect(res.statusCode).toBe(400);
    expect(getHelpForPage).not.toHaveBeenCalled();
  });

  it("candidate.attempt allowed; each page passes only its own prefix to the service", async () => {
    const app = await build(async () => undefined);
    for (const page of ["candidate.attempt", "candidate.take"]) {
      getHelpForPage.mockClear();
      const res = await app.inject({ url: `/api/help/public?page=${page}` });
      expect(res.statusCode).toBe(200);
      expect(getHelpForPage).toHaveBeenCalledTimes(1);
      expect(getHelpForPage).toHaveBeenCalledWith(null, page, "candidate", "en");
    }
  });

  it("ignores caller-supplied audience", async () => {
    const app = await build(async () => undefined);
    await app.inject({ url: "/api/help/public?page=candidate.take&audience=admin" });
    expect(getHelpForPage).toHaveBeenCalledWith(null, "candidate.take", "candidate", "en");
  });

  it("rejects bad locale", async () => {
    const app = await build(async () => undefined);
    const res = await app.inject({ url: "/api/help/public?page=candidate.take&locale=%27;--" });
    expect(res.statusCode).toBe(400);
  });

  it("rate limiter runs first and its 429 blocks the read", async () => {
    const app = await build(async (_req, reply) => {
      void reply.code(429).send({ error: { message: "rate" } });
    });
    const res = await app.inject({ url: "/api/help/public?page=candidate.take" });
    expect(res.statusCode).toBe(429);
    expect(getHelpForPage).not.toHaveBeenCalled();
  });

  it("route is not registered without a rate limiter (fail-closed)", async () => {
    const app = await build();
    const res = await app.inject({ url: "/api/help/public?page=candidate.take" });
    expect(res.statusCode).toBe(404);
  });

  it("authenticated GET /api/help is still auth-gated and coexists", async () => {
    const app = await build(async () => undefined);
    await registerHelpAuthRoutes(app, {
      authChain: () => [
        async (_req, reply) => {
          (reply as { code: (n: number) => { send: (b: unknown) => void } }).code(401).send({ error: { message: "auth" } });
        },
      ],
    });
    const res = await app.inject({ url: "/api/help?page=candidate.take" });
    expect(res.statusCode).toBe(401);
  });
});
