/**
 * Campus-drive rate-limit coverage (real Redis testcontainer).
 *
 * Scenario: 100-500 students in one lab behind ONE public IP, all taking a test
 * at once. Proves the per-IP bucket is not the binding constraint for valid
 * candidate sessions, the per-user bucket still is, anonymous traffic keeps its
 * cap on non-entry routes, the candidate-entry route tolerates a lab, and the
 * tenant cap is configurable. See rate-limit.ts header.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { RateLimitError, config } from "@assessiq/core";
import { rateLimitMiddleware } from "../middleware/rate-limit.js";
import { setRedisForTesting, closeRedis } from "../redis.js";
import type { AuthRequest, AuthReply } from "../middleware/types.js";

let container: StartedTestContainer;

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
  if (container !== undefined) await container.stop();
});

function reply(): AuthReply & { headers: Record<string, string | number> } {
  const headers: Record<string, string | number> = {};
  const r: AuthReply & { headers: Record<string, string | number> } = {
    statusCode: 200,
    headers,
    code(s: number) { r.statusCode = s; return r; },
    header(n: string, v: string | number) { headers[n] = v; return r; },
    send() { return r; },
  };
  return r;
}

function candidateReq(ip: string, userId: string, tenantId: string, routeUrl = "/api/me/attempts/x/answer"): AuthRequest {
  return {
    headers: { "cf-connecting-ip": ip },
    cookies: {},
    routeOptions: { url: routeUrl },
    session: {
      id: `s-${userId}`,
      userId,
      tenantId,
      role: "candidate",
      totpVerified: false,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      lastSeenAt: new Date().toISOString(),
      lastTotpAt: null,
    },
  } as unknown as AuthRequest;
}

function anonReq(ip: string, routeUrl: string): AuthRequest {
  return { headers: { "cf-connecting-ip": ip }, cookies: {}, routeOptions: { url: routeUrl } } as unknown as AuthRequest;
}

const scopeOf = (e: unknown) => (e as { details?: { scope?: string } }).details?.scope;

describe("campus drive rate limits (real Redis)", () => {
  it("(a) 300 candidate sessions x 10 requests from ONE IP -> no 429", async () => {
    const handler = rateLimitMiddleware();
    const ip = "50.0.0.1";
    // 3000 total requests == the candidate-session IP cap exactly (remaining 0, not <0).
    for (let round = 0; round < 10; round++) {
      await Promise.all(
        Array.from({ length: 300 }, (_, i) => handler(candidateReq(ip, `stu-${i}`, "tenant-a"), reply())),
      );
    }
  });

  it("(b) a single candidate over the per-user cap -> 429 scope=user", async () => {
    const handler = rateLimitMiddleware();
    const ip = "50.0.0.2";
    for (let i = 0; i < config.RATE_LIMIT_USER_CANDIDATE; i++) {
      await handler(candidateReq(ip, "stu-solo", "tenant-b"), reply());
    }
    const err = await Promise.resolve(handler(candidateReq(ip, "stu-solo", "tenant-b"), reply())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(scopeOf(err)).toBe("user");
  });

  it("(c) anonymous from one IP is still capped at RATE_LIMIT_IP_ANON on a non-entry route", async () => {
    const handler = rateLimitMiddleware();
    const ip = "50.0.0.3";
    for (let i = 0; i < config.RATE_LIMIT_IP_ANON; i++) {
      await handler(anonReq(ip, "/api/auth/whoami"), reply());
    }
    const err = await Promise.resolve(handler(anonReq(ip, "/api/auth/whoami"), reply())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(scopeOf(err)).toBe("ip");
  });

  it("(d) candidate-entry route allows 300 opens from one IP, and does not burn the anon bucket", async () => {
    const entry = rateLimitMiddleware({ candidateEntry: true });
    const general = rateLimitMiddleware();
    const ip = "50.0.0.4";
    await Promise.all(
      Array.from({ length: 300 }, () => entry(anonReq(ip, "/take/start"), reply())),
    );
    // General anon bucket for the same IP is untouched by the entry burst.
    const r = reply();
    await general(anonReq(ip, "/api/auth/whoami"), r);
    expect(r.headers["X-RateLimit-Remaining"]).toBe(config.RATE_LIMIT_IP_ANON - 1);
    // ...but the entry route is still bounded (DoS / brute-force ceiling).
    for (let i = 300; i < config.RATE_LIMIT_IP_CANDIDATE_ENTRY; i++) {
      await entry(anonReq(ip, "/take/start"), reply());
    }
    const err = await Promise.resolve(entry(anonReq(ip, "/take/start"), reply())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(scopeOf(err)).toBe("ip");
  });

  it("(e) tenant cap is config-driven (RATE_LIMIT_TENANT), scope=tenant when exceeded", async () => {
    const handler = rateLimitMiddleware();
    const tenantMax = config.RATE_LIMIT_TENANT;
    expect(tenantMax).toBe(6000); // default; was hardcoded 600
    // Fill the tenant bucket via many distinct users (each well under per-user cap).
    let sent = 0;
    while (sent < tenantMax) {
      const batch = Math.min(300, tenantMax - sent);
      await Promise.all(
        Array.from({ length: batch }, (_, i) => handler(candidateReq(`60.0.${Math.floor((sent + i) / 200)}.1`, `t-${sent + i}`, "tenant-e"), reply())),
      );
      sent += batch;
    }
    // Distinct IP per 200 users (labs) so the per-IP cap is not what trips.
    const err = await Promise.resolve(handler(candidateReq("50.0.0.6", "t-over", "tenant-e"), reply())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(scopeOf(err)).toBe("tenant");
  }, 60_000);
});
