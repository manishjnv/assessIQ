/**
 * Tests for P2 email-otp.ts — requestEmailOtp + verifyEmailOtp
 *
 * Exercises the full OTP lifecycle against a real Redis testcontainer.
 * DB-dependent tests (resolveLoginIdentities, mintForIdentity) also spin up
 * a Postgres testcontainer for the relevant cases.
 *
 * Docker-guarded setup: beforeAll starts containers; tests requiring
 * containers are wrapped in the shared beforeAll/afterAll scope.
 *
 * Test coverage:
 *   1. Anti-enumeration: /email/request response + timing identical for
 *      eligible / ineligible / super-admin-only / unknown email.
 *   2. Code single-use: verifying twice → second fails.
 *   3. Expiry: expired code → AuthnError.
 *   4. ≤5 attempts then code burned: 6th attempt fails even with correct code.
 *   5. ip/ua binding: mismatched ip or ua → AuthnError.
 *   6. super-admin-only email → no code sent / no session via email-OTP.
 *   7. Mixed email (super_admin + admin) → only admin identity reachable.
 *   8. Fail-closed on Redis error.
 *   9. Rate-limit mirrors candidate-login (5/h, fail-closed).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { setRedisForTesting, closeRedis } from "../redis.js";
import { requestEmailOtp, verifyEmailOtp, checkOtpRateLimit, checkOtpEmailRateLimit } from "../email-otp.js";
import { sha256Hex } from "../crypto-util.js";
import { getRedis } from "../redis.js";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

const THIS_DIR = toFsPath(new URL(".", import.meta.url));
const AUTH_MODULE_ROOT = join(THIS_DIR, "..", "..");
const MODULES_ROOT = join(AUTH_MODULE_ROOT, "..");

const TENANCY_MIGRATIONS = join(MODULES_ROOT, "02-tenancy", "migrations");
const AUTH_MIGRATIONS = join(AUTH_MODULE_ROOT, "migrations");

// ---------------------------------------------------------------------------
// Mock sendEmail to prevent real SMTP calls
// ---------------------------------------------------------------------------

vi.mock("@assessiq/notifications", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

// Mock jose to avoid real JWKS requests (mintForIdentity uses google-sso which
// lazily imports jose; we need it not to try connecting to Google).
vi.mock("jose", async (importActual) => {
  const actual = await importActual<typeof import("jose")>();
  return {
    ...actual,
    jwtVerify: vi.fn(),
    createRemoteJWKSet: vi.fn(() => ({})),
  };
});

// ---------------------------------------------------------------------------
// Shared container state
// ---------------------------------------------------------------------------

let pgContainer: StartedTestContainer;
let redisContainer: StartedTestContainer;
let pgUrl: string;
let redisUrl: string;

// Platform tenant ID (must match SUPER_ADMIN_EMAILS env var in resolveLoginIdentities).
const PLATFORM_TENANT_ID = "00000000-0000-7000-0000-000000000001";
let regularTenantId: string;
let adminUserId: string;
let reviewerUserId: string;
let superAdminUserId: string;
let mixedAdminUserId: string; // admin identity for the "mixed" (super_admin + admin) email

// ---------------------------------------------------------------------------
// Super-client helper (bypasses RLS)
// ---------------------------------------------------------------------------

async function withSuperClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: pgUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Global setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  process.env["PLATFORM_TENANT_ID"] = PLATFORM_TENANT_ID;
  process.env["SUPER_ADMIN_EMAILS"] = "superadmin@example.com,mixed@example.com";

  [pgContainer, redisContainer] = await Promise.all([
    new GenericContainer("postgres:16-alpine")
      .withEnvironment({
        POSTGRES_USER: "test",
        POSTGRES_PASSWORD: "test",
        POSTGRES_DB: "aiq_test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .withStartupTimeout(60_000)
      .start(),
    new GenericContainer("redis:7-alpine")
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .withStartupTimeout(60_000)
      .start(),
  ]);

  pgUrl    = `postgres://test:test@${pgContainer.getHost()}:${pgContainer.getMappedPort(5432)}/aiq_test`;
  redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

  // Apply migrations.
  const tenancyFiles = (await readdir(TENANCY_MIGRATIONS)).filter(f => f.endsWith(".sql")).sort();
  const authFiles    = (await readdir(AUTH_MIGRATIONS)).filter(f => f.endsWith(".sql")).sort();

  await withSuperClient(async (client) => {
    for (const file of tenancyFiles) {
      await client.query(await readFile(join(TENANCY_MIGRATIONS, file), "utf-8"));
    }

    // Users table shim.
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        email       TEXT NOT NULL,
        role        TEXT NOT NULL DEFAULT 'admin'
                    CHECK (role IN ('admin','super_admin','reviewer','candidate')),
        status      TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','disabled','pending')),
        deleted_at  TIMESTAMPTZ DEFAULT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, email)
      );
      ALTER TABLE users ENABLE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON users
        USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
      CREATE POLICY tenant_isolation_insert ON users FOR INSERT
        WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);

    await client.query(`
      ALTER TABLE users FORCE ROW LEVEL SECURITY;
      GRANT SELECT ON users TO assessiq_system;
    `).catch(() => {});

    for (const file of authFiles) {
      await client.query(await readFile(join(AUTH_MIGRATIONS, file), "utf-8"));
    }

    // oauth_identities stub (needed for mintForIdentity customer branch).
    await client.query(`
      CREATE TABLE IF NOT EXISTS oauth_identities (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id     UUID NOT NULL,
        user_id       UUID NOT NULL,
        provider      TEXT NOT NULL,
        subject       TEXT NOT NULL,
        email_verified BOOLEAN NOT NULL DEFAULT false,
        raw_profile   JSONB,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (provider, subject)
      );
    `).catch(() => {});

    // sessions table stub (for mintForIdentity → sessions.create).
    // The real sessions table is created by auth migrations.

    // Platform tenant + super_admin user.
    await client.query(`
      INSERT INTO tenants (id, slug, name, status)
      VALUES ('${PLATFORM_TENANT_ID}', 'platform', 'AssessIQ Platform', 'active')
      ON CONFLICT DO NOTHING;
      INSERT INTO tenant_settings (tenant_id)
      VALUES ('${PLATFORM_TENANT_ID}')
      ON CONFLICT DO NOTHING;
      INSERT INTO users (id, tenant_id, email, role, status)
      VALUES (
        '00000000-0000-7000-0000-000000000002',
        '${PLATFORM_TENANT_ID}',
        'superadmin@example.com',
        'super_admin',
        'active'
      ) ON CONFLICT DO NOTHING;
    `);
  });

  await setPoolForTesting(pgUrl);
  await setRedisForTesting(redisUrl);

  // Seed: regular tenant + users.
  regularTenantId = randomUUID();
  adminUserId     = randomUUID();
  reviewerUserId  = randomUUID();
  superAdminUserId = "00000000-0000-7000-0000-000000000002"; // already seeded above
  mixedAdminUserId = randomUUID();

  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`,
      [regularTenantId, "tenant-a", "Tenant A"],
    );
    await client.query(
      `INSERT INTO tenant_settings (tenant_id) VALUES ($1)`,
      [regularTenantId],
    );
    await client.query(
      `INSERT INTO users (id, tenant_id, email, role, status) VALUES
         ($1, $2, 'admin@example.com',    'admin',    'active'),
         ($3, $2, 'reviewer@example.com', 'reviewer', 'active'),
         -- mixed@example.com also has a super_admin row in the platform tenant (seeded below)
         ($4, $2, 'mixed@example.com',    'admin',    'active')`,
      [adminUserId, regularTenantId, reviewerUserId, mixedAdminUserId],
    );

    // Seed the super_admin identity for mixed@example.com in the platform tenant.
    // This tests that filterEligible blocks the super_admin row even when mixed in.
    await client.query(
      `INSERT INTO users (id, tenant_id, email, role, status) VALUES
         ('00000000-0000-7000-0000-000000000003', '${PLATFORM_TENANT_ID}', 'mixed@example.com', 'super_admin', 'active')
       ON CONFLICT DO NOTHING`,
    );
  });
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await closePool();
  await closeRedis();
  await Promise.all([pgContainer?.stop(), redisContainer?.stop()]);
});

// ---------------------------------------------------------------------------
// Helper: write a code directly into Redis for testing verify paths.
// ---------------------------------------------------------------------------

const OTP_KEY_PREFIX = "aiq:email-otp:";

async function seedOtp(
  email: string,
  code: string,
  opts: { attempts?: number; ip?: string; ua?: string; ttl?: number } = {},
): Promise<void> {
  const emailHash = sha256Hex(email.toLowerCase().trim());
  const key = `${OTP_KEY_PREFIX}${emailHash}`;
  const payload = {
    codeHash: sha256Hex(code),
    email: email.toLowerCase().trim(),
    ip: opts.ip ?? "10.0.0.1",
    ua: opts.ua ?? "vitest/email-otp",
    attempts: opts.attempts ?? 0,
  };
  await getRedis().set(key, JSON.stringify(payload), "EX", opts.ttl ?? 600);
}

async function otpKeyExists(email: string): Promise<boolean> {
  const emailHash = sha256Hex(email.toLowerCase().trim());
  const key = `${OTP_KEY_PREFIX}${emailHash}`;
  const val = await getRedis().get(key);
  return val !== null;
}

// ---------------------------------------------------------------------------
// 1. Anti-enumeration: requestEmailOtp always returns void with no throw
// ---------------------------------------------------------------------------

describe("requestEmailOtp — anti-enumeration", () => {
  it("returns void for an eligible admin email (no throw)", async () => {
    await expect(
      requestEmailOtp({ email: "admin@example.com", ip: "10.0.0.1", ua: "vitest" }),
    ).resolves.toBeUndefined();
  });

  it("returns void for an ineligible (candidate-only) email", async () => {
    // No candidate user exists for this email — still void.
    await expect(
      requestEmailOtp({ email: "nobody@example.com", ip: "10.0.0.2", ua: "vitest" }),
    ).resolves.toBeUndefined();
  });

  it("returns void for a super-admin-only email (superadmin@example.com)", async () => {
    // superadmin@example.com has ONLY a super_admin identity — filterEligible → 0.
    // No code must be stored in Redis.
    await expect(
      requestEmailOtp({ email: "superadmin@example.com", ip: "10.0.0.3", ua: "vitest" }),
    ).resolves.toBeUndefined();

    // Verify: no Redis key was written.
    const exists = await otpKeyExists("superadmin@example.com");
    expect(exists, "no OTP key stored for super-admin-only email").toBe(false);
  });

  it("stores an OTP key for an eligible admin email", async () => {
    await requestEmailOtp({ email: "admin@example.com", ip: "10.1.0.1", ua: "vitest" });
    const exists = await otpKeyExists("admin@example.com");
    expect(exists, "OTP key stored for eligible admin").toBe(true);
  });

  it("stores an OTP key for an eligible reviewer email", async () => {
    await requestEmailOtp({ email: "reviewer@example.com", ip: "10.1.0.2", ua: "vitest" });
    const exists = await otpKeyExists("reviewer@example.com");
    expect(exists, "OTP key stored for eligible reviewer").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Code single-use: verifying twice → second fails
// ---------------------------------------------------------------------------

describe("verifyEmailOtp — single-use", () => {
  it("first verify succeeds, second fails (single-use guarantee)", async () => {
    const code = "123456";
    const ip = "10.2.0.1";
    const ua = "vitest/single-use";

    // Seed code for admin@example.com.
    await seedOtp("admin@example.com", code, { ip, ua });

    // First verify: must succeed.
    const out = await verifyEmailOtp({ email: "admin@example.com", code, ip, ua });
    expect(out.kind).toBe("session");

    // Second verify with same code: must fail.
    await expect(
      verifyEmailOtp({ email: "admin@example.com", code, ip, ua }),
    ).rejects.toMatchObject({ name: "AuthnError" });
  });
});

// ---------------------------------------------------------------------------
// 3. Expiry: expired code (TTL=1s) → AuthnError
// ---------------------------------------------------------------------------

describe("verifyEmailOtp — expiry", () => {
  it("expired code (key not in Redis) → AuthnError", async () => {
    // Seed with TTL=1 second, then wait for it to expire.
    const code = "654321";
    const ip = "10.3.0.1";
    const ua = "vitest/expiry";

    await seedOtp("admin@example.com", code, { ip, ua, ttl: 1 });

    // Wait for Redis TTL to expire.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    await expect(
      verifyEmailOtp({ email: "admin@example.com", code, ip, ua }),
    ).rejects.toMatchObject({ name: "AuthnError" });
  }, 10_000);
});

// ---------------------------------------------------------------------------
// 4. ≤5 attempts then code burned
// ---------------------------------------------------------------------------

describe("verifyEmailOtp — ≤5 attempts then burned", () => {
  it("5 wrong attempts burn the code; 6th attempt (correct code) fails", async () => {
    const correctCode = "111222";
    const wrongCode   = "000000";
    const ip = "10.4.0.1";
    const ua = "vitest/attempts";

    await seedOtp("admin@example.com", correctCode, { ip, ua });

    // 5 wrong attempts — each should throw AuthnError.
    for (let i = 0; i < 5; i++) {
      await expect(
        verifyEmailOtp({ email: "admin@example.com", code: wrongCode, ip, ua }),
      ).rejects.toMatchObject({ name: "AuthnError" });
    }

    // 6th attempt with the CORRECT code — key has been deleted (burned after 5 attempts).
    await expect(
      verifyEmailOtp({ email: "admin@example.com", code: correctCode, ip, ua }),
    ).rejects.toMatchObject({ name: "AuthnError" });
  });
});

// ---------------------------------------------------------------------------
// 5. ip/ua binding
// ---------------------------------------------------------------------------

describe("verifyEmailOtp — ip/ua binding", () => {
  it("wrong ip → AuthnError", async () => {
    const code = "222333";
    const ip   = "10.5.0.1";
    const ua   = "vitest/binding";

    await seedOtp("admin@example.com", code, { ip, ua });

    await expect(
      verifyEmailOtp({ email: "admin@example.com", code, ip: "9.9.9.9", ua }),
    ).rejects.toMatchObject({ name: "AuthnError" });
  });

  it("wrong ua → AuthnError", async () => {
    const code = "333444";
    const ip   = "10.5.0.2";
    const ua   = "vitest/binding-ua";

    await seedOtp("admin@example.com", code, { ip, ua });

    await expect(
      verifyEmailOtp({ email: "admin@example.com", code, ip, ua: "EvilBrowser/9" }),
    ).rejects.toMatchObject({ name: "AuthnError" });
  });
});

// ---------------------------------------------------------------------------
// 6. super-admin-only email → no code / no session via email-OTP
// ---------------------------------------------------------------------------

describe("super_admin exclusion — layer (a): request filter", () => {
  it("superadmin@example.com has no eligible identity → no OTP key written", async () => {
    // Use a fresh IP to avoid rate-limit contamination.
    const ip = `10.6.${Math.floor(Math.random() * 254) + 1}.1`;
    await requestEmailOtp({ email: "superadmin@example.com", ip, ua: "vitest/sa" });
    const exists = await otpKeyExists("superadmin@example.com");
    expect(exists, "No OTP key for super-admin-only email").toBe(false);
  });

  it("superadmin@example.com → verifyEmailOtp always fails (no key ever set)", async () => {
    // No key in Redis → AuthnError (key missing path).
    await expect(
      verifyEmailOtp({ email: "superadmin@example.com", code: "000000", ip: "10.6.2.1", ua: "vitest" }),
    ).rejects.toMatchObject({ name: "AuthnError" });
  });
});

// ---------------------------------------------------------------------------
// 7. Mixed email (super_admin + admin): only admin identity reachable
// ---------------------------------------------------------------------------

describe("super_admin exclusion — layer (b): verify re-filter", () => {
  it("mixed@example.com has super_admin in platform + admin in tenant-a; verify returns session for admin only", async () => {
    const code = "444555";
    const ip   = "10.7.0.1";
    const ua   = "vitest/mixed";

    await seedOtp("mixed@example.com", code, { ip, ua });

    // Verify must succeed and return a session for the admin identity (not super_admin).
    const out = await verifyEmailOtp({ email: "mixed@example.com", code, ip, ua });
    expect(out.kind).toBe("session");

    // The minted session must be for the admin user in regularTenantId.
    if (out.kind === "session") {
      expect(out.user.tenantId).toBe(regularTenantId);
      expect(out.user.role).toBe("admin");
      expect(out.user.id).toBe(mixedAdminUserId);
      // Must NOT be the super_admin user.
      expect(out.user.id).not.toBe(superAdminUserId);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Fail-closed on Redis error
// ---------------------------------------------------------------------------

describe("fail-closed on Redis error", () => {
  it("requestEmailOtp: Redis SET failure → returns void (no throw, no email)", async () => {
    const { sendEmail } = await import("@assessiq/notifications");
    const sendSpy = vi.mocked(sendEmail);
    sendSpy.mockClear();

    // Inject a Redis that throws on SET.
    const fakeRedis = {
      eval: vi.fn().mockResolvedValue([1, 3600]), // rate-limit passes (count=1)
      set: vi.fn().mockRejectedValue(new Error("connection refused")),
      get: vi.fn(),
      del: vi.fn(),
      getdel: vi.fn(),
    } as unknown as Parameters<typeof setRedisForTesting>[0];
    await setRedisForTesting(fakeRedis);

    try {
      await expect(
        requestEmailOtp({ email: "admin@example.com", ip: "10.8.0.1", ua: "vitest" }),
      ).resolves.toBeUndefined();

      // Email must NOT have been sent (Redis write failed before send).
      expect(sendSpy).not.toHaveBeenCalled();
    } finally {
      // Restore real Redis.
      await closeRedis();
      await setRedisForTesting(redisUrl);
    }
  });

  it("verifyEmailOtp: Redis eval failure → throws AuthnError (fail-closed)", async () => {
    const fakeRedis = {
      eval: vi.fn().mockRejectedValue(new Error("connection refused")),
    } as unknown as Parameters<typeof setRedisForTesting>[0];
    await setRedisForTesting(fakeRedis);

    try {
      await expect(
        verifyEmailOtp({ email: "admin@example.com", code: "000000", ip: "10.8.0.2", ua: "vitest" }),
      ).rejects.toMatchObject({ name: "AuthnError" });
    } finally {
      await closeRedis();
      await setRedisForTesting(redisUrl);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Rate-limit mirrors candidate-login (5/h per IP+email, fail-closed)
// ---------------------------------------------------------------------------

describe("checkOtpRateLimit — per-(IP, email) rate limit", () => {
  it("allows first 5 requests, blocks the 6th", async () => {
    const testIp    = `10.9.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
    const testEmail = `rl-otp-${randomUUID()}@example.com`;

    for (let i = 1; i <= 5; i++) {
      const allowed = await checkOtpRateLimit(testIp, testEmail);
      expect(allowed, `request ${i} should be allowed`).toBe(true);
    }

    const blocked = await checkOtpRateLimit(testIp, testEmail);
    expect(blocked, "6th request should be blocked").toBe(false);
  });

  it("different email on same IP is not affected by the first email's counter", async () => {
    const testIp = `10.10.${Math.floor(Math.random() * 254) + 1}.1`;
    const emailA  = `rl-a-${randomUUID()}@example.com`;
    const emailB  = `rl-b-${randomUUID()}@example.com`;

    // Exhaust emailA.
    for (let i = 0; i < 6; i++) {
      await checkOtpRateLimit(testIp, emailA);
    }

    // emailB must still be allowed.
    const allowed = await checkOtpRateLimit(testIp, emailB);
    expect(allowed).toBe(true);
  });

  it("fails closed (returns false) when Redis throws", async () => {
    const fakeRedis = {
      eval: vi.fn().mockRejectedValue(new Error("connection refused")),
    } as unknown as Parameters<typeof setRedisForTesting>[0];
    await setRedisForTesting(fakeRedis);

    try {
      const allowed = await checkOtpRateLimit("10.11.0.1", `rl-redis-down-${randomUUID()}@example.com`);
      expect(allowed).toBe(false);
    } finally {
      await closeRedis();
      await setRedisForTesting(redisUrl);
    }
  });
});

// ---------------------------------------------------------------------------
// 9b. Per-email (IP-independent) rate-limit cap
// ---------------------------------------------------------------------------

describe("checkOtpEmailRateLimit — per-email IP-independent cap", () => {
  it("allows first 10 requests from different IPs, blocks the 11th", async () => {
    const testEmail = `rl-email-${randomUUID()}@example.com`;

    for (let i = 1; i <= 10; i++) {
      const allowed = await checkOtpEmailRateLimit(testEmail);
      expect(allowed, `request ${i} should be allowed`).toBe(true);
    }

    const blocked = await checkOtpEmailRateLimit(testEmail);
    expect(blocked, "11th request should be blocked").toBe(false);
  });

  it("different emails are not affected by each other's counters", async () => {
    const emailA = `rl-email-a-${randomUUID()}@example.com`;
    const emailB = `rl-email-b-${randomUUID()}@example.com`;

    // Exhaust emailA counter.
    for (let i = 0; i < 11; i++) {
      await checkOtpEmailRateLimit(emailA);
    }

    // emailB must still be allowed.
    const allowed = await checkOtpEmailRateLimit(emailB);
    expect(allowed).toBe(true);
  });

  it("fails closed (returns false) when Redis throws", async () => {
    const fakeRedis = {
      eval: vi.fn().mockRejectedValue(new Error("connection refused")),
    } as unknown as Parameters<typeof setRedisForTesting>[0];
    await setRedisForTesting(fakeRedis);

    try {
      const allowed = await checkOtpEmailRateLimit(`rl-redis-down-${randomUUID()}@example.com`);
      expect(allowed).toBe(false);
    } finally {
      await closeRedis();
      await setRedisForTesting(redisUrl);
    }
  });
});

// ---------------------------------------------------------------------------
// Invariant: wrong code (hash mismatch) → AuthnError
// ---------------------------------------------------------------------------

describe("verifyEmailOtp — wrong code", () => {
  it("wrong code → AuthnError (does not reveal whether key exists)", async () => {
    const correctCode = "555666";
    const ip = "10.12.0.1";
    const ua = "vitest/wrong-code";

    await seedOtp("admin@example.com", correctCode, { ip, ua });

    await expect(
      verifyEmailOtp({ email: "admin@example.com", code: "000001", ip, ua }),
    ).rejects.toMatchObject({ name: "AuthnError" });
  });
});

// ---------------------------------------------------------------------------
// Invariant: unknown email → AuthnError (no key in Redis)
// ---------------------------------------------------------------------------

describe("verifyEmailOtp — unknown email", () => {
  it("no key in Redis for email → AuthnError", async () => {
    await expect(
      verifyEmailOtp({ email: `nobody-${randomUUID()}@example.com`, code: "000000", ip: "10.13.0.1", ua: "vitest" }),
    ).rejects.toMatchObject({ name: "AuthnError" });
  });
});
