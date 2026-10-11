/**
 * RW-56: POST /api/admin/domains + /api/admin/categories are super-admin only.
 * No DB: handlers are mocked; the gates are stubbed by session role.
 */
import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";

vi.mock("../handlers/admin-domains.js", () => ({
  handleAdminListDomains: vi.fn(),
  handleAdminListCategories: vi.fn(),
  handleAdminCreateDomain: vi.fn().mockResolvedValue({ id: "d1", name: "X" }),
  handleAdminCreateCategory: vi.fn().mockResolvedValue({ id: "c1", name: "X" }),
}));

import { registerQuestionBankRoutes } from "../routes.js";

const DOMAIN_ID = "00000000-0000-7000-8000-000000000001";

async function build(role: "admin" | "super_admin") {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as unknown as { session: unknown }).session = { tenantId: "t1", role };
  });
  const adminOnly = async () => {};
  const superAdminOnly = async (
    req: { session?: { role: string } },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ) => {
    if (req.session?.role !== "super_admin") return reply.code(403).send({ code: "AUTHZ_FAILED" });
  };
  await registerQuestionBankRoutes(app, { adminOnly, superAdminOnly } as never);
  return app;
}

const calls = [
  ["/api/admin/domains", { name: "Dom" }],
  ["/api/admin/categories", { domain_id: DOMAIN_ID, name: "Cat" }],
] as const;

describe("RW-56 taxonomy write gate", () => {
  for (const [url, payload] of calls) {
    it(`tenant admin POST ${url} -> 403`, async () => {
      const app = await build("admin");
      const res = await app.inject({ method: "POST", url, payload });
      expect(res.statusCode).toBe(403);
    });
    it(`super admin POST ${url} -> 201`, async () => {
      const app = await build("super_admin");
      const res = await app.inject({ method: "POST", url, payload });
      expect(res.statusCode).toBe(201);
    });
  }
});
