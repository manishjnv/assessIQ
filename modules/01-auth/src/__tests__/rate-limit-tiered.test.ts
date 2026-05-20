/**
 * Redis-free unit coverage for the auth-tier-aware rate-limit redesign
 * (2026-05-20). Tests resolveIpBucketMax(), per-user bucket max selection,
 * and the credentialEndpoint bucket composition — none of which require
 * a live Redis connection (getRedis() is lazy; evalBucket is never reached).
 *
 * Config-mock technique mirrors rate-limit-origin-verify.test.ts:
 * vi.hoisted + vi.mock("@assessiq/core").
 *
 * Invariants verified:
 *   - Pre-MFA admin (totpVerified!==true) is BYTE-IDENTICAL to today's behaviour:
 *     same IP cap (RATE_LIMIT_IP_ADMIN), same user cap (60). No regression.
 *   - Credential cap (RATE_LIMIT_CREDENTIAL=20) applies to credential endpoints
 *     REGARDLESS of session tier — even verified admins get the same 20/min.
 *   - The existing fail-closed throw (ip===null && production) is untouched.
 *   - resolveIpBucketMax is exported for direct unit assertions (see T1-T6).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoist shared stubs BEFORE any vi.mock calls ───────────────────────────────

const { mockConfig, mockEval } = vi.hoisted(() => {
  // Shared Redis eval stub — must be a single instance so the same reference is
  // used both inside evalBucket (via getRedis()) and in the test assertions.
  const mockEval = vi.fn().mockResolvedValue([999, 60]);

  const mockConfig = {
    // New tiered env vars
    RATE_LIMIT_IP_VERIFIED_ADMIN: 5000,
    RATE_LIMIT_USER_VERIFIED_ADMIN: 300,
    RATE_LIMIT_CREDENTIAL: 20,
    // Legacy env vars (unchanged defaults)
    RATE_LIMIT_IP_ADMIN: 100,
    RATE_LIMIT_IP_USER: 30,
    RATE_LIMIT_IP_ANON: 30,
    RATE_LIMIT_IP_APIKEY: 600,
    // Infrastructure
    NODE_ENV: "test" as string,
    ORIGIN_TRUST_MODE: "off" as "off" | "log" | "enforce",
    ORIGIN_VERIFY_SECRET: undefined as string | undefined,
    REDIS_URL: "redis://localhost:6379",
  };

  return { mockConfig, mockEval };
});

vi.mock("@assessiq/core", () => {
  class RateLimitError extends Error {}
  const streamLoggerStub = (_n: string) => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  });
  return {
    config: mockConfig,
    streamLogger: streamLoggerStub,
    RateLimitError,
  };
});

// Mock Redis so evalBucket uses the shared mockEval stub — Redis-free.
// getRedis() always returns the SAME object, so mockEval.mock.calls accumulates
// across evalBucket() invocations within a single test.
vi.mock("../redis.js", () => ({
  getRedis: () => ({ eval: mockEval }),
}));

// Import AFTER vi.mock so all transitive modules see the mock.
import { resolveIpBucketMax, rateLimitMiddleware } from "../middleware/rate-limit.js";
import type { AuthRequest } from "../middleware/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSession(
  role: NonNullable<AuthRequest["session"]>["role"],
  totpVerified: boolean | null = false,
): NonNullable<AuthRequest["session"]> {
  return {
    id: "sess-test",
    userId: "user-test",
    tenantId: "tenant-test",
    role,
    totpVerified: totpVerified === null ? false : totpVerified,
    expiresAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
    lastSeenAt: new Date().toISOString(),
    lastTotpAt: totpVerified ? new Date().toISOString() : null,
  };
}

function makeReq(
  overrides: Partial<AuthRequest> & { headers?: Record<string, string | string[] | undefined> } = {},
): AuthRequest {
  return {
    headers: { "cf-connecting-ip": "10.0.0.1" },
    cookies: {},
    ...overrides,
  } as unknown as AuthRequest;
}

function makeReply() {
  const headers: Record<string, string | number> = {};
  const reply = {
    statusCode: 200,
    headers,
    code(s: number) { reply.statusCode = s; return reply; },
    header(n: string, v: string | number) { headers[n] = v; return reply; },
    send(_p: unknown) { return reply; },
  };
  return reply;
}

// ── Reset mocks between tests ────────────────────────────────────────────────

beforeEach(() => {
  mockConfig.RATE_LIMIT_IP_VERIFIED_ADMIN = 5000;
  mockConfig.RATE_LIMIT_USER_VERIFIED_ADMIN = 300;
  mockConfig.RATE_LIMIT_CREDENTIAL = 20;
  mockConfig.RATE_LIMIT_IP_ADMIN = 100;
  mockConfig.RATE_LIMIT_IP_USER = 30;
  mockConfig.RATE_LIMIT_IP_ANON = 30;
  mockConfig.RATE_LIMIT_IP_APIKEY = 600;
  mockConfig.NODE_ENV = "test";
  mockConfig.ORIGIN_TRUST_MODE = "off";
});

// ── T1-T6: resolveIpBucketMax — tier selection by auth state ─────────────────

describe("resolveIpBucketMax — auth-tier-aware IP bucket selection", () => {
  it("T1: verified admin (role=admin, totpVerified=true) → IP_VERIFIED_ADMIN (5000)", () => {
    const req = makeReq({ session: makeSession("admin", true) });
    expect(resolveIpBucketMax(req)).toBe(mockConfig.RATE_LIMIT_IP_VERIFIED_ADMIN);
  });

  it("T2: verified super_admin (totpVerified=true) → IP_VERIFIED_ADMIN (same path as admin)", () => {
    const req = makeReq({ session: makeSession("super_admin", true) });
    expect(resolveIpBucketMax(req)).toBe(mockConfig.RATE_LIMIT_IP_VERIFIED_ADMIN);
  });

  it("T3: pre-MFA admin (totpVerified=false) → IP_ADMIN (100) — BYTE-IDENTICAL to today", () => {
    const req = makeReq({ session: makeSession("admin", false) });
    expect(resolveIpBucketMax(req)).toBe(mockConfig.RATE_LIMIT_IP_ADMIN);
  });

  it("T3b: pre-MFA reviewer (totpVerified=false) → IP_ADMIN — pre-MFA path unchanged", () => {
    const req = makeReq({ session: makeSession("reviewer", false) });
    expect(resolveIpBucketMax(req)).toBe(mockConfig.RATE_LIMIT_IP_ADMIN);
  });

  it("T4: candidate → IP_USER (30)", () => {
    const req = makeReq({ session: makeSession("candidate", false) });
    expect(resolveIpBucketMax(req)).toBe(mockConfig.RATE_LIMIT_IP_USER);
  });

  it("T5: anon (no session, no apiKey) → IP_ANON (30)", () => {
    const req = makeReq({});
    expect(resolveIpBucketMax(req)).toBe(mockConfig.RATE_LIMIT_IP_ANON);
  });

  it("T6: apiKey (no session) → IP_APIKEY (600)", () => {
    const req = makeReq({
      apiKey: { id: "key-1", tenantId: "tenant-1", scopes: ["results:read"] },
    });
    expect(resolveIpBucketMax(req)).toBe(mockConfig.RATE_LIMIT_IP_APIKEY);
  });

  it("T3c: strict === guard — totpVerified=undefined does NOT reach verified-admin path", () => {
    // Simulates an old session object that may be missing totpVerified entirely.
    const sess = makeSession("admin", false);
    delete (sess as unknown as Record<string, unknown>)["totpVerified"];
    const req = makeReq({ session: sess });
    // Must fall to pre-MFA path (IP_ADMIN), NOT verified-admin path (IP_VERIFIED_ADMIN).
    expect(resolveIpBucketMax(req)).toBe(mockConfig.RATE_LIMIT_IP_ADMIN);
  });

  it("T3d: strict === guard — truthy non-boolean totpVerified does NOT elevate (adversarial finding 7)", () => {
    // TypeScript types totpVerified as boolean, but a corrupted Redis deserialization
    // path could in principle yield a string/number/object. The `=== true` strict
    // equality MUST reject all of these. This pins the invariant against future
    // type erosion at the Redis/JSON boundary.
    for (const bogus of ["true", 1, {}, [], "1", "yes"] as unknown[]) {
      const sess = makeSession("admin", false);
      (sess as unknown as Record<string, unknown>)["totpVerified"] = bogus;
      const req = makeReq({ session: sess });
      expect(resolveIpBucketMax(req)).toBe(mockConfig.RATE_LIMIT_IP_ADMIN);
    }
  });
});

// ── T7-T8: per-user bucket max — tier-aware via rateLimitMiddleware ───────────
//
// redis.eval is called as: eval(LUA, numkeys, key, max, windowSeconds)
//   call[0] = LUA script string
//   call[1] = 1 (numkeys)
//   call[2] = key (e.g. "aiq:rl:user:<userId>")
//   call[3] = max value
//   call[4] = windowSeconds (60)
//
// mockEval is the shared stub (hoisted above) — it's the SAME fn reference that
// getRedis().eval returns, so mock.calls accumulates across all evalBucket() calls.

describe("per-user bucket max — auth-tier-aware", () => {
  beforeEach(() => {
    mockEval.mockClear();
  });

  it("T7: verified admin → user bucket max = USER_VERIFIED_ADMIN (300)", async () => {
    const handler = rateLimitMiddleware();
    const req = makeReq({ session: makeSession("admin", true) });
    await handler(req, makeReply() as unknown as Parameters<typeof handler>[1]);

    // Find the call for the user bucket key (aiq:rl:user:...)
    const userCall = mockEval.mock.calls.find((call: unknown[]) =>
      typeof call[2] === "string" && (call[2] as string).startsWith("aiq:rl:user:"),
    );
    expect(userCall).toBeDefined();
    // 4th positional arg (index 3) is max
    expect(userCall?.[3]).toBe(mockConfig.RATE_LIMIT_USER_VERIFIED_ADMIN);
  });

  it("T8: pre-MFA admin (totpVerified=false) → user bucket max = 60 — unchanged from today", async () => {
    const handler = rateLimitMiddleware();
    const req = makeReq({ session: makeSession("admin", false) });
    await handler(req, makeReply() as unknown as Parameters<typeof handler>[1]);

    const userCall = mockEval.mock.calls.find((call: unknown[]) =>
      typeof call[2] === "string" && (call[2] as string).startsWith("aiq:rl:user:"),
    );
    expect(userCall).toBeDefined();
    expect(userCall?.[3]).toBe(60);
  });

  it("T8b: candidate → user bucket max = 60 — unchanged", async () => {
    const handler = rateLimitMiddleware();
    const req = makeReq({ session: makeSession("candidate", false) });
    await handler(req, makeReply() as unknown as Parameters<typeof handler>[1]);

    const userCall = mockEval.mock.calls.find((call: unknown[]) =>
      typeof call[2] === "string" && (call[2] as string).startsWith("aiq:rl:user:"),
    );
    expect(userCall).toBeDefined();
    expect(userCall?.[3]).toBe(60);
  });
});

// ── T9: credentialEndpoint flag — extra bucket ────────────────────────────────

describe("credentialEndpoint: true — extra credential bucket", () => {
  beforeEach(() => {
    mockEval.mockClear();
  });

  it("T9: credentialEndpoint=true pushes aiq:rl:cred:<path>:<ip> bucket at RATE_LIMIT_CREDENTIAL", async () => {
    const handler = rateLimitMiddleware({ credentialEndpoint: true });
    // Set routeOptions.url so the credential key uses the route pattern, not req.url.
    const req = Object.assign(
      makeReq({ session: makeSession("admin", false) }),
      { routeOptions: { url: "/api/auth/totp/verify" } },
    );
    await handler(req, makeReply() as unknown as Parameters<typeof handler>[1]);

    // Find the credential bucket call (aiq:rl:cred:...)
    const credCall = mockEval.mock.calls.find((call: unknown[]) =>
      typeof call[2] === "string" && (call[2] as string).startsWith("aiq:rl:cred:"),
    );
    expect(credCall).toBeDefined();
    // Key must contain the route path and IP
    expect(credCall?.[2]).toContain("/api/auth/totp/verify");
    expect(credCall?.[2]).toContain("10.0.0.1");
    // 4th arg is max = RATE_LIMIT_CREDENTIAL (20)
    expect(credCall?.[3]).toBe(mockConfig.RATE_LIMIT_CREDENTIAL);
  });

  it("T9b: credentialEndpoint=false (default) — no aiq:rl:cred: bucket pushed", async () => {
    const handler = rateLimitMiddleware();
    const req = makeReq({ session: makeSession("admin", false) });
    await handler(req, makeReply() as unknown as Parameters<typeof handler>[1]);

    const credCall = mockEval.mock.calls.find((call: unknown[]) =>
      typeof call[2] === "string" && (call[2] as string).startsWith("aiq:rl:cred:"),
    );
    expect(credCall).toBeUndefined();
  });

  it("T9c: credential bucket applies even for verified admin (totpVerified=true)", async () => {
    // Core invariant: even the high-IP-cap verified admin hits the credential cap.
    const handler = rateLimitMiddleware({ credentialEndpoint: true });
    const req = Object.assign(
      makeReq({ session: makeSession("admin", true) }),
      { routeOptions: { url: "/api/auth/totp/verify" } },
    );
    await handler(req, makeReply() as unknown as Parameters<typeof handler>[1]);

    const credCall = mockEval.mock.calls.find((call: unknown[]) =>
      typeof call[2] === "string" && (call[2] as string).startsWith("aiq:rl:cred:"),
    );
    expect(credCall).toBeDefined();
    expect(credCall?.[3]).toBe(mockConfig.RATE_LIMIT_CREDENTIAL);

    // IP bucket should be at the verified-admin cap (5000), not the standard admin cap (100)
    const ipCall = mockEval.mock.calls.find((call: unknown[]) =>
      typeof call[2] === "string" && (call[2] as string).startsWith("aiq:rl:ip:"),
    );
    expect(ipCall).toBeDefined();
    expect(ipCall?.[3]).toBe(mockConfig.RATE_LIMIT_IP_VERIFIED_ADMIN);
  });
});
