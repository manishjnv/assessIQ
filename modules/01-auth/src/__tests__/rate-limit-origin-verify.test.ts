/**
 * Redis-free unit coverage for the origin-verify gate added to the rate-limit
 * middleware's local extractRateLimitClientIp().
 *
 * The full rate-limit suite (middleware.test.ts) is Docker/Redis-testcontainer
 * gated and skips locally. This file exercises ONLY extractRateLimitClientIp() — which
 * needs no Redis (the ioredis client is lazy; getRedis() is never called on
 * this path) — so the security-critical "enforce + unverified -> null" line is
 * covered on every local run, not only in CI with Docker.
 *
 * Threat: a direct-to-origin request can spoof cf-connecting-ip. In enforce
 * mode an unverified request must yield null so it flows into the existing
 * production fail-closed throw in rateLimitMiddleware (request rejected) —
 * NOT be bucketed by the attacker-chosen cf-connecting-ip.
 *
 * Config-mock technique mirrors client-ip.test.ts (vi.hoisted + vi.mock).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockConfig } = vi.hoisted(() => {
  return {
    mockConfig: {
      ORIGIN_TRUST_MODE: "off" as "off" | "log" | "enforce",
      ORIGIN_VERIFY_SECRET: undefined as string | undefined,
      NODE_ENV: "production" as string,
      REDIS_URL: "redis://localhost:6379",
    },
  };
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

// Import AFTER vi.mock so the module (and its transitive client-ip.ts) see it.
import { extractRateLimitClientIp } from "../middleware/rate-limit.js";

function req(headers: Record<string, string | string[] | undefined> = {}) {
  // extractRateLimitClientIp only touches req.headers — cast is sufficient for a unit.
  return { headers } as unknown as Parameters<typeof extractRateLimitClientIp>[0];
}

beforeEach(() => {
  mockConfig.ORIGIN_TRUST_MODE = "off";
  mockConfig.ORIGIN_VERIFY_SECRET = undefined;
  mockConfig.NODE_ENV = "production";
});

describe("rate-limit extractRateLimitClientIp — origin-verify gate", () => {
  it("off mode: returns cf-connecting-ip verbatim (zero behaviour change)", () => {
    expect(extractRateLimitClientIp(req({ "cf-connecting-ip": "9.9.9.9" }))).toBe(
      "9.9.9.9",
    );
  });

  it("off mode: cf header absent in prod -> null (legacy fail-closed, unchanged)", () => {
    expect(extractRateLimitClientIp(req({}))).toBeNull();
  });

  it("enforce + UNVERIFIED (no x-origin-verify): null, ignoring the spoofed cf-connecting-ip", () => {
    mockConfig.ORIGIN_TRUST_MODE = "enforce";
    mockConfig.ORIGIN_VERIFY_SECRET = "s3cret";
    expect(
      extractRateLimitClientIp(req({ "cf-connecting-ip": "6.6.6.6" })),
    ).toBeNull();
  });

  it("enforce + UNVERIFIED (wrong secret): null, ignoring the spoofed cf-connecting-ip", () => {
    mockConfig.ORIGIN_TRUST_MODE = "enforce";
    mockConfig.ORIGIN_VERIFY_SECRET = "s3cret";
    expect(
      extractRateLimitClientIp(
        req({ "cf-connecting-ip": "6.6.6.6", "x-origin-verify": "wrong" }),
      ),
    ).toBeNull();
  });

  it("enforce + VERIFIED (correct secret): returns the cf-connecting-ip", () => {
    mockConfig.ORIGIN_TRUST_MODE = "enforce";
    mockConfig.ORIGIN_VERIFY_SECRET = "s3cret";
    expect(
      extractRateLimitClientIp(
        req({ "cf-connecting-ip": "8.8.8.8", "x-origin-verify": "s3cret" }),
      ),
    ).toBe("8.8.8.8");
  });

  it("log mode: bucketing unchanged — spoofed cf still returned (observability only, never rejects)", () => {
    mockConfig.ORIGIN_TRUST_MODE = "log";
    mockConfig.ORIGIN_VERIFY_SECRET = "s3cret";
    expect(extractRateLimitClientIp(req({ "cf-connecting-ip": "7.7.7.7" }))).toBe(
      "7.7.7.7",
    );
  });
});
