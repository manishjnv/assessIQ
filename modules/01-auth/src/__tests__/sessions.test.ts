/**
 * Integration tests for modules/01-auth — sessions.ts
 *
 * Uses postgres:16-alpine + redis:7-alpine testcontainers so the full
 * RLS + assessiq_system BYPASSRLS stack, Redis fast-path, and per-user
 * index are exercised against real services.
 *
 * Container pair is started ONCE in beforeAll and torn down in afterAll.
 *
 * Migration order:
 *   02-tenancy: 0001_tenants.sql, 0002_rls_helpers.sql, 0003_tenants_rls.sql
 *   Stub users table (03-users Window 5; FK target for sessions.user_id)
 *   01-auth: 010..015 in lexical order
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool, withTenant } from "@assessiq/tenancy";
import { setRedisForTesting, closeRedis, getRedis } from "../redis.js";
import { sessions, isIdleExpired, IDLE_EVICTION_MS } from "../sessions.js";
import { sha256Hex } from "../crypto-util.js";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

const THIS_DIR          = toFsPath(new URL(".", import.meta.url));  // .../src/__tests__/
const AUTH_MODULE_ROOT  = join(THIS_DIR, "..", "..");                // modules/01-auth/
const MODULES_ROOT      = join(AUTH_MODULE_ROOT, "..");              // modules/

const TENANCY_MIGRATIONS = join(MODULES_ROOT, "02-tenancy", "migrations");
const AUTH_MIGRATIONS    = join(AUTH_MODULE_ROOT, "migrations");

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let pgContainer: StartedTestContainer;
let redisContainer: StartedTestContainer;
let pgUrl: string;
let redisUrl: string;

// Two tenants for RLS isolation test.
let tenantA: string;
let tenantB: string;

// One user per tenant (FK target for sessions.user_id).
let userA: string;
let userB: string;

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

  // 2. Apply migrations in dependency order.
  const tenancyFiles = (await readdir(TENANCY_MIGRATIONS))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const authFiles = (await readdir(AUTH_MIGRATIONS))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  await withSuperClient(async (client) => {
    // 02-tenancy migrations (tenants, RLS helpers, tenants RLS).
    for (const file of tenancyFiles) {
      const sql = await readFile(join(TENANCY_MIGRATIONS, file), "utf-8");
      await client.query(sql);
    }

    // Minimal users stub — 03-users ships in Window 5.
    // sessions.user_id references users(id); we need the table to exist.
    await client.query(`
      CREATE TABLE users (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id  UUID NOT NULL REFERENCES tenants(id),
        email      TEXT NOT NULL DEFAULT 'x',
        name       TEXT NOT NULL DEFAULT 'x',
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
  });

  // 3. Point module singletons at the containers.
  await setPoolForTesting(pgUrl);
  await setRedisForTesting(redisUrl);

  // 4. Seed two tenants and one user per tenant (superuser bypass).
  tenantA = randomUUID();
  tenantB = randomUUID();
  userA   = randomUUID();
  userB   = randomUUID();

  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3), ($4, $5, $6)`,
      [tenantA, "tenant-a", "Tenant A", tenantB, "tenant-b", "Tenant B"],
    );
    await client.query(
      `INSERT INTO tenant_settings (tenant_id) VALUES ($1), ($2)`,
      [tenantA, tenantB],
    );
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name) VALUES
         ($1, $2, 'admin-a@example.com', 'Admin A'),
         ($3, $4, 'admin-b@example.com', 'Admin B')`,
      [userA, tenantA, userB, tenantB],
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
// Test 1 — sessions.create writes Postgres + Redis + per-user index
// ---------------------------------------------------------------------------

it("sessions.create writes Postgres row, Redis session key, and per-user index with correct TTL", async () => {
  const before = Date.now();

  const result = await sessions.create({
    userId: userA,
    tenantId: tenantA,
    role: "admin",
    totpVerified: false,
    ip: "127.0.0.1",
    ua: "test-agent/1",
  });

  const tokenHash = sha256Hex(result.token);
  const redis = getRedis();

  // Postgres row exists.
  const pgRows = await withSuperClient(async (client) => {
    return client.query<{ count: string }>(
      `SELECT count(*) FROM sessions WHERE id = $1`,
      [result.id],
    );
  });
  expect(pgRows.rows[0]?.count).toBe("1");

  // Redis session key exists.
  const sessExists = await redis.exists(`aiq:sess:${tokenHash}`);
  expect(sessExists).toBe(1);

  // Per-user index contains the token hash.
  const members = await redis.smembers(`aiq:user:sessions:${userA}`);
  expect(members).toContain(tokenHash);

  // Per-user index TTL is between 32000 and 32400 seconds (9h = 32400).
  const indexTtl = await redis.ttl(`aiq:user:sessions:${userA}`);
  expect(indexTtl).toBeGreaterThan(32000);
  expect(indexTtl).toBeLessThanOrEqual(32400);

  // Returned expiresAt is approximately now + 8h (within 5s).
  const expiresMs = new Date(result.expiresAt).getTime();
  const expectedMs = before + 8 * 60 * 60 * 1000;
  expect(Math.abs(expiresMs - expectedMs)).toBeLessThan(5000);
});

// ---------------------------------------------------------------------------
// Test 2 — sessions.get returns null for unknown token
// ---------------------------------------------------------------------------

it("sessions.get returns null for unknown token", async () => {
  const result = await sessions.get("totally-unknown-token-value-that-does-not-exist");
  expect(result).toBeNull();
});

// ---------------------------------------------------------------------------
// Test 3 — sessions.get returns the session JSON exactly as stored
// ---------------------------------------------------------------------------

it("sessions.get returns the session with correct structure and ISO 8601 UTC timestamps", async () => {
  const created = await sessions.create({
    userId: userA,
    tenantId: tenantA,
    role: "reviewer",
    totpVerified: true,
    ip: "10.0.0.1",
    ua: "vitest/1",
  });

  const sess = await sessions.get(created.token);
  expect(sess).not.toBeNull();

  // Shape: all expected fields present.
  expect(sess).toHaveProperty("id");
  expect(sess).toHaveProperty("userId", userA);
  expect(sess).toHaveProperty("tenantId", tenantA);
  expect(sess).toHaveProperty("role", "reviewer");
  expect(sess).toHaveProperty("totpVerified", true);
  expect(sess).toHaveProperty("createdAt");
  expect(sess).toHaveProperty("expiresAt");
  expect(sess).toHaveProperty("lastSeenAt");
  expect(sess).toHaveProperty("lastTotpAt");
  expect(sess).toHaveProperty("ip", "10.0.0.1");
  expect(sess).toHaveProperty("ua", "vitest/1");

  // All ISO 8601 timestamp strings must end with "Z".
  expect(sess!.createdAt).toMatch(/Z$/);
  expect(sess!.expiresAt).toMatch(/Z$/);
  expect(sess!.lastSeenAt).toMatch(/Z$/);
  // lastTotpAt is set because totpVerified=true at create.
  expect(sess!.lastTotpAt).not.toBeNull();
  expect(sess!.lastTotpAt!).toMatch(/Z$/);
});

// ---------------------------------------------------------------------------
// Test 4 — sessions.refresh extends expiresAt and lastSeenAt
// ---------------------------------------------------------------------------

it("sessions.refresh extends expiresAt and lastSeenAt, and updates Postgres", async () => {
  const created = await sessions.create({
    userId: userA,
    tenantId: tenantA,
    role: "admin",
    totpVerified: false,
    ip: "127.0.0.1",
    ua: "refresh-test/1",
  });

  const original = await sessions.get(created.token);
  expect(original).not.toBeNull();

  const originalExpiresAt = original!.expiresAt;
  const originalLastSeenAt = original!.lastSeenAt;

  // Wait 100ms so timestamps are strictly later.
  await new Promise<void>((resolve) => setTimeout(resolve, 100));

  const refreshed = await sessions.refresh(created.token);
  expect(refreshed).not.toBeNull();

  // Both timestamps must be later than the originals.
  expect(new Date(refreshed!.expiresAt).getTime()).toBeGreaterThan(
    new Date(originalExpiresAt).getTime(),
  );
  expect(new Date(refreshed!.lastSeenAt).getTime()).toBeGreaterThan(
    new Date(originalLastSeenAt).getTime(),
  );

  // Postgres row updated.
  const tokenHash = sha256Hex(created.token);
  const pgRow = await withSuperClient(async (client) => {
    return client.query<{ expires_at: string; last_seen_at: string }>(
      `SELECT expires_at, last_seen_at FROM sessions WHERE token_hash = $1`,
      [tokenHash],
    );
  });
  expect(pgRow.rows).toHaveLength(1);
  expect(new Date(pgRow.rows[0]!.expires_at).getTime()).toBeGreaterThan(
    new Date(originalExpiresAt).getTime(),
  );
  expect(new Date(pgRow.rows[0]!.last_seen_at).getTime()).toBeGreaterThan(
    new Date(originalLastSeenAt).getTime(),
  );
});

// ---------------------------------------------------------------------------
// Test 5 — sessions.refresh returns null for unknown token
// ---------------------------------------------------------------------------

it("sessions.refresh returns null for unknown token", async () => {
  const result = await sessions.refresh("unknown-token-for-refresh-test");
  expect(result).toBeNull();
});

// ---------------------------------------------------------------------------
// Test 6 — sessions.refresh destroys idle-expired session and returns null
// ---------------------------------------------------------------------------

it("sessions.refresh destroys idle-expired session (lastSeenAt >30min ago) and returns null", async () => {
  const created = await sessions.create({
    userId: userA,
    tenantId: tenantA,
    role: "admin",
    totpVerified: false,
    ip: "127.0.0.1",
    ua: "idle-eviction-test/1",
  });

  const tokenHash = sha256Hex(created.token);
  const redis = getRedis();

  // Manually backdate lastSeenAt to 31 minutes ago in the Redis JSON.
  const rawJson = await redis.get(`aiq:sess:${tokenHash}`);
  expect(rawJson).not.toBeNull();
  const sessData = JSON.parse(rawJson!) as Record<string, unknown>;
  const stalePast = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  sessData["lastSeenAt"] = stalePast;
  await redis.set(`aiq:sess:${tokenHash}`, JSON.stringify(sessData), "KEEPTTL");

  // Refresh must return null (idle-expired path).
  const result = await sessions.refresh(created.token);
  expect(result).toBeNull();

  // Redis session key gone.
  const sessExists = await redis.exists(`aiq:sess:${tokenHash}`);
  expect(sessExists).toBe(0);

  // Postgres row gone.
  const pgRows = await withSuperClient(async (client) => {
    return client.query<{ count: string }>(
      `SELECT count(*) FROM sessions WHERE token_hash = $1`,
      [tokenHash],
    );
  });
  expect(pgRows.rows[0]?.count).toBe("0");

  // Per-user index entry gone.
  const members = await redis.smembers(`aiq:user:sessions:${userA}`);
  expect(members).not.toContain(tokenHash);
});

// ---------------------------------------------------------------------------
// Test 7 — isIdleExpired: false for fresh session, true for 31-min stale
// ---------------------------------------------------------------------------

describe("isIdleExpired", () => {
  it("returns false for a session with lastSeenAt = now", async () => {
    const created = await sessions.create({
      userId: userA,
      tenantId: tenantA,
      role: "admin",
      totpVerified: false,
      ip: "127.0.0.1",
      ua: "idle-check/1",
    });
    const sess = await sessions.get(created.token);
    expect(sess).not.toBeNull();
    expect(isIdleExpired(sess!)).toBe(false);
  });

  it("returns true for a session with lastSeenAt = 31 minutes ago", async () => {
    const created = await sessions.create({
      userId: userA,
      tenantId: tenantA,
      role: "admin",
      totpVerified: false,
      ip: "127.0.0.1",
      ua: "idle-check/2",
    });
    const sess = await sessions.get(created.token);
    expect(sess).not.toBeNull();

    // Simulate 31 minutes of inactivity by advancing the "now" passed in.
    const futureNow = Date.now() + IDLE_EVICTION_MS + 60_000; // 1 min past cutoff
    expect(isIdleExpired(sess!, futureNow)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 8 — sessions.markTotpVerified flips totpVerified=true, preserves TTL
// ---------------------------------------------------------------------------

it("sessions.markTotpVerified sets totpVerified=true, lastTotpAt, updates Postgres, preserves Redis TTL", async () => {
  const created = await sessions.create({
    userId: userA,
    tenantId: tenantA,
    role: "admin",
    totpVerified: false,
    ip: "127.0.0.1",
    ua: "totp-verify-test/1",
  });

  const tokenHash = sha256Hex(created.token);
  const redis = getRedis();

  // Capture TTL before markTotpVerified.
  const ttlBefore = await redis.ttl(`aiq:sess:${tokenHash}`);
  expect(ttlBefore).toBeGreaterThan(0);

  const updated = await sessions.markTotpVerified(created.token);
  expect(updated).not.toBeNull();

  // Returned session has totpVerified=true and lastTotpAt set.
  expect(updated!.totpVerified).toBe(true);
  expect(updated!.lastTotpAt).not.toBeNull();
  expect(updated!.lastTotpAt!).toMatch(/Z$/);

  // Redis state reflects the change.
  const rawJson = await redis.get(`aiq:sess:${tokenHash}`);
  expect(rawJson).not.toBeNull();
  const cached = JSON.parse(rawJson!) as Record<string, unknown>;
  expect(cached["totpVerified"]).toBe(true);
  expect(cached["lastTotpAt"]).not.toBeNull();

  // Postgres updated.
  const pgRow = await withSuperClient(async (client) => {
    return client.query<{ totp_verified: boolean; last_totp_at: string | null }>(
      `SELECT totp_verified, last_totp_at FROM sessions WHERE token_hash = $1`,
      [tokenHash],
    );
  });
  expect(pgRow.rows).toHaveLength(1);
  expect(pgRow.rows[0]!.totp_verified).toBe(true);
  expect(pgRow.rows[0]!.last_totp_at).not.toBeNull();

  // TTL approximately preserved — markTotpVerified does NOT extend lifetime.
  // Allow 2s window for test execution.
  const ttlAfter = await redis.ttl(`aiq:sess:${tokenHash}`);
  expect(Math.abs(ttlAfter - ttlBefore)).toBeLessThanOrEqual(2);
});

// ---------------------------------------------------------------------------
// Test 9 — sessions.markTotpVerified returns null for unknown token
// ---------------------------------------------------------------------------

it("sessions.markTotpVerified returns null for unknown token", async () => {
  const result = await sessions.markTotpVerified("nonexistent-token-for-totp-verify");
  expect(result).toBeNull();
});

// ---------------------------------------------------------------------------
// Test 10 — sessions.markTotpVerified returns null when session expired between get and write
// ---------------------------------------------------------------------------

it("sessions.markTotpVerified returns null when Redis key is gone before SET (race window)", async () => {
  const created = await sessions.create({
    userId: userA,
    tenantId: tenantA,
    role: "admin",
    totpVerified: false,
    ip: "127.0.0.1",
    ua: "race-window-test/1",
  });

  const tokenHash = sha256Hex(created.token);
  const redis = getRedis();

  // Simulate expiry between sessions.get and the TTL check by deleting the key.
  await redis.del(`aiq:sess:${tokenHash}`);

  // markTotpVerified should return null (TTL <= 0 guard fires).
  const result = await sessions.markTotpVerified(created.token);
  expect(result).toBeNull();
});

// ---------------------------------------------------------------------------
// Test 11 — sessions.destroy removes from Redis + Postgres + per-user index
// ---------------------------------------------------------------------------

it("sessions.destroy removes Redis key, Postgres row, and per-user index entry", async () => {
  const created = await sessions.create({
    userId: userA,
    tenantId: tenantA,
    role: "admin",
    totpVerified: false,
    ip: "127.0.0.1",
    ua: "destroy-test/1",
  });

  const tokenHash = sha256Hex(created.token);
  const redis = getRedis();

  await sessions.destroy(created.token);

  // Redis key gone.
  const sessExists = await redis.exists(`aiq:sess:${tokenHash}`);
  expect(sessExists).toBe(0);

  // Postgres row gone.
  const pgRows = await withSuperClient(async (client) => {
    return client.query<{ count: string }>(
      `SELECT count(*) FROM sessions WHERE token_hash = $1`,
      [tokenHash],
    );
  });
  expect(pgRows.rows[0]?.count).toBe("0");

  // Per-user index entry gone.
  const members = await redis.smembers(`aiq:user:sessions:${userA}`);
  expect(members).not.toContain(tokenHash);
});

// ---------------------------------------------------------------------------
// Test 12 — sessions.destroy is idempotent
// ---------------------------------------------------------------------------

it("sessions.destroy is idempotent — no error when called on an already-gone session", async () => {
  const created = await sessions.create({
    userId: userA,
    tenantId: tenantA,
    role: "admin",
    totpVerified: false,
    ip: "127.0.0.1",
    ua: "idempotent-destroy/1",
  });

  await sessions.destroy(created.token);

  // Second destroy must not throw.
  await expect(sessions.destroy(created.token)).resolves.toBeUndefined();
});

// ---------------------------------------------------------------------------
// Test 13 — sessions.destroyAllForUser removes all sessions for a user
// ---------------------------------------------------------------------------

it("sessions.destroyAllForUser removes 3 sessions — returns 3, Redis keys gone, Postgres rows gone, index empty", async () => {
  const redis = getRedis();

  // Create 3 sessions for the same user.
  const [s1, s2, s3] = await Promise.all([
    sessions.create({
      userId: userA,
      tenantId: tenantA,
      role: "admin",
      totpVerified: false,
      ip: "127.0.0.1",
      ua: "destroy-all/1",
    }),
    sessions.create({
      userId: userA,
      tenantId: tenantA,
      role: "admin",
      totpVerified: false,
      ip: "127.0.0.2",
      ua: "destroy-all/2",
    }),
    sessions.create({
      userId: userA,
      tenantId: tenantA,
      role: "admin",
      totpVerified: false,
      ip: "127.0.0.3",
      ua: "destroy-all/3",
    }),
  ]);

  const hashes = [s1, s2, s3].map((s) => sha256Hex(s.token));

  // Confirm all 3 session keys exist before destroy.
  for (const h of hashes) {
    expect(await redis.exists(`aiq:sess:${h}`)).toBe(1);
  }

  const count = await sessions.destroyAllForUser(userA, tenantA);
  expect(count).toBeGreaterThanOrEqual(3);

  // All Redis session keys gone.
  for (const h of hashes) {
    expect(await redis.exists(`aiq:sess:${h}`)).toBe(0);
  }

  // All Postgres rows gone for this user.
  const pgRows = await withSuperClient(async (client) => {
    return client.query<{ count: string }>(
      `SELECT count(*) FROM sessions WHERE user_id = $1`,
      [userA],
    );
  });
  expect(pgRows.rows[0]?.count).toBe("0");

  // Per-user index empty (key deleted or smembers returns []).
  const members = await redis.smembers(`aiq:user:sessions:${userA}`);
  expect(members).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Test 14 — sessions.destroyAllForUser returns 0 when user has no sessions
// ---------------------------------------------------------------------------

it("sessions.destroyAllForUser returns 0 when user has no sessions; idempotent on second call", async () => {
  const ghostUser = randomUUID();

  const count1 = await sessions.destroyAllForUser(ghostUser, tenantA);
  expect(count1).toBe(0);

  // Second call must not throw.
  const count2 = await sessions.destroyAllForUser(ghostUser, tenantA);
  expect(count2).toBe(0);
});

// ---------------------------------------------------------------------------
// Test 15 — Multi-tenant isolation: tenant A's sessions invisible from tenant B
// ---------------------------------------------------------------------------

it("multi-tenant RLS isolation: tenant B context sees zero rows from tenant A sessions", async () => {
  // Create a session for tenantA / userA.
  await sessions.create({
    userId: userA,
    tenantId: tenantA,
    role: "admin",
    totpVerified: false,
    ip: "127.0.0.1",
    ua: "rls-isolation-test/1",
  });

  // Query sessions from tenant B's RLS context — must see zero rows.
  const rows = await withTenant(tenantB, async (client) => {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM sessions WHERE tenant_id = $1`,
      [tenantA],
    );
    return result.rows;
  });

  expect(rows).toHaveLength(0);
});
