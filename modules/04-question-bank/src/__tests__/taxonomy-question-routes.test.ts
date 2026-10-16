/**
 * RW-61: question / pack taxonomy routes. No DB: withTenant, audit and the client are mocked.
 * Covers: super-admin gate on PUT, Zod body, 404 on foreign question, unknown node, replace + audit.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

const query = vi.fn();
const audit = vi.fn();
vi.mock("@assessiq/tenancy", () => ({
  withTenant: async (_t: string, fn: (c: unknown) => unknown) => fn({ query }),
}));
vi.mock("@assessiq/audit-log", () => ({ auditInTx: (...a: unknown[]) => audit(...a) }));
vi.mock("../framework-seeds.js", () => ({ listBundledSeeds: vi.fn(), loadFrameworkSeed: vi.fn() }));

import { registerTaxonomyRoutes } from "../taxonomy-routes.js";
import { AppError } from "@assessiq/core";

const QID = "00000000-0000-7000-8000-000000000001";
const N1 = "00000000-0000-7000-8000-0000000000a1";
const N2 = "00000000-0000-7000-8000-0000000000a2";

async function build(role: "admin" | "super_admin") {
  const app = Fastify();
  app.setErrorHandler((err: Error, _req, reply) => {
    const status = err instanceof AppError ? err.status : 500;
    void reply.code(status).send({ message: err.message });
  });
  app.addHook("onRequest", async (req) => {
    (req as unknown as { session: unknown }).session = { tenantId: "t1", userId: "u1", role };
  });
  const pass = async () => {};
  const superGate = async (req: { session?: { role: string } }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (req.session?.role !== "super_admin") return reply.code(403).send({ code: "AUTHZ_FAILED" });
  };
  registerTaxonomyRoutes(app, pass, superGate as never);
  return app;
}

beforeEach(() => { query.mockReset(); audit.mockReset(); });

describe("PUT /api/admin/questions/:id/taxonomy", () => {
  it("tenant admin -> 403", async () => {
    const app = await build("admin");
    const res = await app.inject({ method: "PUT", url: `/api/admin/questions/${QID}/taxonomy`, payload: { node_ids: [] } });
    expect(res.statusCode).toBe(403);
  });

  it("rejects a bad body -> 400", async () => {
    const app = await build("super_admin");
    const res = await app.inject({ method: "PUT", url: `/api/admin/questions/${QID}/taxonomy`, payload: { node_ids: ["nope"] } });
    expect(res.statusCode).toBe(400);
  });

  it("unknown question -> 404", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const app = await build("super_admin");
    const res = await app.inject({ method: "PUT", url: `/api/admin/questions/${QID}/taxonomy`, payload: { node_ids: [N1] } });
    expect(res.statusCode).toBe(404);
  });

  it("node not visible to the tenant -> 400, nothing written", async () => {
    query.mockResolvedValueOnce({ rows: [{}] }).mockResolvedValueOnce({ rows: [{ id: N1 }] });
    const app = await build("super_admin");
    const res = await app.inject({ method: "PUT", url: `/api/admin/questions/${QID}/taxonomy`, payload: { node_ids: [N1, N2] } });
    expect(res.statusCode).toBe(400);
    expect(audit).not.toHaveBeenCalled();
  });

  it("replaces rows and writes one audit row", async () => {
    query
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [{ id: N1 }, { id: N2 }] })
      .mockResolvedValueOnce({ rows: [{ node_id: N1 }] })
      .mockResolvedValue({ rows: [] });
    const app = await build("super_admin");
    const res = await app.inject({ method: "PUT", url: `/api/admin/questions/${QID}/taxonomy`, payload: { node_ids: [N1, N2, N2] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ node_ids: [N1, N2] });
    const sql = query.mock.calls.map((c) => String(c[0]));
    expect(sql.some((q) => q.includes("DELETE FROM question_taxonomy"))).toBe(true);
    expect(sql.some((q) => q.includes("INSERT INTO question_taxonomy"))).toBe(true);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]![1]).toMatchObject({ entityId: QID, tenantId: "t1" });
  });
});

describe("GET taxonomy routes", () => {
  it("question GET returns node ids", async () => {
    query.mockResolvedValueOnce({ rows: [{}] }).mockResolvedValueOnce({ rows: [{ id: N1, label: "A" }] });
    const app = await build("admin");
    const res = await app.inject({ method: "GET", url: `/api/admin/questions/${QID}/taxonomy` });
    expect(res.json().node_ids).toEqual([N1]);
  });

  it("pack GET passes node_id and validates it", async () => {
    query.mockResolvedValueOnce({ rows: [{ question_id: QID, node_id: N1 }] });
    const app = await build("admin");
    const ok = await app.inject({ method: "GET", url: `/api/admin/packs/${QID}/taxonomy?node_id=${N1}` });
    expect(ok.json().items).toHaveLength(1);
    expect(query.mock.calls[0]![1]).toEqual([QID, N1]);
    const bad = await app.inject({ method: "GET", url: `/api/admin/packs/${QID}/taxonomy?node_id=x` });
    expect(bad.statusCode).toBe(400);
  });
});
