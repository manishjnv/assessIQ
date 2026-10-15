// RW-93 — POST /api/admin/generate/start (no DB; generation + pack lookup mocked).
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { AppError } from "@assessiq/core";

const genMock = vi.fn();
let failWith: unknown = null; // plain throw: vitest reports a throwing vi.fn as a test error
vi.mock("../service/generation.js", async (orig) => ({
  ...(await orig<object>()),
  generateQuestions: async (...a: unknown[]) => { if (failWith) throw failWith; return genMock(...a); },
}));
// markFailed (best effort) must not reach a real pool in this DB-less test.
vi.mock("@assessiq/tenancy", async (orig) => ({ ...(await orig<object>()), withTenant: async () => undefined }));
vi.mock("../service.js", async (orig) => ({
  ...(await orig<object>()),
  findOrCreatePackForDomain: async () => ({ packId: "p1", levelIds: { L1: "l1", L2: "l2", L3: "l3" } }),
}));

import { registerQuestionBankRoutes } from "../routes.js";

const DOMAIN = "0190a000-0000-7000-8000-000000000001";

async function app() {
  const a = Fastify({ logger: false });
  a.addHook("preHandler", async (req) => {
    (req as unknown as { session: object }).session = { tenantId: "t1", userId: "u1" };
  });
  a.setErrorHandler((err: AppError, _req, reply) => {
    void reply.code(err.status ?? 500).send({ code: err.code });
  });
  await registerQuestionBankRoutes(a, { adminOnly: [], superAdminOnly: [] });
  await a.ready();
  return a;
}

beforeEach(() => { genMock.mockReset(); failWith = null; });

describe("POST /api/admin/generate/start", () => {
  it("returns 202 with the attempt id", async () => {
    genMock.mockImplementation(() => new Promise(() => undefined)); // run stays in flight
    const r = await (await app()).inject({ method: "POST", url: "/api/admin/generate/start", payload: { domain_id: DOMAIN, level: "L1", count: 2 } });
    expect(r.statusCode).toBe(202);
    expect(r.json().attempt_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
    expect(r.json().attempt_id).toBe(genMock.mock.calls[0]!.at(-1));
    expect(genMock.mock.calls[0]!.slice(0, 5)).toEqual(["t1", "u1", "p1", "l1", 2]);
  });

  it("passes the single-flight 409 through", async () => {
    failWith = new AppError("in flight", "AIG_GRADING_IN_PROGRESS", 409);
    const r = await (await app()).inject({ method: "POST", url: "/api/admin/generate/start", payload: { domain_id: DOMAIN, level: "L1", count: 2 } });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("AIG_GRADING_IN_PROGRESS");
  });

  it("forwards a trimmed topic_focus and rejects an over-long one", async () => {
    genMock.mockImplementation(() => new Promise(() => undefined));
    const a = await app();
    const ok = await a.inject({ method: "POST", url: "/api/admin/generate/start", payload: { domain_id: DOMAIN, level: "L1", count: 2, topic_focus: "  phishing  " } });
    expect(ok.statusCode).toBe(202);
    expect(genMock.mock.calls[0]![5]).toBe("phishing");
    const bad = await a.inject({ method: "POST", url: "/api/admin/generate/start", payload: { domain_id: DOMAIN, level: "L1", count: 2, topic_focus: "x".repeat(201) } });
    expect(bad.statusCode).toBe(400);
    expect(genMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a bad body before starting anything", async () => {
    const r = await (await app()).inject({ method: "POST", url: "/api/admin/generate/start", payload: { domain_id: DOMAIN, level: "L9", count: 2 } });
    expect(r.statusCode).toBe(400);
    const r2 = await (await app()).inject({ method: "POST", url: "/api/admin/generate/start", payload: { domain_id: DOMAIN, level: "L1", count: 99 } });
    expect(r2.statusCode).toBe(400);
    expect(genMock).not.toHaveBeenCalled();
  });
});
