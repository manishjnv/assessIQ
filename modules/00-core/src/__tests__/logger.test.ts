import { describe, it, expect } from "vitest";
import { LOG_REDACT_PATHS } from "../log-redact.js";
import {
  logger,
  childLogger,
  createLogger,
  streamLogger,
} from "../logger.js";

describe("LOG_REDACT_PATHS", () => {
  it("includes critical secret paths", () => {
    const required = [
      "password",
      "secret",
      "token",
      "apiKey",
      "totpSecret",
      "recoveryCode",
      "client_secret",
      "refresh_token",
      "id_token",
      "aiq_sess",
      "answer",
      "req.headers.authorization",
      "req.headers.cookie",
    ];
    for (const path of required) {
      expect(LOG_REDACT_PATHS).toContain(path);
    }
  });

  it("includes one-level wildcards for top-level secret fields", () => {
    const wildcards = [
      "*.password",
      "*.secret",
      "*.token",
      "*.totpSecret",
      "*.recoveryCode",
      "*.client_secret",
      "*.refresh_token",
      "*.id_token",
    ];
    for (const path of wildcards) {
      expect(LOG_REDACT_PATHS).toContain(path);
    }
  });
});

describe("streamLogger", () => {
  it("returns the same instance for the same stream name (memoized)", () => {
    expect(streamLogger("auth")).toBe(streamLogger("auth"));
  });

  it("returns distinct instances for different stream names", () => {
    expect(streamLogger("auth")).not.toBe(streamLogger("request"));
  });

  it("attaches the stream name as a binding", () => {
    const l = streamLogger("auth");
    expect(l.bindings()).toMatchObject({ stream: "auth" });
  });

  it("falls through unknown streams to the in-process app logger surface", () => {
    // Unknown names still get a working logger; the file-routing fallback to
    // app.log only matters when LOG_DIR is set (production).
    const l = streamLogger("does-not-exist");
    expect(typeof l.info).toBe("function");
    expect(l.bindings()).toMatchObject({ stream: "does-not-exist" });
  });
});

describe("logger / childLogger / createLogger", () => {
  it("default `logger` is the 'app' stream logger", () => {
    expect(logger).toBe(streamLogger("app"));
  });

  it("childLogger merges bindings without throwing", () => {
    const child = childLogger({ component: "test" });
    expect(child.bindings()).toMatchObject({ component: "test" });
  });

  it("createLogger returns a non-memoized fresh pino", () => {
    const a = createLogger();
    const b = createLogger();
    expect(a).not.toBe(b);
  });

  it("redaction allowlist is wired (does not throw on secret-shaped fields)", () => {
    // We don't assert the censoring output (would require capturing stdout
    // in a worker-safe way); we only assert the call path is healthy.
    expect(() => {
      logger.info(
        {
          password: "should-be-redacted",
          token: "should-be-redacted",
          totpSecret: "should-be-redacted",
          nested: { password: "should-be-redacted" },
        },
        "redaction-smoke",
      );
    }).not.toThrow();
  });
});
