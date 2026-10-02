/**
 * R11 — sessionLoader status cache (Redis, 30 s, positive-only).
 * Real Redis (testcontainers); withTenant is mocked so DB round trips are counted.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { AuthnError, config } from "@assessiq/core";

const db = vi.hoisted(() => ({
  calls: 0,
  user: { status: "active", deleted_at: null as string | null, erased_at: null as string | null },
  tenant: { status: "active" },
}));

vi.mock("@assessiq/tenancy", () => ({
  withTenant: async (_t: string, fn: (c: unknown) => Promise<unknown>) =>
    fn({
      query: async (sql: string) => {
        if (sql.includes("FROM users")) { db.calls++; return { rows: [{ ...db.user }] }; }
        if (sql.includes("FROM tenants")) { db.calls++; return { rows: [{ ...db.tenant }] }; }
        return { rows: [] };
      },
    }),
}));

import { sessionLoaderMiddleware, SESS_STATUS_TTL_SEC, userStatusKey, tenantStatusKey } from "../middleware/session-loader.js";
import { sessions } from "../sessions.js";
import { setRedisForTesting, closeRedis, getRedis } from "../redis.js";

const TENANT = "00000000-0000-7000-8000-0000000000aa";
const USER = "00000000-0000-7000-8000-0000000000bb";

let container: StartedTestContainer;
let token: string;

async function load(): Promise<{ session?: unknown }> {
  const req: Record<string, unknown> = { headers: {}, cookies: { [config.SESSION_COOKIE_NAME]: token } };
  await sessionLoaderMiddleware()(req as never, {} as never);
  return req;
}

async function newSession(): Promise<void> {
  const out = await sessions.create({
    userId: USER, tenantId: TENANT, role: "admin", totpVerified: true, ip: "1.1.1.1", ua: "t",
  });
  token = out.token;
}

beforeAll(async () => {
  container = await new GenericContainer("redis:7-alpine")
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/, 1))
    .withStartupTimeout(60_000)
    .start();
  await setRedisForTesting(`redis://${container.getHost()}:${container.getMappedPort(6379)}`);
}, 90_000);

afterAll(async () => {
  await closeRedis();
  await container?.stop();
});

beforeEach(async () => {
  await getRedis().flushall();
  db.calls = 0;
  db.user = { status: "active", deleted_at: null, erased_at: null };
  db.tenant = { status: "active" };
  await newSession();
});

describe("sessionLoader status cache (R11)", () => {
  it("miss populates (2 DB checks, 30 s TTL, no PII); hit skips DB", async () => {
    expect((await load()).session).toBeDefined();
    expect(db.calls).toBe(2);
    const r = getRedis();
    expect(await r.get(userStatusKey(USER))).toBe(TENANT);
    expect(await r.get(tenantStatusKey(TENANT))).toBe("1");
    const ttl = await r.ttl(userStatusKey(USER));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(SESS_STATUS_TTL_SEC);

    expect((await load()).session).toBeDefined();
    expect(db.calls).toBe(2); // unchanged: served from cache
  });

  it("TTL expiry forces a fresh DB check, which now rejects", async () => {
    await load();
    db.user.status = "disabled";
    await getRedis().pexpire(userStatusKey(USER), 30);
    await new Promise((r) => setTimeout(r, 120));
    await expect(load()).rejects.toBeInstanceOf(AuthnError);
  });

  it("negatives are never cached", async () => {
    db.user.status = "disabled";
    await expect(load()).rejects.toBeInstanceOf(AuthnError);
    expect(await getRedis().exists(userStatusKey(USER))).toBe(0);
  });

  it("erased user is rejected on the DB check", async () => {
    db.user.erased_at = new Date().toISOString();
    await expect(load()).rejects.toBeInstanceOf(AuthnError);
  });

  it("sessions.destroyAllForUser invalidates the user entry immediately", async () => {
    await load();
    expect(await getRedis().exists(userStatusKey(USER))).toBe(1);
    await sessions.destroyAllForUser(USER, TENANT);
    expect(await getRedis().exists(userStatusKey(USER))).toBe(0);
  });

  it("a cached verdict for a different tenant is not honoured", async () => {
    await getRedis().set(userStatusKey(USER), "some-other-tenant", "EX", 30);
    await load();
    expect(db.calls).toBe(2); // user check went to the DB despite the cached key
  });

  it("sessions.destroyAllForTenant invalidates the tenant entry; suspended tenant then rejects", async () => {
    await load();
    expect(await getRedis().exists(tenantStatusKey(TENANT))).toBe(1);
    await sessions.destroyAllForTenant(TENANT);
    expect(await getRedis().exists(tenantStatusKey(TENANT))).toBe(0);
    await newSession();
    db.tenant.status = "suspended";
    const err = await load().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthnError);
    expect((err as AuthnError).details).toMatchObject({ scope: "tenant" });
  });

  it("status-cache Redis errors fall back to the DB (never fail-open)", async () => {
    const r = getRedis();
    const realGet = r.get.bind(r) as (k: string) => Promise<string | null>;
    const realSet = r.set.bind(r) as (...a: unknown[]) => Promise<unknown>;
    const getSpy = vi.spyOn(r, "get").mockImplementation(((k: string) =>
      k.startsWith("aiq:sess-status") ? Promise.reject(new Error("redis down")) : realGet(k)) as never);
    const setSpy = vi.spyOn(r, "set").mockImplementation(((k: string, ...a: unknown[]) =>
      k.startsWith("aiq:sess-status") ? Promise.reject(new Error("redis down")) : realSet(k, ...a)) as never);
    try {
      expect((await load()).session).toBeDefined();
      expect(db.calls).toBe(2);
      db.user.status = "disabled";
      await expect(load()).rejects.toBeInstanceOf(AuthnError);
    } finally {
      getSpy.mockRestore();
      setSpy.mockRestore();
    }
  });
});
