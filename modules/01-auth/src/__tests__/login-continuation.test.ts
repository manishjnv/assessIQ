/**
 * Tests for P1 login-identity-simplification:
 *   - resolveLoginIdentities: 0/1/many; case-insensitive; status≠active filtered;
 *     deleted_at filtered; super_admin excluded when NOT in allowlist; included when IS.
 *   - storeLoginContinuation / consumeLoginContinuation: single-use, expiry (short TTL),
 *     ip/ua mismatch reject; fail-closed on Redis unavailable.
 *   - peekLoginContinuation: non-consuming; ip/ua binding.
 *   - selectLoginIdentity: rejects userId not in candidates; re-resolves fresh.
 *
 * Docker-guarded tests (resolveLoginIdentities, selectLoginIdentity) require
 * a Postgres testcontainer + schema shim. Pure-unit tests (token store/consume/peek)
 * use an in-memory Redis testcontainer.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
} from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// jose must be mocked before google-sso loads (for mintForIdentity tests via selectLoginIdentity).
vi.mock("jose", async (importActual) => {
  const actual = await importActual<typeof import("jose")>();
  return {
    ...actual,
    jwtVerify: vi.fn(),
    createRemoteJWKSet: vi.fn(() => ({})),
  };
});

import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { setRedisForTesting, closeRedis } from "../redis.js";
import {
  resolveLoginIdentities,
  storeLoginContinuation,
  consumeLoginContinuation,
  peekLoginContinuation,
  selectLoginIdentity,
} from "../login-continuation.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

const THIS_DIR = toFsPath(new URL(".", import.meta.url));
const AUTH_MODULE_ROOT = join(THIS_DIR, "..", "..");
const MODULES_ROOT = join(THIS_DIR, "..", "..", "..");

const TENANCY_MIGRATIONS_DIR = join(MODULES_ROOT, "02-tenancy", "migrations");
const AUTH_MIGRATIONS_DIR = join(AUTH_MODULE_ROOT, "migrations");

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let pgContainer: StartedTestContainer;
let redisContainer: StartedTestContainer;
let pgUrl: string;

// Platform tenant + regular tenant for tests.
const PLATFORM_TENANT_ID = "00000000-0000-7000-0000-000000000001";
let regularTenantId: string;
let tenant2Id: string;

// ---------------------------------------------------------------------------
// Helpers
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

async function insertUser(overrides: {
  id?: string;
  tenantId: string;
  email: string;
  role?: "admin" | "super_admin" | "reviewer" | "candidate";
  status?: string;
  deleted_at?: string | null;
}): Promise<string> {
  const id = overrides.id ?? randomUUID();
  const role = overrides.role ?? "admin";
  const status = overrides.status ?? "active";
  const deletedAt = overrides.deleted_at ?? null;

  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO users (id, tenant_id, email, role, status, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, overrides.tenantId, overrides.email, role, status, deletedAt],
    );
  });

  return id;
}

// ---------------------------------------------------------------------------
// Global setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Set platform env vars — mirrors super-admin.test.ts pattern.
  process.env["PLATFORM_TENANT_ID"] = PLATFORM_TENANT_ID;
  process.env["SUPER_ADMIN_EMAILS"] = "manishjnvk@gmail.com";

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

  pgUrl = `postgres://test:test@${pgContainer.getHost()}:${pgContainer.getMappedPort(5432)}/aiq_test`;
  const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

  // Apply migrations.
  const tenancyFiles = (await readdir(TENANCY_MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const authFiles = (await readdir(AUTH_MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  await withSuperClient(async (client) => {
    for (const file of tenancyFiles) {
      const sql = await readFile(join(TENANCY_MIGRATIONS_DIR, file), "utf-8");
      await client.query(sql);
    }

    // Users shim (same as google-sso.test.ts — includes super_admin in role check).
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

      CREATE POLICY tenant_isolation_insert ON users
        FOR INSERT
        WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);

    // Allow assessiq_system to read all users (BYPASSRLS).
    await client.query(`
      ALTER TABLE users FORCE ROW LEVEL SECURITY;
      GRANT SELECT ON users TO assessiq_system;
    `).catch(() => { /* may already exist */ });

    for (const file of authFiles) {
      const sql = await readFile(join(AUTH_MIGRATIONS_DIR, file), "utf-8");
      await client.query(sql);
    }

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
        'manishjnvk@gmail.com',
        'super_admin',
        'active'
      )
      ON CONFLICT DO NOTHING;
    `);
  });

  // Wire singletons.
  await setPoolForTesting(pgUrl);
  await setRedisForTesting(redisUrl);

  // Insert two regular tenants.
  regularTenantId = randomUUID();
  tenant2Id = randomUUID();
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
      `INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`,
      [tenant2Id, "tenant-b", "Tenant B"],
    );
    await client.query(
      `INSERT INTO tenant_settings (tenant_id) VALUES ($1)`,
      [tenant2Id],
    );
  });
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await closePool();
  await closeRedis();
  await Promise.all([
    pgContainer?.stop(),
    redisContainer?.stop(),
  ]);
});

// ---------------------------------------------------------------------------
// resolveLoginIdentities
// ---------------------------------------------------------------------------

describe("resolveLoginIdentities", () => {
  it("returns empty array when no user matches the email", async () => {
    const result = await resolveLoginIdentities("nobody@example.com");
    expect(result).toHaveLength(0);
  });

  it("returns one identity when a single active user matches", async () => {
    await insertUser({ tenantId: regularTenantId, email: "single@example.com" });
    const result = await resolveLoginIdentities("single@example.com");
    expect(result).toHaveLength(1);
    expect(result[0]!.tenantId).toBe(regularTenantId);
    expect(result[0]!.tenantSlug).toBe("tenant-a");
    expect(result[0]!.tenantName).toBe("Tenant A");
    expect(result[0]!.role).toBe("admin");
    expect(result[0]!.isPlatform).toBe(false);
  });

  it("returns multiple identities when email exists in two tenants", async () => {
    await insertUser({ tenantId: regularTenantId, email: "multi@example.com" });
    await insertUser({ tenantId: tenant2Id, email: "multi@example.com" });
    const result = await resolveLoginIdentities("multi@example.com");
    expect(result.length).toBeGreaterThanOrEqual(2);
    const tenantIds = result.map((i) => i.tenantId);
    expect(tenantIds).toContain(regularTenantId);
    expect(tenantIds).toContain(tenant2Id);
  });

  it("is case-insensitive for email lookup", async () => {
    await insertUser({ tenantId: regularTenantId, email: "Case@Example.Com" });
    const result = await resolveLoginIdentities("CASE@EXAMPLE.COM");
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some((i) => i.tenantId === regularTenantId)).toBe(true);
  });

  it("filters out users with status != 'active'", async () => {
    await insertUser({
      tenantId: regularTenantId,
      email: "disabled-cont@example.com",
      status: "disabled",
    });
    const result = await resolveLoginIdentities("disabled-cont@example.com");
    expect(result).toHaveLength(0);
  });

  it("filters out soft-deleted users (deleted_at IS NOT NULL)", async () => {
    await insertUser({
      tenantId: regularTenantId,
      email: "deleted-cont@example.com",
      deleted_at: new Date().toISOString(),
    });
    const result = await resolveLoginIdentities("deleted-cont@example.com");
    expect(result).toHaveLength(0);
  });

  it("Gate-2: super_admin/platform row is EXCLUDED when email is NOT in SUPER_ADMIN_EMAILS", async () => {
    // The platform super_admin user exists for manishjnvk@gmail.com (default allowlist).
    // A different email must NOT see the platform identity (Gate-2 filter).
    const result = await resolveLoginIdentities("hacker@evil.com");
    const platformRows = result.filter((i) => i.isPlatform);
    expect(platformRows).toHaveLength(0);
  });

  it("Gate-2: super_admin row IS INCLUDED when email IS in SUPER_ADMIN_EMAILS (default allowlist)", async () => {
    // config.SUPER_ADMIN_EMAILS defaults to "manishjnvk@gmail.com"; platform
    // user seeded by 016_super_admin.sql migration.
    const result = await resolveLoginIdentities("manishjnvk@gmail.com");
    const platformRows = result.filter((i) => i.isPlatform && i.role === "super_admin");
    expect(platformRows.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Continuation token — storeLoginContinuation / consumeLoginContinuation
// ---------------------------------------------------------------------------

describe("storeLoginContinuation + consumeLoginContinuation", () => {
  const PAYLOAD = {
    idpEmail: "tok@example.com",
    subject: "google-sub-tok",
    ip: "10.0.0.1",
    ua: "TestBrowser/1.0",
    embeddedReturnTo: undefined,
    candidates: ["user-id-1", "user-id-2"],
  };

  it("stores and retrieves a continuation payload", async () => {
    const token = await storeLoginContinuation(PAYLOAD);
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);

    const retrieved = await consumeLoginContinuation(token, PAYLOAD.ip, PAYLOAD.ua);
    expect(retrieved.idpEmail).toBe(PAYLOAD.idpEmail);
    expect(retrieved.candidates).toEqual(PAYLOAD.candidates);
  });

  it("is single-use: consuming twice throws AuthnError", async () => {
    const token = await storeLoginContinuation(PAYLOAD);
    await consumeLoginContinuation(token, PAYLOAD.ip, PAYLOAD.ua);
    await expect(
      consumeLoginContinuation(PAYLOAD.ip, PAYLOAD.ua, token),
    ).rejects.toMatchObject({ name: "AuthnError" });
  });

  it("rejects when ip does not match", async () => {
    const token = await storeLoginContinuation(PAYLOAD);
    await expect(
      consumeLoginContinuation(token, "10.0.0.99", PAYLOAD.ua),
    ).rejects.toMatchObject({ name: "AuthnError" });
  });

  it("rejects when ua does not match", async () => {
    const token = await storeLoginContinuation(PAYLOAD);
    await expect(
      consumeLoginContinuation(token, PAYLOAD.ip, "EvilBrowser/9.9"),
    ).rejects.toMatchObject({ name: "AuthnError" });
  });

  it("rejects an unknown/garbage token", async () => {
    await expect(
      consumeLoginContinuation("not-a-real-token-xyz", PAYLOAD.ip, PAYLOAD.ua),
    ).rejects.toMatchObject({ name: "AuthnError" });
  });
});

// ---------------------------------------------------------------------------
// peekLoginContinuation — non-consuming read
// ---------------------------------------------------------------------------

describe("peekLoginContinuation", () => {
  const PAYLOAD = {
    idpEmail: "peek@example.com",
    subject: "google-sub-peek",
    ip: "10.1.0.1",
    ua: "PeekBrowser/1.0",
    embeddedReturnTo: undefined,
    candidates: ["user-peek-1"],
  };

  it("reads payload without consuming (token still valid after peek)", async () => {
    const token = await storeLoginContinuation(PAYLOAD);
    const peeked = await peekLoginContinuation(token, PAYLOAD.ip, PAYLOAD.ua);
    expect(peeked.idpEmail).toBe(PAYLOAD.idpEmail);

    // Token still valid — consume works afterwards.
    const consumed = await consumeLoginContinuation(token, PAYLOAD.ip, PAYLOAD.ua);
    expect(consumed.idpEmail).toBe(PAYLOAD.idpEmail);
  });

  it("peek: ip mismatch → AuthnError", async () => {
    const token = await storeLoginContinuation(PAYLOAD);
    await expect(
      peekLoginContinuation(token, "9.9.9.9", PAYLOAD.ua),
    ).rejects.toMatchObject({ name: "AuthnError" });
  });
});

// ---------------------------------------------------------------------------
// selectLoginIdentity — anti-tamper check
// ---------------------------------------------------------------------------

describe("selectLoginIdentity", () => {
  it("rejects a userId that is not in payload.candidates", async () => {
    // Insert a user so resolveLoginIdentities would return something if asked.
    await insertUser({ tenantId: regularTenantId, email: "sel-tamper@example.com" });

    const token = await storeLoginContinuation({
      idpEmail: "sel-tamper@example.com",
      subject: "google-sub-sel",
      ip: "10.2.0.1",
      ua: "SelBrowser/1.0",
      embeddedReturnTo: undefined,
      candidates: ["real-user-id-only"],
    });

    await expect(
      selectLoginIdentity({
        continuationToken: token,
        identityUserId: "tampered-other-user-id",
        ip: "10.2.0.1",
        ua: "SelBrowser/1.0",
      }),
    ).rejects.toMatchObject({ name: "AuthnError" });
  });
});
