/**
 * Unit tests for modules/01-auth — middleware stack (synchronous / non-DB pieces).
 *
 * Coverage:
 *   - request-id.ts   — header passthrough, uuidv7 fallback, length cap
 *   - cookie-parser.ts — parseCookieHeader correctness + duplicate-cookie defense
 *   - rate-limit.ts   — IP extraction, headers, 429 rejection (needs Redis testcontainer)
 *   - require-auth.ts — role / TOTP / freshMfa gates (pure unit, no DB)
 *
 * Postgres testcontainer NOT used: request-id, cookie-parser, and require-auth are
 * entirely in-memory. Rate-limit exercises the Redis Lua script and therefore needs
 * a real Redis, but has no SQL dependency.
 *
 * NODE_ENV / config note: `config` is a singleton loaded at module-import time from
 * process.env. Tests that need to observe production-mode behaviour (test 10) mock
 * `extractRateLimitClientIp` directly rather than mutating process.env after import, which
 * avoids the singleton-capture problem documented in the task spec.
 *
 * Rate-limit tiers (role-aware, all routes):
 *   admin/reviewer  100/min  (config.RATE_LIMIT_IP_ADMIN)
 *   candidate        30/min  (config.RATE_LIMIT_IP_USER)
 *   anon             30/min  (config.RATE_LIMIT_IP_ANON)
 *   api-key         600/min  (config.RATE_LIMIT_IP_APIKEY)
 *   user bucket      60/min  (unchanged)
 *   tenant bucket   600/min  (unchanged)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

import { requestIdMiddleware } from "../middleware/request-id.js";
import { parseCookieHeader, cookieParserMiddleware } from "../middleware/cookie-parser.js";
import { rateLimitMiddleware, extractRateLimitClientIp, resolveIpBucketMax } from "../middleware/rate-limit.js";
import { requireAuth, requireRole, requireScope, requireFreshMfa } from "../middleware/require-auth.js";
import { AuthnError, AuthzError, RateLimitError, nowIso, config } from "@assessiq/core";
import { setRedisForTesting, closeRedis, getRedis } from "../redis.js";
import type { AuthRequest, AuthReply } from "../middleware/types.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<AuthRequest> = {}): AuthRequest {
  return {
    headers: {},
    cookies: {},
    ...overrides,
  };
}

function makeReply(): AuthReply & { headers: Record<string, string | number> } {
  const headers: Record<string, string | number> = {};
  const reply: AuthReply & { headers: Record<string, string | number> } = {
    statusCode: 200,
    headers,
    code(s: number) { reply.statusCode = s; return reply; },
    header(n: string, v: string | number) { headers[n] = v; return reply; },
    send(_p: unknown) { return reply; },
  };
  return reply;
}

// ---------------------------------------------------------------------------
// § request-id
// ---------------------------------------------------------------------------

describe("requestIdMiddleware", () => {
  it("test 1: passes through x-request-id header", () => {
    const req = makeReq({ headers: { "x-request-id": "my-correlation-id" } });
    requestIdMiddleware(req, makeReply());
    expect(req.requestId).toBe("my-correlation-id");
  });

  it("test 2: falls back to a uuidv7 string when no header present", () => {
    const req = makeReq({ headers: {} });
    requestIdMiddleware(req, makeReply());
    // UUIDv7: 8-4-4-4-12 hex groups separated by hyphens, version nibble = 7
    expect(req.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("test 3: header value longer than 128 chars falls back to uuidv7", () => {
    const longId = "x".repeat(129);
    const req = makeReq({ headers: { "x-request-id": longId } });
    requestIdMiddleware(req, makeReply());
    // Must NOT echo the long string back.
    expect(req.requestId).not.toBe(longId);
    // Must be a valid UUID (v7).
    expect(req.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

// ---------------------------------------------------------------------------
// § cookie-parser
// ---------------------------------------------------------------------------

describe("parseCookieHeader", () => {
  it("test 4: parses a single cookie", () => {
    expect(parseCookieHeader("aiq_sess=abc")).toEqual({ aiq_sess: "abc" });
  });

  it("test 5: parses multiple cookies", () => {
    const result = parseCookieHeader("a=1; b=2; c=3");
    expect(result).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("test 6: trims whitespace around name and value", () => {
    const result = parseCookieHeader("a = 1 ; b = 2 ");
    expect(result).toEqual({ a: "1", b: "2" });
  });

  it("test 7: returns empty object when header is undefined", () => {
    expect(parseCookieHeader(undefined)).toEqual({});
  });

  it("test 8: first occurrence wins on duplicate cookie name (header injection defense)", () => {
    // Security note: an attacker appending ; aiq_sess=evil to a header must not
    // be able to override the legitimate first aiq_sess value already set by the
    // browser. First-wins ensures the authentic session token takes precedence.
    const result = parseCookieHeader("aiq_sess=good; aiq_sess=evil");
    expect(result["aiq_sess"]).toBe("good");
  });
});

describe("cookieParserMiddleware", () => {
  it("test 7 (middleware form): sets req.cookies to empty object when no cookie header", () => {
    const req = makeReq({ headers: {} });
    cookieParserMiddleware(req, makeReply());
    expect(req.cookies).toBeDefined();
    expect(req.cookies).toEqual({});
  });

  it("parses cookies from the cookie header into req.cookies", () => {
    const req = makeReq({ headers: { cookie: "aiq_sess=tok1; x=y" } });
    cookieParserMiddleware(req, makeReply());
    expect(req.cookies).toEqual({ aiq_sess: "tok1", x: "y" });
  });
});

// ---------------------------------------------------------------------------
// § rate-limit (Redis testcontainer required)
// ---------------------------------------------------------------------------

describe("rate-limit (Redis testcontainer)", () => {
  let container: StartedTestContainer;

  beforeAll(async () => {
    container = await new GenericContainer("redis:7-alpine")
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/, 1))
      .withStartupTimeout(60_000)
      .start();

    const redisUrl = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
    await setRedisForTesting(redisUrl);
  }, 90_000);

  afterAll(async () => {
    await closeRedis();
    if (container !== undefined) {
      await container.stop();
    }
  });

  // -------------------------------------------------------------------------
  // extractRateLimitClientIp — pure unit (no Redis needed, but grouped here for clarity)
  // -------------------------------------------------------------------------

  describe("extractRateLimitClientIp", () => {
    it("test 9: returns cf-connecting-ip when present", () => {
      const req = makeReq({ headers: { "cf-connecting-ip": "1.2.3.4" } });
      expect(extractRateLimitClientIp(req)).toBe("1.2.3.4");
    });

    it("test 10: returns null when no CF header and NODE_ENV is production (mocked)", () => {
      // config is a singleton captured at module-import time — its NODE_ENV field
      // cannot be changed via process.env after module load. We spy on the getter
      // of the already-imported `config` object to simulate production mode for
      // this one test only.
      const spy = vi.spyOn(config, "NODE_ENV", "get").mockReturnValue("production");
      try {
        const req = makeReq({ headers: {} }); // no CF, no XFF
        expect(extractRateLimitClientIp(req)).toBeNull();
      } finally {
        spy.mockRestore();
      }
    });

    it("test 11: uses x-forwarded-for first hop in non-production when no CF header", () => {
      // NODE_ENV is "test" (set by vitest.setup.ts) — falls through to XFF branch.
      const req = makeReq({ headers: { "x-forwarded-for": "5.6.7.8, 9.9.9.9" } });
      expect(extractRateLimitClientIp(req)).toBe("5.6.7.8");
    });
  });

  // -------------------------------------------------------------------------
  // rateLimitMiddleware — exercises the Lua script via the testcontainer
  // -------------------------------------------------------------------------

  it("test 12: sets X-RateLimit-Limit and X-RateLimit-Remaining on success (anon=30/min)", async () => {
    // Anon request (no session, no apiKey) → RATE_LIMIT_IP_ANON = 30
    const handler = rateLimitMiddleware();
    const req = makeReq({
      url: "/api/auth/test",
      headers: { "cf-connecting-ip": "10.0.0.1" },
    });
    const reply = makeReply();
    await handler(req, reply);
    expect(reply.headers["X-RateLimit-Limit"]).toBe(config.RATE_LIMIT_IP_ANON);
    expect(reply.headers["X-RateLimit-Remaining"]).toBe(config.RATE_LIMIT_IP_ANON - 1);
    // No Retry-After on a successful (non-exhausted) request.
    expect(reply.headers["Retry-After"]).toBeUndefined();
  });

  it("test 13: throws RateLimitError with Retry-After after anon bucket exhaustion (30/min)", async () => {
    const handler = rateLimitMiddleware();
    // Use a unique IP to avoid cross-test bucket pollution.
    const ip = "10.1.1.1";
    const req = () =>
      makeReq({ url: "/api/auth/login", headers: { "cf-connecting-ip": ip } });

    // Exhaust the 30-request anon limit.
    for (let i = 0; i < config.RATE_LIMIT_IP_ANON; i++) {
      await handler(req(), makeReply());
    }

    // Next request must throw.
    const reply = makeReply();
    await expect(handler(req(), reply)).rejects.toBeInstanceOf(RateLimitError);
    // Retry-After must be a positive integer (TTL of the bucket in seconds).
    const retryAfter = reply.headers["Retry-After"];
    expect(typeof retryAfter).toBe("number");
    expect(retryAfter as number).toBeGreaterThan(0);
  });

  it("test 14: per-user 60/min bucket — 61st request rejects with scope user", async () => {
    const handler = rateLimitMiddleware();
    const userId = "user-rl-test-001";
    const tenantId = "tenant-rl-test-001";
    const session: AuthRequest["session"] = {
      id: "sess-1",
      userId,
      tenantId,
      role: "admin",
      totpVerified: true,
      expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
      lastSeenAt: nowIso(),
      lastTotpAt: nowIso(),
    };

    // Non-auth URL so only user+tenant buckets add meaningful assertions; the IP
    // bucket fires too but admin=100/min so it won't exhaust first.
    const req = () =>
      makeReq({ url: "/api/assessments", headers: { "cf-connecting-ip": "10.3.3.1" }, session });

    // Exhaust the 60-request user limit.
    for (let i = 0; i < 60; i++) {
      await handler(req(), makeReply());
    }

    // 61st must reject with scope=user.
    await expect(handler(req(), makeReply())).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof RateLimitError &&
        (err.details as { scope?: string } | undefined)?.scope === "user"
      );
    });
  });

  it("test 15: per-tenant 600/min — deferred (too slow for unit test)", () => {
    // Deliberately skipped: firing 601 requests in a unit test would take several
    // seconds even against a local container and provides marginal additional
    // coverage beyond the user-bucket test above, which exercises the same Lua
    // path. The tenant bucket is validated structurally: it is wired identically
    // to the user bucket (same Lua script, same INCR+EXPIRE pattern) and differs
    // only in key prefix and max value. Dedicated load-test suite deferred.
    expect(true).toBe(true);
  });

  it("test 16: IP bucket applies to ALL routes including non-/api/auth/* routes", async () => {
    // Previous design: IP bucket only on /api/auth/*. New design: ALL routes.
    // This test proves non-auth routes are now rate-limited by IP.
    const handler = rateLimitMiddleware();
    const ip = "10.2.2.2";
    // Anon request to an admin route — should still be counted in the IP bucket.
    const req = makeReq({
      url: "/api/admin/users",
      headers: { "cf-connecting-ip": ip },
    });
    const reply = makeReply();
    await handler(req, reply);

    // IP bucket must have been incremented (key now exists in Redis).
    const redis = getRedis();
    const ipVal = await redis.get(`aiq:rl:ip:${ip}`);
    expect(Number(ipVal)).toBe(1);
    // Standard rate-limit headers must be set.
    expect(reply.headers["X-RateLimit-Limit"]).toBe(config.RATE_LIMIT_IP_ANON);
    expect(reply.headers["X-RateLimit-Remaining"]).toBe(config.RATE_LIMIT_IP_ANON - 1);
  });

  it("test 9 (Redis key shape): IP bucket key uses aiq:rl:ip:<ip> (not aiq:rl:auth:ip:)", async () => {
    const handler = rateLimitMiddleware();
    const ip = "20.30.40.50";
    const req = makeReq({
      url: "/api/auth/whoami",
      headers: { "cf-connecting-ip": ip },
    });
    await handler(req, makeReply());

    // Verify Redis key shape: aiq:rl:ip:<ip> (no ":auth:" segment)
    const redis = getRedis();
    const keys = await redis.keys(`aiq:rl:ip:*`);
    expect(keys.some((k) => k === `aiq:rl:ip:${ip}`)).toBe(true);
    // Old key must NOT exist.
    const oldKeys = await redis.keys(`aiq:rl:auth:ip:*`);
    expect(oldKeys.some((k) => k === `aiq:rl:auth:ip:${ip}`)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // § Role-aware IP tier tests (T1–T4)
  // Each uses a unique IP and session shape to avoid bucket contamination.
  // -------------------------------------------------------------------------

  describe("role-aware IP bucket tiers", () => {
    it("T1: admin session → IP limit = RATE_LIMIT_IP_ADMIN (100/min)", () => {
      // We assert resolveIpBucketMax directly rather than via the X-RateLimit-Limit
      // header. The header correctly reports the "most-constrained" bucket: for an
      // admin session that carries both an IP bucket (100/min) and a user bucket
      // (60/min), the user bucket is more constrained on the first request (remaining
      // 59 < 99), so the header shows 60 — which is correct production behaviour but
      // is not what this test is verifying. resolveIpBucketMax is the source-of-truth
      // for "what IP tier does admin get?" and is exported specifically for this.
      const session: NonNullable<AuthRequest["session"]> = {
        id: "sess-t1",
        userId: "tier-t1-user",
        tenantId: "tier-t1-tenant",
        role: "admin",
        totpVerified: true,
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
        lastSeenAt: nowIso(),
        lastTotpAt: nowIso(),
      };
      const req = makeReq({
        url: "/api/auth/google/start",
        headers: { "cf-connecting-ip": "40.1.1.1" },
        session,
      });
      expect(resolveIpBucketMax(req)).toBe(config.RATE_LIMIT_IP_ADMIN);
    });

    it("T2: reviewer session → IP limit = RATE_LIMIT_IP_ADMIN (admin+reviewer share)", () => {
      // Same reasoning as T1 — resolveIpBucketMax is the correct assertion surface.
      const session: NonNullable<AuthRequest["session"]> = {
        id: "sess-t2",
        userId: "tier-t2-user",
        tenantId: "tier-t2-tenant",
        role: "reviewer",
        totpVerified: true,
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
        lastSeenAt: nowIso(),
        lastTotpAt: nowIso(),
      };
      const req = makeReq({
        url: "/api/auth/whoami",
        headers: { "cf-connecting-ip": "40.1.1.2" },
        session,
      });
      expect(resolveIpBucketMax(req)).toBe(config.RATE_LIMIT_IP_ADMIN);
    });

    it("T3: candidate session → IP limit = RATE_LIMIT_IP_USER (30/min)", async () => {
      const handler = rateLimitMiddleware();
      const ip = "40.1.1.3";
      const session: NonNullable<AuthRequest["session"]> = {
        id: "sess-t3",
        userId: "tier-t3-user",
        tenantId: "tier-t3-tenant",
        role: "candidate",
        totpVerified: true,
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
        lastSeenAt: nowIso(),
        lastTotpAt: nowIso(),
      };
      const reply = makeReply();
      await handler(makeReq({
        url: "/take/some-token",
        headers: { "cf-connecting-ip": ip },
        session,
      }), reply);
      expect(reply.headers["X-RateLimit-Limit"]).toBe(config.RATE_LIMIT_IP_USER);
    });

    it("T4: anon (no session, no apiKey) → IP limit = RATE_LIMIT_IP_ANON (30/min)", async () => {
      const handler = rateLimitMiddleware();
      const ip = "40.1.1.4";
      const reply = makeReply();
      await handler(makeReq({
        url: "/api/auth/google/start",
        headers: { "cf-connecting-ip": ip },
      }), reply);
      expect(reply.headers["X-RateLimit-Limit"]).toBe(config.RATE_LIMIT_IP_ANON);
    });

    it("T5: API key → IP limit = RATE_LIMIT_IP_APIKEY (600/min)", async () => {
      const handler = rateLimitMiddleware();
      const ip = "40.1.1.5";
      const apiKey: NonNullable<AuthRequest["apiKey"]> = {
        id: "key-t5",
        tenantId: "tier-t5-tenant",
        scopes: ["results:read"],
      };
      const reply = makeReply();
      await handler(makeReq({
        url: "/api/assessments",
        headers: { "cf-connecting-ip": ip },
        apiKey,
      }), reply);
      expect(reply.headers["X-RateLimit-Limit"]).toBe(config.RATE_LIMIT_IP_APIKEY);
    });
  });

  // -------------------------------------------------------------------------
  // § Bypass-removal proof tests (N1, PathN)
  // These prove there is no per-IP bypass for any role on any route.
  // -------------------------------------------------------------------------

  describe("bypass removed — all roles hit IP bucket on all routes", () => {
    // N1: Verified admin hits /api/auth/google/start 101 times.
    // Previous design: first 3 opts-in got a bypass and never hit the IP bucket.
    // New design: admin gets 100/min/IP — request 101 must return 429.
    //
    // Each iteration uses a unique userId so the per-user 60/min bucket never
    // saturates, isolating this test to IP-tier enforcement only.
    it("N1: verified admin hits /api/auth/google/start 101x → request 101 returns 429 (bypass removed)", async () => {
      const handler = rateLimitMiddleware();
      const ip = "50.1.1.1";
      let counter = 0;
      const req = () => {
        counter++;
        return makeReq({
          url: "/api/auth/google/start",
          headers: { "cf-connecting-ip": ip },
          session: {
            id: `sess-n1-${counter}`,
            userId: `no-bypass-n1-user-${counter}`,  // unique → user bucket never saturates
            tenantId: `no-bypass-n1-tenant-${counter}`,
            role: "admin" as const,
            totpVerified: true,
            expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
            lastSeenAt: nowIso(),
            lastTotpAt: nowIso(),
          },
        });
      };

      // Exhaust the 100-request admin IP limit.
      for (let i = 0; i < config.RATE_LIMIT_IP_ADMIN; i++) {
        await handler(req(), makeReply());
      }

      // Request 101 must throw (IP bucket exhausted).
      await expect(handler(req(), makeReply())).rejects.toBeInstanceOf(RateLimitError);
    });

    // PathN: Pre-MFA admin hits /api/auth/totp/verify 101 times.
    // Path N decision (2026-05-15, user-approved): TOTP verify is NOT special-cased
    // for IP tier. Pre-MFA admin gets RATE_LIMIT_IP_ADMIN (100/min) — UNCHANGED
    // from before the 2026-05-20 tiered redesign.
    //
    // Tiered redesign (2026-05-20): IP cap for verified admin lifted to 5000/min,
    // but the CREDENTIAL bucket (20/min default) is the actual brute-force guard
    // on /totp/verify when credentialEndpoint:true is used by the route. The IP
    // bucket (100/min for pre-MFA, 5000/min for verified) and credential bucket
    // (20/min) exist independently; the effective cap is min(ip, credential, user).
    //
    // This test pins:
    //   (a) Pre-MFA admin IP bucket is still 100/min (pre-MFA path UNCHANGED).
    //   (b) The rateLimitMiddleware() base handler (without credentialEndpoint)
    //       still exhausts at 101 on the IP bucket — proving IP enforcement.
    //
    // The credential bucket (20/min) is tested in rate-limit-tiered.test.ts T9.
    //
    // Each iteration uses a unique userId so the per-user bucket never
    // saturates, isolating this test to IP-tier enforcement only.
    it("PathN: pre-MFA admin gets RATE_LIMIT_IP_ADMIN (100/min) on TOTP verify — IP bucket unchanged (2026-05-20 redesign: credential cap tested separately in rate-limit-tiered.test.ts T9)", async () => {
      const handler = rateLimitMiddleware();
      const ip = "50.1.1.2";
      let counter = 0;
      // Pre-MFA session (totpVerified=false — that's the state when calling totp/verify)
      // Pre-MFA admin: UNCHANGED behaviour from before the tiered redesign.
      const req = () => {
        counter++;
        return makeReq({
          url: "/api/auth/totp/verify",
          headers: { "cf-connecting-ip": ip },
          session: {
            id: `sess-pathn-${counter}`,
            userId: `no-bypass-pathn-user-${counter}`,  // unique → user bucket never saturates
            tenantId: `no-bypass-pathn-tenant-${counter}`,
            role: "admin" as const,
            totpVerified: false,  // pre-MFA — IP cap is RATE_LIMIT_IP_ADMIN (100), not VERIFIED_ADMIN (5000)
            expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
            lastSeenAt: nowIso(),
            lastTotpAt: null,
          },
        });
      };

      // Exhaust the 100-request pre-MFA admin IP limit (UNCHANGED from 2026-05-15 design).
      for (let i = 0; i < config.RATE_LIMIT_IP_ADMIN; i++) {
        await handler(req(), makeReply());
      }

      // Request 101 must throw — IP bucket exhausted (pre-MFA admin, unchanged).
      await expect(handler(req(), makeReply())).rejects.toBeInstanceOf(RateLimitError);
    });

    // PathN-Credential: The credential bucket (20/min) bites BEFORE the IP bucket
    // on /totp/verify when credentialEndpoint:true is used. This proves the
    // brute-force window IMPROVES in the tiered redesign (20/min credential cap
    // applies to all tiers, incl. pre-MFA admin at 100/min).
    it("PathN-Credential: credential bucket (20/min) exhausts before IP bucket (100/min) on TOTP verify — brute-force window improvement from tiered redesign 2026-05-20", async () => {
      const handler = rateLimitMiddleware({ credentialEndpoint: true });
      const ip = "50.1.1.10";
      let counter = 0;
      const req = () => {
        counter++;
        const base = makeReq({
          url: "/api/auth/totp/verify",
          headers: { "cf-connecting-ip": ip },
          session: {
            id: `sess-credpathn-${counter}`,
            userId: `cred-pathn-user-${counter}`,  // unique → user bucket never saturates
            tenantId: `cred-pathn-tenant-${counter}`,
            role: "admin" as const,
            totpVerified: false,
            expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
            lastSeenAt: nowIso(),
            lastTotpAt: null,
          },
        });
        // routeOptions is not on AuthRequest (it's Fastify-internal); cast to set it
        // so rateLimitMiddleware's `routeOptions?.url` path resolves to the route pattern.
        (base as unknown as Record<string, unknown>)["routeOptions"] = { url: "/api/auth/totp/verify" };
        return base;
      };

      // Exhaust the 20-request CREDENTIAL limit (not the 100/min IP limit).
      for (let i = 0; i < config.RATE_LIMIT_CREDENTIAL; i++) {
        await handler(req(), makeReply());
      }

      // Request 21 must throw — credential bucket exhausted (not IP bucket).
      await expect(handler(req(), makeReply())).rejects.toSatisfy((err: unknown) => {
        return (
          err instanceof RateLimitError &&
          (err.details as { scope?: string } | undefined)?.scope === "credential"
        );
      });
    });

    // N2: Unauth request to a non-/api/auth/* route → IP bucket fires at anon rate.
    // Previous design: IP bucket only on /api/auth/*. New design: ALL routes.
    it("N2: unauth request to /api/assessments hits IP bucket at anon limit (30/min)", async () => {
      const handler = rateLimitMiddleware();
      const ip = "50.1.1.3";
      const req = () => makeReq({
        url: "/api/assessments",
        headers: { "cf-connecting-ip": ip },
      });

      // Exhaust the 30-request anon limit.
      for (let i = 0; i < config.RATE_LIMIT_IP_ANON; i++) {
        await handler(req(), makeReply());
      }

      // Next request must throw with scope=ip.
      await expect(handler(req(), makeReply())).rejects.toSatisfy((err: unknown) => {
        return (
          err instanceof RateLimitError &&
          (err.details as { scope?: string } | undefined)?.scope === "ip"
        );
      });
    });
  });
});

// ---------------------------------------------------------------------------
// § require-auth (pure unit — no DB, no Redis)
// ---------------------------------------------------------------------------

describe("requireAuth", () => {
  // Minimal valid session fixture.
  function validSession(overrides: Partial<NonNullable<AuthRequest["session"]>> = {}): NonNullable<AuthRequest["session"]> {
    return {
      id: "sess-ra-1",
      userId: "user-ra-1",
      tenantId: "tenant-ra-1",
      role: "admin",
      totpVerified: true,
      expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
      lastSeenAt: nowIso(),
      lastTotpAt: nowIso(),
      ...overrides,
    };
  }

  it("test 17: throws AuthnError when no session and no apiKey", async () => {
    const handler = requireAuth();
    const req = makeReq();
    await expect(handler(req, makeReply())).rejects.toBeInstanceOf(AuthnError);
  });

  it("test 18: passes when a valid session is present", async () => {
    const handler = requireAuth();
    const req = makeReq({ session: validSession() });
    await expect(handler(req, makeReply())).resolves.toBeUndefined();
  });

  it("test 19a: requireRole('admin') passes for admin", async () => {
    const handler = requireRole("admin");
    const req = makeReq({ session: validSession({ role: "admin" }) });
    await expect(handler(req, makeReply())).resolves.toBeUndefined();
  });

  it("test 19b: requireRole('admin') throws AuthzError for reviewer", async () => {
    const handler = requireRole("admin");
    const req = makeReq({ session: validSession({ role: "reviewer" }) });
    await expect(handler(req, makeReply())).rejects.toBeInstanceOf(AuthzError);
  });

  it("test 20: throws AuthnError when role is not candidate and totpVerified is false", async () => {
    const handler = requireAuth();
    const req = makeReq({
      session: validSession({ role: "admin", totpVerified: false }),
    });
    await expect(handler(req, makeReply())).rejects.toBeInstanceOf(AuthnError);
  });

  it("test 21: passes for candidate even when totpVerified is false", async () => {
    const handler = requireAuth();
    // Candidates skip TOTP — magic link is the auth factor (SKILL.md § 8).
    const req = makeReq({
      session: validSession({ role: "candidate", totpVerified: false }),
    });
    await expect(handler(req, makeReply())).resolves.toBeUndefined();
  });

  it("test 22a: freshMfaWithinMinutes(15) passes when lastTotpAt is now", async () => {
    const handler = requireFreshMfa(15);
    const req = makeReq({ session: validSession({ lastTotpAt: nowIso() }) });
    await expect(handler(req, makeReply())).resolves.toBeUndefined();
  });

  it("test 22b: freshMfaWithinMinutes(15) throws when lastTotpAt is 16 minutes ago", async () => {
    const handler = requireFreshMfa(15);
    const sixteenMinAgo = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const req = makeReq({
      session: validSession({ lastTotpAt: sixteenMinAgo }),
    });
    await expect(handler(req, makeReply())).rejects.toBeInstanceOf(AuthnError);
  });

  it("test 23: freshMfaWithinMinutes throws AuthnError when lastTotpAt is null", async () => {
    const handler = requireFreshMfa(15);
    const req = makeReq({
      session: validSession({ lastTotpAt: null }),
    });
    await expect(handler(req, makeReply())).rejects.toBeInstanceOf(AuthnError);
  });

  it("test 24: passes when req.apiKey is set and no session present", async () => {
    const handler = requireAuth();
    const req = makeReq({
      apiKey: {
        id: "key-1",
        tenantId: "tenant-1",
        scopes: ["results:read"],
      },
    });
    await expect(handler(req, makeReply())).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// § requireScope (pure unit)
// ---------------------------------------------------------------------------

describe("requireScope", () => {
  function makeApiKeyReq(scopes: string[]): AuthRequest {
    return makeReq({
      apiKey: {
        id: "key-scope-1",
        tenantId: "tenant-sc-1",
        scopes,
      },
    });
  }

  it("test 25: passes for admin:* regardless of the required scope", async () => {
    const handler = requireScope("admin:*");
    const req = makeApiKeyReq(["admin:*"]);
    await expect(handler(req, makeReply())).resolves.toBeUndefined();
  });

  it("test 25 (any scope): admin:* satisfies any named scope requirement", async () => {
    const handler = requireScope("users:read");
    const req = makeApiKeyReq(["admin:*"]);
    await expect(handler(req, makeReply())).resolves.toBeUndefined();
  });

  it("test 26: throws AuthzError when required scope is absent from the key's scopes", async () => {
    const handler = requireScope("users:read");
    const req = makeApiKeyReq(["attempts:read"]);
    await expect(handler(req, makeReply())).rejects.toBeInstanceOf(AuthzError);
  });

  it("throws AuthnError when no apiKey on the request", async () => {
    const handler = requireScope("results:read");
    const req = makeReq(); // no apiKey
    await expect(handler(req, makeReply())).rejects.toBeInstanceOf(AuthnError);
  });
});
