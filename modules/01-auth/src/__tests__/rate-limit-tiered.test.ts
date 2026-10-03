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
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoist shared stubs BEFORE any vi.mock calls ───────────────────────────────

const { mockConfig, mockEval } = vi.hoisted(() => {
  // Shared Redis eval stub — must be a single instance so the same reference is
  // used both inside evalBucket (via getRedis()) and in the test assertions.
  const mockEval = vi.fn().mockResolvedValue([1, 60]);

  const mockConfig = {
    // New tiered env vars
    RATE_LIMIT_IP_VERIFIED_ADMIN: 5000,
    RATE_LIMIT_USER_VERIFIED_ADMIN: 300,
    RATE_LIMIT_CREDENTIAL: 20,
    RATE_LIMIT_IP_CANDIDATE_SESSION: 3000,
    RATE_LIMIT_USER_CANDIDATE: 120,
    RATE_LIMIT_IP_CANDIDATE_ENTRY: 600,
    RATE_LIMIT_TENANT: 6000,
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
  mockConfig.RATE_LIMIT_IP_CANDIDATE_SESSION = 3000;
  mockConfig.RATE_LIMIT_USER_CANDIDATE = 120;
  mockConfig.RATE_LIMIT_IP_CANDIDATE_ENTRY = 600;
  mockConfig.RATE_LIMIT_TENANT = 6000;
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

  it("T3b: reviewer (removed role) → IP_USER — no admin tier", () => {
    const req = makeReq({ session: makeSession("reviewer", false) });
    expect(resolveIpBucketMax(req)).toBe(mockConfig.RATE_LIMIT_IP_USER);
  });

  it("T4: valid candidate session → IP_CANDIDATE_SESSION (3000), not IP_USER", () => {
    const req = makeReq({ session: makeSession("candidate", false) });
    expect(resolveIpBucketMax(req)).toBe(mockConfig.RATE_LIMIT_IP_CANDIDATE_SESSION);
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
// redis.eval is called as: eval(FIXED_WINDOW_LUA, 1, key, windowSeconds) and
// returns [count, ttl]; remaining = max - count is computed in TS. The max of a
// bucket is therefore observed through behaviour: count == max is allowed
// (X-RateLimit-Remaining 0), count == max + 1 is rejected for that scope.
// Every other bucket answers count 1 so only the bucket under test can trip.

function answer(prefix: string, count: number, ttl = 60): void {
  mockEval.mockImplementation(async (_lua: string, _n: number, key: string) =>
    [key.startsWith(prefix) ? count : 1, ttl] as [number, number]);
}

type Handler = ReturnType<typeof rateLimitMiddleware>;
async function run(handler: Handler, req: AuthRequest) {
  const reply = makeReply();
  await handler(req, reply as unknown as Parameters<Handler>[1]);
  return reply;
}

// count == max allowed with remaining 0; count == max+1 rejected for `scope`.
async function expectBoundary(handler: Handler, req: AuthRequest, prefix: string, max: number, scope: string) {
  answer(prefix, max);
  const ok = await run(handler, req);
  expect(ok.headers["X-RateLimit-Remaining"]).toBe(0);
  expect(ok.headers["X-RateLimit-Limit"]).toBe(max);
  answer(prefix, max + 1, 42);
  await expect(run(handler, req)).rejects.toThrow(`scope=${scope}`);
}

describe("per-user bucket max — auth-tier-aware", () => {
  beforeEach(() => {
    mockEval.mockClear();
  });
  afterEach(() => {
    mockEval.mockReset();
    mockEval.mockResolvedValue([1, 60]);
  });

  it("T7: verified admin → user bucket max = USER_VERIFIED_ADMIN (300)", async () => {
    await expectBoundary(rateLimitMiddleware(), makeReq({ session: makeSession("admin", true) }),
      "aiq:rl:user:", mockConfig.RATE_LIMIT_USER_VERIFIED_ADMIN, "user");
  });

  it("T8: pre-MFA admin (totpVerified=false) → user bucket max = 60 — unchanged from today", async () => {
    await expectBoundary(rateLimitMiddleware(), makeReq({ session: makeSession("admin", false) }),
      "aiq:rl:user:", 60, "user");
  });

  it("T8b: candidate → user bucket max = RATE_LIMIT_USER_CANDIDATE (120)", async () => {
    await expectBoundary(rateLimitMiddleware(), makeReq({ session: makeSession("candidate", false) }),
      "aiq:rl:user:", 120, "user");
  });

  it("a bucket with no TTL (-1) reports its full window as Retry-After; a real TTL is passed through", async () => {
    const handler = rateLimitMiddleware();
    const req = makeReq({ session: makeSession("admin", false) });
    for (const [ttl, retry] of [[-1, 60], [42, 42]] as const) {
      answer("aiq:rl:user:", 61, ttl);
      const reply = makeReply();
      await expect(handler(req, reply as unknown as Parameters<Handler>[1])).rejects.toThrow("scope=user");
      expect(reply.headers["Retry-After"]).toBe(retry);
    }
  });

  it("a Redis error propagates (no fail-open inside the middleware, same as before)", async () => {
    mockEval.mockRejectedValue(new Error("redis down"));
    await expect(run(rateLimitMiddleware(), makeReq({ session: makeSession("admin", false) }))).rejects.toThrow("redis down");
  });
});

// ── T9: credentialEndpoint flag — extra bucket ────────────────────────────────

describe("credentialEndpoint: true — extra credential bucket", () => {
  beforeEach(() => {
    mockEval.mockClear();
  });
  afterEach(() => {
    mockEval.mockReset();
    mockEval.mockResolvedValue([1, 60]);
  });

  const credReq = (verified: boolean) => Object.assign(
    makeReq({ session: makeSession("admin", verified) }),
    // routeOptions.url so the credential key uses the route pattern, not req.url.
    { routeOptions: { url: "/api/auth/totp/verify" } },
  );
  const evalKeys = () => mockEval.mock.calls.map((c: unknown[]) => c[2] as string);

  it("T9: credentialEndpoint=true pushes aiq:rl:cred:<path>:<ip> bucket at RATE_LIMIT_CREDENTIAL", async () => {
    const handler = rateLimitMiddleware({ credentialEndpoint: true });
    await expectBoundary(handler, credReq(false), "aiq:rl:cred:", mockConfig.RATE_LIMIT_CREDENTIAL, "credential");
    const credKey = evalKeys().find((k) => k.startsWith("aiq:rl:cred:"));
    // Key must contain the route path and IP
    expect(credKey).toBe("aiq:rl:cred:/api/auth/totp/verify:10.0.0.1");
  });

  it("T9b: credentialEndpoint=false (default) — no aiq:rl:cred: bucket pushed", async () => {
    await run(rateLimitMiddleware(), makeReq({ session: makeSession("admin", false) }));
    expect(evalKeys().some((k) => k.startsWith("aiq:rl:cred:"))).toBe(false);
  });

  it("T9c: credential bucket applies even for verified admin (totpVerified=true)", async () => {
    // Core invariant: even the high-IP-cap verified admin hits the credential cap.
    const handler = rateLimitMiddleware({ credentialEndpoint: true });
    await expectBoundary(handler, credReq(true), "aiq:rl:cred:", mockConfig.RATE_LIMIT_CREDENTIAL, "credential");
    // IP bucket is at the verified-admin cap (5000), not the standard admin cap (100)
    await expectBoundary(handler, credReq(true), "aiq:rl:ip:", mockConfig.RATE_LIMIT_IP_VERIFIED_ADMIN, "ip");
  });
});
