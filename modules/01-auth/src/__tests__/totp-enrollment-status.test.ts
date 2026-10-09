/**
 * Integration tests for getEnrollmentStatus — modules/01-auth/src/totp.ts (lines 501–513).
 *
 * Uses postgres:16-alpine + redis:7-alpine testcontainers so the full
 * RLS + assessiq_system BYPASSRLS stack is exercised against real services.
 *
 * Container pair started ONCE in beforeAll, torn down in afterAll.
 * Each test that mutates the DB uses a fresh userId so tests are independent.
 * The shared tenantId is seeded once and reused across E1–E5.
 *
 * Migration order:
 *   02-tenancy: 0001, 0002, 0003
 *   Stub users table (03-users Window 5)
 *   01-auth: 010..015 in lexical order
 *   14-audit-log: 0050 — required for E5 (adminResetTotp emits an audit event)
 *
 * Test labels:
 *   E1 — no user_credentials row → { enrolled: false }
 *   E2 — row with totp_enrolled_at IS NULL → { enrolled: false }
 *   E3 — row with totp_enrolled_at = now() → { enrolled: true }
 *   E4 — cross-tenant: enrolled row in tenantId2, queried under tenantId1 → { enrolled: false }
 *   E5 — after adminResetTotp on an enrolled row → { enrolled: false }
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { setRedisForTesting, closeRedis } from "../redis.js";
import { totp } from "../totp.js";

// ---------------------------------------------------------------------------
// Path helpers — copied exactly from totp.test.ts
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

const THIS_DIR         = toFsPath(new URL(".", import.meta.url));
const AUTH_MODULE_ROOT = join(THIS_DIR, "..", "..");             // modules/01-auth/
const MODULES_ROOT     = join(AUTH_MODULE_ROOT, "..");           // modules/

const TENANCY_MIGRATIONS = join(MODULES_ROOT, "02-tenancy", "migrations");
const AUTH_MIGRATIONS    = join(AUTH_MODULE_ROOT, "migrations");
const AUDIT_MIGRATIONS   = join(MODULES_ROOT, "14-audit-log", "migrations");

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let pgContainer: StartedTestContainer;
let redisContainer: StartedTestContainer;
let pgUrl: string;
let redisUrl: string;

// Shared tenant — seeded once, reused across all tests.
let tenantId: string;

// ---------------------------------------------------------------------------
// Superuser helper
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
// Global setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // 1. Start postgres:16-alpine and redis:7-alpine in parallel.
  [pgContainer, redisContainer] = await Promise.all([
    new GenericContainer("postgres:16-alpine")
      .withEnvironment({
        POSTGRES_USER: "test",
        POSTGRES_PASSWORD: "test",
        POSTGRES_DB: "aiq_test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
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

  // 2. Apply migrations.
  const tenancyFiles = (await readdir(TENANCY_MIGRATIONS))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const authFiles = (await readdir(AUTH_MIGRATIONS))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const auditFiles = (await readdir(AUDIT_MIGRATIONS))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  await withSuperClient(async (client) => {
    // 02-tenancy migrations (tenants, RLS helpers, tenants RLS).
    for (const file of tenancyFiles) {
      const sql = await readFile(join(TENANCY_MIGRATIONS, file), "utf-8");
      await client.query(sql);
    }

    // Minimal users stub — 03-users ships in Window 5.
    // FK target for user_credentials.user_id and audit_log.actor_user_id.
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id  UUID NOT NULL REFERENCES tenants(id),
        email      TEXT NOT NULL,
        name       TEXT NOT NULL DEFAULT 'test',
        role       TEXT NOT NULL DEFAULT 'admin',
        status     TEXT NOT NULL DEFAULT 'active',
        deleted_at TIMESTAMPTZ
      )
    `);

    // 01-auth migrations (010–015, lexical).
    for (const file of authFiles) {
      const sql = await readFile(join(AUTH_MIGRATIONS, file), "utf-8");
      await client.query(sql);
    }

    // 14-audit-log migration — required for E5 (adminResetTotp emits audit event).
    for (const file of auditFiles) {
      const sql = await readFile(join(AUDIT_MIGRATIONS, file), "utf-8");
      await client.query(sql);
    }
  });

  // 3. Point module singletons at the containers.
  await setPoolForTesting(pgUrl);
  await setRedisForTesting(redisUrl);

  // 4. Seed a shared tenant.
  tenantId = randomUUID();

  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`,
      [tenantId, "enroll-status-tenant", "Enrollment Status Test Tenant"],
    );
    await client.query(
      `INSERT INTO tenant_settings (tenant_id) VALUES ($1)`,
      [tenantId],
    );
  });
}, 120_000);

afterAll(async () => {
  await closeRedis();
  await closePool();
  await Promise.all([
    pgContainer?.stop(),
    redisContainer?.stop(),
  ]);
});

// ---------------------------------------------------------------------------
// E1 — No user_credentials row for the user → { enrolled: false }
// ---------------------------------------------------------------------------

it("E1: getEnrollmentStatus returns enrolled:false for user with no user_credentials row", async () => {
  const userId = randomUUID();
  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name) VALUES ($1, $2, $3, $4)`,
      [userId, tenantId, "e1@example.com", "E1 User"],
    );
  });

  const status = await totp.getEnrollmentStatus(userId, tenantId);
  expect(status.enrolled).toBe(false);
});

// ---------------------------------------------------------------------------
// E2 — Row exists with totp_enrolled_at IS NULL → { enrolled: false }
// ---------------------------------------------------------------------------

it("E2: getEnrollmentStatus returns enrolled:false when user_credentials row has totp_enrolled_at IS NULL", async () => {
  const userId = randomUUID();
  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name) VALUES ($1, $2, $3, $4)`,
      [userId, tenantId, "e2@example.com", "E2 User"],
    );
    // Seed a credentials row with no TOTP secret or enrollment timestamp.
    // Note: user_credentials PK is user_id (no separate id column).
    await client.query(
      `INSERT INTO user_credentials (user_id, tenant_id, totp_secret_enc) VALUES ($1, $2, NULL)`,
      [userId, tenantId],
    );
  });

  const status = await totp.getEnrollmentStatus(userId, tenantId);
  expect(status.enrolled).toBe(false);
});

// ---------------------------------------------------------------------------
// E3 — Row exists with totp_enrolled_at = now() → { enrolled: true }
// ---------------------------------------------------------------------------

it("E3: getEnrollmentStatus returns enrolled:true when user_credentials row has totp_enrolled_at set", async () => {
  const userId = randomUUID();
  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name) VALUES ($1, $2, $3, $4)`,
      [userId, tenantId, "e3@example.com", "E3 User"],
    );
    await client.query(
      `INSERT INTO user_credentials (user_id, tenant_id, totp_enrolled_at) VALUES ($1, $2, now())`,
      [userId, tenantId],
    );
  });

  const status = await totp.getEnrollmentStatus(userId, tenantId);
  expect(status.enrolled).toBe(true);
});

// ---------------------------------------------------------------------------
// E4 — Cross-tenant guard: enrolled credentials in tenantId2, queried under
//       tenantId1 → RLS hides the row → { enrolled: false }
// ---------------------------------------------------------------------------

it("E4: getEnrollmentStatus returns enrolled:false when the credentials row belongs to a different tenant (RLS guard)", async () => {
  const tenantId2 = randomUUID();
  const userId2   = randomUUID();

  await withSuperClient(async (client) => {
    // Create a second tenant with its own settings row.
    await client.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`,
      [tenantId2, "enroll-status-tenant-2", "Enrollment Status Test Tenant 2"],
    );
    await client.query(
      `INSERT INTO tenant_settings (tenant_id) VALUES ($1)`,
      [tenantId2],
    );
    // Create a user in tenantId2 with an enrolled credentials row.
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name) VALUES ($1, $2, $3, $4)`,
      [userId2, tenantId2, "e4@example.com", "E4 User"],
    );
    await client.query(
      `INSERT INTO user_credentials (user_id, tenant_id, totp_enrolled_at) VALUES ($1, $2, now())`,
      [userId2, tenantId2],
    );
  });

  // Querying userId2 under tenantId1 — RLS filters the row out because
  // the credentials row has tenant_id = tenantId2, not tenantId1.
  const status = await totp.getEnrollmentStatus(userId2, tenantId);
  expect(status.enrolled).toBe(false);
});

// ---------------------------------------------------------------------------
// E5 — After adminResetTotp on an enrolled row → { enrolled: false }
// ---------------------------------------------------------------------------

it("E5: getEnrollmentStatus returns enrolled:false after adminResetTotp revokes a user's enrollment", async () => {
  const adminUserId  = randomUUID();
  const targetUserId = randomUUID();

  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name) VALUES ($1, $2, $3, $4)`,
      [adminUserId, tenantId, "e5-admin@example.com", "E5 Admin"],
    );
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name) VALUES ($1, $2, $3, $4)`,
      [targetUserId, tenantId, "e5-target@example.com", "E5 Target"],
    );
  });

  // Enroll the target user via the normal enrollment flow so the row is
  // properly encrypted (adminResetTotp operates on an existing secret).
  const { secretBase32 } = await totp.enrollStart(
    targetUserId,
    tenantId,
    "e5-target@example.com",
  );

  // Mirror the authenticator config from totp.ts to generate a valid code.
  const { authenticator: _authenticatorBase } = await import("@otplib/preset-default");
  const { HashAlgorithms, KeyEncodings }       = await import("@otplib/core");
  const authenticator = _authenticatorBase.clone({
    algorithm: HashAlgorithms.SHA1,
    encoding:  KeyEncodings.LATIN1,
    step:      30,
    digits:    6,
    window:    1,
  });
  const code = authenticator.generate(secretBase32);
  await totp.enrollConfirm(targetUserId, tenantId, code);

  // Sanity-check: target user is now enrolled.
  const before = await totp.getEnrollmentStatus(targetUserId, tenantId);
  expect(before.enrolled).toBe(true);

  // Admin resets TOTP — clears secret + recovery codes + enrollment timestamp.
  await totp.adminResetTotp(adminUserId, tenantId, targetUserId);

  // After reset the user is no longer enrolled.
  const after = await totp.getEnrollmentStatus(targetUserId, tenantId);
  expect(after.enrolled).toBe(false);
});
