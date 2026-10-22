import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { logPath } from "../log-url.js";

const info = vi.hoisted(() => vi.fn());
vi.mock("@assessiq/core", () => ({
  streamLogger: () => ({ info, warn: info, error: info }),
}));
vi.mock("@assessiq/auth", () => ({ extractClientIp: () => "1.2.3.4" }));

import { registerLogIngestRoutes } from "../routes/_log.js";

describe("logPath (A5-5)", () => {
  it("strips the query string", () => {
    expect(logPath("/embed?token=abc.def.ghi")).toBe("/embed");
    expect(logPath("/api/auth/google/cb?code=x&state=y")).toBe("/api/auth/google/cb");
    expect(logPath("/health")).toBe("/health");
  });
});

describe("POST /api/_log hardening (A5-4, A6-6)", () => {
  beforeEach(() => info.mockClear());
  async function app() {
    const a = Fastify();
    await registerLogIngestRoutes(a);
    return a;
  }
  const post = (a: Awaited<ReturnType<typeof app>>, payload: unknown) =>
    a.inject({ method: "POST", url: "/api/_log", payload: payload as object });

  it("nests client fields under `client`", async () => {
    const a = await app();
    const r = await post(a, { entries: [{ level: "info", msg: "m", ts: 1, fields: { tenantId: "forged", userId: "forged" } }] });
    expect(r.statusCode).toBe(204);
    const obj = info.mock.calls[0]![0] as Record<string, unknown>;
    expect(obj["tenantId"]).toBeUndefined();
    expect(obj["client"]).toEqual({ tenantId: "forged", userId: "forged" });
  });

  it("rejects a field value over 500 chars", async () => {
    const a = await app();
    const r = await post(a, { entries: [{ level: "info", msg: "m", ts: 1, fields: { k: "x".repeat(501) } }] });
    expect(r.statusCode).toBe(400);
  });

  it("rejects a body over 16 KiB", async () => {
    const a = await app();
    const r = await post(a, { entries: [{ level: "info", msg: "m", ts: 1, fields: { a: "x".repeat(400), b: "y".repeat(400) } }], pad: "z".repeat(17 * 1024) });
    expect(r.statusCode).toBe(413);
  });
});
