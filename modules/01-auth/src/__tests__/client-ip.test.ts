/**
 * Unit tests for modules/01-auth/src/client-ip.ts — extractClientIp()
 *
 * Pure unit tests: no Docker, no Redis, no Postgres.
 * Runs in plain vitest with vi.mock() to inject config values.
 *
 * Coverage:
 *   - off mode: returns cf header / req.ip / array-valued header
 *   - log mode: returns cf ?? req.ip regardless of secret validity; does not throw
 *   - enforce mode: valid secret → cf; bad/absent secret → socket IP, ignores cf
 *   - never-throws: a req object that throws on property access still yields a string
 *   - constant-time: wrong-length and right-length-wrong-value secrets both → unverified
 *
 * Config mock technique: vi.mock('@assessiq/core') with a factory that exposes a
 * mutable `mockConfig` reference. Individual tests mutate the fields they need
 * (ORIGIN_TRUST_MODE / ORIGIN_VERIFY_SECRET). This matches the pattern used in
 * other 01-auth tests that need to observe different config states without
 * restarting the module (config is a singleton captured at import time).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock @assessiq/core so tests can inject any ORIGIN_TRUST_MODE value.
//
// vi.mock() is hoisted by vitest to the TOP of the compiled output — before
// any variable declarations — so top-level `const mockConfig = ...` would be
// in the temporal dead zone when the factory runs.
//
// vi.hoisted() is the correct fix: it runs its callback inside the same hoisted
// zone as vi.mock(), so the returned object is initialized before the factory
// references it.
// ---------------------------------------------------------------------------

const { mockConfig } = vi.hoisted(() => {
  return {
    mockConfig: {
      ORIGIN_TRUST_MODE: "off" as "off" | "log" | "enforce",
      ORIGIN_VERIFY_SECRET: undefined as string | undefined,
    },
  };
});

vi.mock("@assessiq/core", () => {
  // Minimal stub — only the fields client-ip.ts touches.
  const warnFn = vi.fn();
  const streamLoggerStub = (_name: string) => ({
    warn: warnFn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  });
  return {
    config: mockConfig,
    streamLogger: streamLoggerStub,
  };
});

// Import AFTER vi.mock so the module sees the mock.
import { extractClientIp } from "../client-ip.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeReq {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
}

function req(overrides: Partial<FakeReq> = {}): FakeReq {
  return { headers: {}, ip: "1.2.3.4", ...overrides };
}

// ---------------------------------------------------------------------------
// Reset mutable config before each test so tests are independent.
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockConfig.ORIGIN_TRUST_MODE = "off";
  mockConfig.ORIGIN_VERIFY_SECRET = undefined;
});

// ---------------------------------------------------------------------------
// § off mode
// ---------------------------------------------------------------------------

describe("off mode", () => {
  it("returns cf-connecting-ip when present", () => {
    const r = req({ headers: { "cf-connecting-ip": "5.5.5.5" }, ip: "127.0.0.1" });
    expect(extractClientIp(r)).toBe("5.5.5.5");
  });

  it("returns req.ip when cf-connecting-ip is absent", () => {
    const r = req({ headers: {}, ip: "9.9.9.9" });
    expect(extractClientIp(r)).toBe("9.9.9.9");
  });

  it("uses first element when cf header is array-valued", () => {
    const r = req({ headers: { "cf-connecting-ip": ["3.3.3.3", "4.4.4.4"] }, ip: "0.0.0.0" });
    expect(extractClientIp(r)).toBe("3.3.3.3");
  });

  it("falls back to 0.0.0.0 when both cf and req.ip are absent", () => {
    const r: FakeReq = { headers: {} }; // ip intentionally absent
    expect(extractClientIp(r)).toBe("0.0.0.0");
  });
});

// ---------------------------------------------------------------------------
// § log mode
// ---------------------------------------------------------------------------

describe("log mode", () => {
  beforeEach(() => {
    mockConfig.ORIGIN_TRUST_MODE = "log";
    mockConfig.ORIGIN_VERIFY_SECRET = "supersecret";
  });

  it("returns cf ?? req.ip when secret is correct (verified path)", () => {
    const r = req({
      headers: {
        "cf-connecting-ip": "8.8.8.8",
        "x-origin-verify": "supersecret",
      },
      ip: "127.0.0.1",
    });
    expect(extractClientIp(r)).toBe("8.8.8.8");
  });

  it("returns cf ?? req.ip even when secret header is missing (unverified path — behavior unchanged)", () => {
    const r = req({
      headers: { "cf-connecting-ip": "8.8.8.8" },
      ip: "127.0.0.1",
    });
    // log mode never changes the returned IP
    expect(extractClientIp(r)).toBe("8.8.8.8");
  });

  it("returns req.ip when cf absent and secret wrong (unverified path — behavior unchanged)", () => {
    const r = req({
      headers: { "x-origin-verify": "wrongsecret" },
      ip: "10.0.0.1",
    });
    expect(extractClientIp(r)).toBe("10.0.0.1");
  });

  it("does not throw when logger is called (unverified path emits warn)", () => {
    const r = req({ headers: {}, ip: "1.1.1.1" });
    expect(() => extractClientIp(r)).not.toThrow();
  });

  it("returns cf ?? req.ip regardless of secret validity — behavior is never changed in log mode", () => {
    // No secret configured at all
    mockConfig.ORIGIN_VERIFY_SECRET = undefined;
    const r = req({
      headers: { "cf-connecting-ip": "7.7.7.7", "x-origin-verify": "anything" },
      ip: "2.2.2.2",
    });
    expect(extractClientIp(r)).toBe("7.7.7.7");
  });
});

// ---------------------------------------------------------------------------
// § enforce mode
// ---------------------------------------------------------------------------

describe("enforce mode", () => {
  beforeEach(() => {
    mockConfig.ORIGIN_TRUST_MODE = "enforce";
    mockConfig.ORIGIN_VERIFY_SECRET = "correct-secret";
  });

  it("returns cf header when secret matches (verified)", () => {
    const r = req({
      headers: {
        "cf-connecting-ip": "11.22.33.44",
        "x-origin-verify": "correct-secret",
      },
      ip: "127.0.0.1",
      socket: { remoteAddress: "192.168.1.1" },
    });
    expect(extractClientIp(r)).toBe("11.22.33.44");
  });

  it("returns socket.remoteAddress (not cf) when secret header is missing", () => {
    const r = req({
      headers: { "cf-connecting-ip": "11.22.33.44" },
      ip: "127.0.0.1",
      socket: { remoteAddress: "192.168.1.1" },
    });
    // unverified → socket IP, cf is IGNORED
    expect(extractClientIp(r)).toBe("192.168.1.1");
  });

  it("returns socket.remoteAddress (not cf) when secret header is wrong", () => {
    const r = req({
      headers: {
        "cf-connecting-ip": "11.22.33.44",
        "x-origin-verify": "wrong-secret",
      },
      ip: "127.0.0.1",
      socket: { remoteAddress: "192.168.1.1" },
    });
    expect(extractClientIp(r)).toBe("192.168.1.1");
  });

  it("falls back to req.ip when socket is absent and secret is wrong", () => {
    const r = req({
      headers: {
        "cf-connecting-ip": "11.22.33.44",
        "x-origin-verify": "wrong-secret",
      },
      ip: "127.0.0.1",
      // no socket
    });
    expect(extractClientIp(r)).toBe("127.0.0.1");
  });

  it("unverified when ORIGIN_VERIFY_SECRET is set but x-origin-verify header absent", () => {
    const r = req({
      headers: { "cf-connecting-ip": "11.22.33.44" },
      ip: "127.0.0.1",
      socket: { remoteAddress: "10.10.10.10" },
    });
    expect(extractClientIp(r)).toBe("10.10.10.10");
  });

  it("ignores cf-connecting-ip entirely on unverified path", () => {
    // The returned IP must NOT be the cf header value
    const cfIp = "1.2.3.4";
    const socketIp = "10.0.0.99";
    const r = req({
      headers: {
        "cf-connecting-ip": cfIp,
        "x-origin-verify": "bad",
      },
      ip: "127.0.0.1",
      socket: { remoteAddress: socketIp },
    });
    const result = extractClientIp(r);
    expect(result).not.toBe(cfIp);
    expect(result).toBe(socketIp);
  });
});

// ---------------------------------------------------------------------------
// § never-throws
// ---------------------------------------------------------------------------

describe("never-throws", () => {
  it("returns a string even when req.headers property access throws", () => {
    mockConfig.ORIGIN_TRUST_MODE = "enforce";
    mockConfig.ORIGIN_VERIFY_SECRET = "s";

    // A proxy that throws on any property access to headers
    const badReq = {
      get headers(): Record<string, string | undefined> {
        throw new Error("unexpected headers access");
      },
      ip: "5.5.5.5",
    };

    let result: string | undefined;
    expect(() => {
      result = extractClientIp(badReq as unknown as FakeReq);
    }).not.toThrow();

    expect(typeof result).toBe("string");
  });

  it("returns 0.0.0.0 when both req.headers and req.ip are unavailable", () => {
    // Completely bare object — no ip, no socket
    const bareReq: FakeReq = { headers: {} };
    expect(extractClientIp(bareReq)).toBe("0.0.0.0");
  });
});

// ---------------------------------------------------------------------------
// § constant-time comparison
// ---------------------------------------------------------------------------

describe("constant-time comparison (no exception, correct verdict)", () => {
  beforeEach(() => {
    mockConfig.ORIGIN_TRUST_MODE = "enforce";
    mockConfig.ORIGIN_VERIFY_SECRET = "correct-secret";
  });

  it("wrong-length secret → unverified (no exception)", () => {
    // "short" is different length from "correct-secret"
    const r = req({
      headers: {
        "cf-connecting-ip": "9.9.9.9",
        "x-origin-verify": "short",
      },
      ip: "127.0.0.1",
      socket: { remoteAddress: "192.168.0.1" },
    });
    expect(() => extractClientIp(r)).not.toThrow();
    expect(extractClientIp(r)).toBe("192.168.0.1"); // unverified → socket
  });

  it("right-length wrong-value secret → unverified (no exception)", () => {
    // "correct-secret" is 14 chars; craft a same-length wrong value
    const sameLen = "correct-XXXXXX"; // 14 chars
    expect(sameLen.length).toBe("correct-secret".length);
    const r = req({
      headers: {
        "cf-connecting-ip": "9.9.9.9",
        "x-origin-verify": sameLen,
      },
      ip: "127.0.0.1",
      socket: { remoteAddress: "192.168.0.2" },
    });
    expect(() => extractClientIp(r)).not.toThrow();
    expect(extractClientIp(r)).toBe("192.168.0.2"); // unverified → socket
  });

  it("exact correct secret → verified (no exception)", () => {
    const r = req({
      headers: {
        "cf-connecting-ip": "9.9.9.9",
        "x-origin-verify": "correct-secret",
      },
      ip: "127.0.0.1",
      socket: { remoteAddress: "192.168.0.3" },
    });
    expect(() => extractClientIp(r)).not.toThrow();
    expect(extractClientIp(r)).toBe("9.9.9.9"); // verified → cf
  });
});
