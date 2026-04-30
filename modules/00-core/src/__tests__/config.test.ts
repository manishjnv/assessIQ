import { describe, it, expect } from "vitest";
import { loadConfig } from "../config.js";

/**
 * Minimal valid env — all required keys present, all values legal.
 * Tests build on this base by spreading overrides.
 */
const VALID_BASE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://user:pass@localhost:5432/aiq",
  REDIS_URL: "redis://localhost:6379",
  ASSESSIQ_MASTER_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", // 32 zero-bytes in base64
  SESSION_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

describe("loadConfig", () => {
  it("accepts a valid full environment and returns parsed config", () => {
    const cfg = loadConfig({
      ...VALID_BASE_ENV,
      LOG_LEVEL: "debug",
      SESSION_COOKIE_NAME: "my_sess",
    });
    expect(cfg.NODE_ENV).toBe("test");
    expect(cfg.LOG_LEVEL).toBe("debug");
    expect(cfg.SESSION_COOKIE_NAME).toBe("my_sess");
    expect(cfg.DATABASE_URL).toBe("postgres://user:pass@localhost:5432/aiq");
  });

  it("throws when DATABASE_URL is missing", () => {
    const env = { ...VALID_BASE_ENV };
    delete env.DATABASE_URL;
    expect(() => loadConfig(env)).toThrow("Configuration validation failed");
  });

  it("throws when DATABASE_URL has an unsupported scheme (mysql://)", () => {
    expect(() =>
      loadConfig({ ...VALID_BASE_ENV, DATABASE_URL: "mysql://localhost/aiq" })
    ).toThrow("DATABASE_URL must start with postgres://");
  });

  it("throws when REDIS_URL has an unsupported scheme", () => {
    expect(() =>
      loadConfig({ ...VALID_BASE_ENV, REDIS_URL: "memcached://localhost" })
    ).toThrow("REDIS_URL must start with redis://");
  });

  it("throws when ASSESSIQ_MASTER_KEY does not decode to 32 bytes", () => {
    // "aGVsbG8=" decodes to "hello" (5 bytes)
    expect(() =>
      loadConfig({ ...VALID_BASE_ENV, ASSESSIQ_MASTER_KEY: "aGVsbG8=" })
    ).toThrow("ASSESSIQ_MASTER_KEY must be a base64 string");
  });

  it("throws when SESSION_SECRET does not decode to 32 bytes", () => {
    expect(() =>
      loadConfig({ ...VALID_BASE_ENV, SESSION_SECRET: "dG9vc2hvcnQ=" })
    ).toThrow("SESSION_SECRET must be a base64 string");
  });

  it("throws when AI_PIPELINE_MODE=claude-code-vps AND ANTHROPIC_API_KEY is set", () => {
    expect(() =>
      loadConfig({
        ...VALID_BASE_ENV,
        AI_PIPELINE_MODE: "claude-code-vps",
        ANTHROPIC_API_KEY: "sk-ant-fake-key",
      })
    ).toThrow("ANTHROPIC_API_KEY must NOT be set when AI_PIPELINE_MODE=claude-code-vps");
  });

  it("throws when AI_PIPELINE_MODE=anthropic-api but ANTHROPIC_API_KEY is absent", () => {
    expect(() =>
      loadConfig({ ...VALID_BASE_ENV, AI_PIPELINE_MODE: "anthropic-api" })
    ).toThrow("ANTHROPIC_API_KEY is required when AI_PIPELINE_MODE=anthropic-api");
  });

  it("accepts AI_PIPELINE_MODE=anthropic-api when ANTHROPIC_API_KEY is present", () => {
    const cfg = loadConfig({
      ...VALID_BASE_ENV,
      AI_PIPELINE_MODE: "anthropic-api",
      ANTHROPIC_API_KEY: "sk-ant-fake-key",
    });
    expect(cfg.AI_PIPELINE_MODE).toBe("anthropic-api");
  });

  it("defaults NODE_ENV to development when not provided", () => {
    const env = { ...VALID_BASE_ENV };
    delete env.NODE_ENV;
    const cfg = loadConfig(env);
    expect(cfg.NODE_ENV).toBe("development");
  });

  it("defaults LOG_LEVEL to info when not provided", () => {
    const cfg = loadConfig({ ...VALID_BASE_ENV });
    expect(cfg.LOG_LEVEL).toBe("info");
  });

  it("defaults SESSION_COOKIE_NAME to aiq_sess when not provided", () => {
    const cfg = loadConfig({ ...VALID_BASE_ENV });
    expect(cfg.SESSION_COOKIE_NAME).toBe("aiq_sess");
  });

  it("defaults ASSESSIQ_BASE_URL to the production URL when not provided", () => {
    const cfg = loadConfig({ ...VALID_BASE_ENV });
    expect(cfg.ASSESSIQ_BASE_URL).toBe("https://assessiq.automateedge.cloud");
  });

  it("defaults AI_PIPELINE_MODE to claude-code-vps when not provided", () => {
    const cfg = loadConfig({ ...VALID_BASE_ENV });
    expect(cfg.AI_PIPELINE_MODE).toBe("claude-code-vps");
  });

  it("accepts optional GOOGLE_CLIENT_ID without requiring it", () => {
    const cfg = loadConfig({
      ...VALID_BASE_ENV,
      GOOGLE_CLIENT_ID: "123.apps.googleusercontent.com",
    });
    expect(cfg.GOOGLE_CLIENT_ID).toBe("123.apps.googleusercontent.com");
  });

  it("accepts rediss:// scheme for REDIS_URL", () => {
    const cfg = loadConfig({ ...VALID_BASE_ENV, REDIS_URL: "rediss://localhost:6380" });
    expect(cfg.REDIS_URL).toBe("rediss://localhost:6380");
  });

  it("accepts postgresql:// scheme for DATABASE_URL", () => {
    const cfg = loadConfig({
      ...VALID_BASE_ENV,
      DATABASE_URL: "postgresql://user:pass@localhost:5432/aiq",
    });
    expect(cfg.DATABASE_URL).toBe("postgresql://user:pass@localhost:5432/aiq");
  });
});
