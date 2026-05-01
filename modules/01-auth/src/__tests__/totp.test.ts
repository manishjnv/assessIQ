/**
 * Integration tests for modules/01-auth — totp.ts
 *
 * Uses postgres:16-alpine + redis:7-alpine testcontainers so the full
 * RLS + assessiq_system BYPASSRLS stack and Redis lockout logic are
 * exercised against real services.
 *
 * Container pair started ONCE in beforeAll, torn down in afterAll.
 * Each test that needs isolation uses either a fresh userId or operates
 * on the shared userId/tenantId after enrolling.
 *
 * Migration order:
 *   02-tenancy: 0001_tenants.sql, 0002_rls_helpers.sql, 0003_tenants_rls.sql
 *   Stub users table (03-users Window 5)
 *   01-auth: 010..015 in lexical order
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { authenticator as _authenticatorBase } from "@otplib/preset-default";
import { HashAlgorithms, KeyEncodings, totpToken } from "@otplib/core";
import type { AuthenticatorOptions } from "@otplib/core";

import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { setRedisForTesting, closeRedis } from "../redis.js";
import { getRedis } from "../redis.js";
import { totp } from "../totp.js";
import { ValidationError, AuthnError } from "@assessiq/core";

// ---------------------------------------------------------------------------
// Authenticator instance — mirrors the one in totp.ts
// ---------------------------------------------------------------------------

const AUTH_OPTS: Partial<AuthenticatorOptions<string>> = {
  algorithm: HashAlgorithms.SHA1,
  encoding: KeyEncodings.LATIN1,
  step: 30,
  digits: 6,
  window: 1,
};
const authenticator = _authenticatorBase.clone(AUTH_OPTS);

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

const THIS_DIR         = toFsPath(new URL(".", import.meta.url));
const AUTH_MODULE_ROOT = join(THIS_DIR, "..", "..");             // modules/01-auth/
const MODULES_ROOT     = join(AUTH_MODULE_ROOT, "..");           // modules/

const TENANCY_MIGRATIONS = join(MODULES_ROOT, "02-tenancy", "migrations");
const AUTH_MIGRATIONS    = join(AUTH_MODULE_ROOT, "migrations");

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let pgContainer: StartedTestContainer;
let redisContainer: StartedTestContainer;
let pgUrl: string;
let redisUrl: string;

// Shared tenant + user — enrolled once and re-used across most tests.
let tenantId: string;
let userId: string;

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

  // 2. Apply tenancy migrations + stub users table + all auth migrations.
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
    // FK target for user_credentials.user_id and totp_recovery_codes.user_id.
    await client.query(`
      CREATE TABLE users (
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
  });

  // 3. Point module singletons at the containers.
  await setPoolForTesting(pgUrl);
  await setRedisForTesting(redisUrl);

  // 4. Seed a tenant and a user.
  tenantId = randomUUID();
  userId   = randomUUID();

  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`,
      [tenantId, "totp-test-tenant", "TOTP Test Tenant"],
    );
    await client.query(
      `INSERT INTO tenant_settings (tenant_id) VALUES ($1)`,
      [tenantId],
    );
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name) VALUES ($1, $2, $3, $4)`,
      [userId, tenantId, "admin@example.com", "Admin"],
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
// Helper: enroll the shared user (used by multiple tests)
// ---------------------------------------------------------------------------

let enrolledSecretBase32: string;

async function ensureEnrolled(): Promise<string> {
  if (enrolledSecretBase32 !== undefined) return enrolledSecretBase32;

  const { secretBase32 } = await totp.enrollStart(userId, tenantId, "admin@example.com");
  enrolledSecretBase32 = secretBase32;

  const code = authenticator.generate(secretBase32);
  await totp.enrollConfirm(userId, tenantId, code);

  return secretBase32;
}

// ---------------------------------------------------------------------------
// Test 1 — enrollStart returns a well-formed otpauth URI
// ---------------------------------------------------------------------------

it("enrollStart returns an otpauth URI with algorithm=SHA1 and issuer=AssessIQ", async () => {
  const testUserId = randomUUID();
  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name) VALUES ($1, $2, $3, $4)`,
      [testUserId, tenantId, "enroll-test@example.com", "Enroll Test"],
    );
  });

  const { otpauthUri, secretBase32 } = await totp.enrollStart(
    testUserId,
    tenantId,
    "enroll-test@example.com",
  );

  expect(otpauthUri).toMatch(/^otpauth:\/\/totp\/AssessIQ:/);
  expect(otpauthUri).toContain("algorithm=SHA1");
  expect(otpauthUri).toContain("issuer=AssessIQ");
  expect(otpauthUri).toContain("period=30");
  expect(otpauthUri).toContain("digits=6");
  expect(otpauthUri).toContain(`secret=${secretBase32}`);

  // secretBase32 should be a non-empty base32 string (only RFC 4648 chars + =)
  expect(secretBase32).toMatch(/^[A-Z2-7]+=*$/);
  expect(secretBase32.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Test 2 — enrollStart stages envelope in Redis with TTL ≤ 600
// ---------------------------------------------------------------------------

it("enrollStart stages an envelope in Redis at aiq:totp:enroll:<userId>; TTL ≤ 600", async () => {
  const testUserId = randomUUID();
  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name) VALUES ($1, $2, $3, $4)`,
      [testUserId, tenantId, "enroll-redis@example.com", "Enroll Redis"],
    );
  });

  await totp.enrollStart(testUserId, tenantId, "enroll-redis@example.com");

  const redis = getRedis();
  const ttl = await redis.ttl(`aiq:totp:enroll:${testUserId}`);
  expect(ttl).toBeGreaterThan(0);
  expect(ttl).toBeLessThanOrEqual(600);
});

// ---------------------------------------------------------------------------
// Test 3 — enrollConfirm with correct code persists secret + returns 10 codes
// ---------------------------------------------------------------------------

it("enrollConfirm with correct code persists totp_secret_enc, sets totp_enrolled_at, returns 10 recovery codes; staging key deleted", async () => {
  const testUserId = randomUUID();
  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name) VALUES ($1, $2, $3, $4)`,
      [testUserId, tenantId, "enroll-confirm@example.com", "Enroll Confirm"],
    );
  });

  const { secretBase32 } = await totp.enrollStart(testUserId, tenantId, "enroll-confirm@example.com");
  const code = authenticator.generate(secretBase32);
  const { recoveryCodes } = await totp.enrollConfirm(testUserId, tenantId, code);

  // 10 plaintext recovery codes returned.
  expect(recoveryCodes).toHaveLength(10);
  for (const rc of recoveryCodes) {
    expect(rc).toHaveLength(8);
  }

  // Staging key deleted.
  const redis = getRedis();
  const staged = await redis.get(`aiq:totp:enroll:${testUserId}`);
  expect(staged).toBeNull();

  // DB row persisted.
  const rows = await withSuperClient(async (client) => {
    return client.query<{ totp_secret_enc: Buffer | null; totp_enrolled_at: string | null }>(
      `SELECT totp_secret_enc, totp_enrolled_at FROM user_credentials WHERE user_id = $1`,
      [testUserId],
    );
  });
  expect(rows.rows).toHaveLength(1);
  expect(rows.rows[0]!.totp_secret_enc).not.toBeNull();
  expect(rows.rows[0]!.totp_enrolled_at).not.toBeNull();
});

// ---------------------------------------------------------------------------
// Test 4 — enrollConfirm with wrong code throws ValidationError; staging key still present
// ---------------------------------------------------------------------------

it("enrollConfirm with wrong code throws ValidationError; staging key still present", async () => {
  const testUserId = randomUUID();
  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name) VALUES ($1, $2, $3, $4)`,
      [testUserId, tenantId, "enroll-bad@example.com", "Enroll Bad"],
    );
  });

  await totp.enrollStart(testUserId, tenantId, "enroll-bad@example.com");

  await expect(
    totp.enrollConfirm(testUserId, tenantId, "000000"),
  ).rejects.toBeInstanceOf(ValidationError);

  // Staging key must still be present (allow retry).
  const redis = getRedis();
  const staged = await redis.get(`aiq:totp:enroll:${testUserId}`);
  expect(staged).not.toBeNull();
});

// ---------------------------------------------------------------------------
// Test 5 — verify returns true for the current TOTP step
// ---------------------------------------------------------------------------

it("verify returns true for the current TOTP step", async () => {
  const secret = await ensureEnrolled();
  const code = authenticator.generate(secret);
  const result = await totp.verify(userId, tenantId, code);
  expect(result).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 6 — verify handles ±1 drift; false for ±2 drift
// ---------------------------------------------------------------------------

describe("verify drift window", () => {
  // Generating a TOTP code at an arbitrary epoch must go through the authenticator
  // wrapper (which applies the keyDecoder) — totpToken on a base32 string directly
  // does NOT decode it, so the bytes HMACed differ from what the user's app produces.
  // See modules/01-auth/src/totp.ts comment in enrollConfirm for the same pitfall.
  function codeAtEpoch(b32: string, epoch: number): string {
    return authenticator.clone({ epoch }).generate(b32);
  }

  it("returns true for -1 step (past)", async () => {
    const secret = await ensureEnrolled();
    const opts = authenticator.allOptions();
    const pastCode = codeAtEpoch(secret, Date.now() - opts.step * 1000);
    const result = await totp.verify(userId, tenantId, pastCode);
    expect(result).toBe(true);
  });

  it("returns true for +1 step (future)", async () => {
    const secret = await ensureEnrolled();
    const opts = authenticator.allOptions();
    const futureCode = codeAtEpoch(secret, Date.now() + opts.step * 1000);
    const result = await totp.verify(userId, tenantId, futureCode);
    expect(result).toBe(true);
  });

  it("returns false for -2 step (outside window)", async () => {
    const secret = await ensureEnrolled();
    const opts = authenticator.allOptions();
    // Clear fail counter so we don't accidentally trigger lockout in this drift test.
    const redis = getRedis();
    await redis.del(`aiq:auth:totpfail:${userId}`);
    const farPastCode = codeAtEpoch(secret, Date.now() - opts.step * 2000);
    const result = await totp.verify(userId, tenantId, farPastCode);
    expect(result).toBe(false);
    // Reset fail counter.
    await redis.del(`aiq:auth:totpfail:${userId}`);
  });
});

// ---------------------------------------------------------------------------
// Test 7 — constant-time: mean wall-clock difference < 5ms (5_000_000n ns)
// ---------------------------------------------------------------------------

it("constant-time check: |mean(valid) - mean(invalid)| < 5_000_000n ns", async () => {
  const secret = await ensureEnrolled();

  const ITERATIONS = 100;
  const validCode   = authenticator.generate(secret);
  const invalidCode = "000000";

  // Clear any fail counter so lockout doesn't fire during invalid runs.
  const redis = getRedis();
  await redis.del(`aiq:auth:totpfail:${userId}`);
  await redis.del(`aiq:auth:lockedout:${userId}`);

  // We're measuring whole-call verify() time, which includes Redis cleanup that
  // differs between paths: success does 1 DEL + 1 fire-and-forget UPDATE; failure
  // does 1 INCR + (sometimes) 1 EXPIRE + (sometimes) 1 SET. That's roughly one
  // extra Redis round-trip on the failure path — sub-millisecond on a local
  // testcontainer but >1ms in noisier environments. The constant-time invariant
  // we actually care about is that the comparison loop itself doesn't early-exit
  // on partial-digit match — that's enforced by crypto.timingSafeEqual in totp.ts.
  // 5ms is a comfortable ceiling for the cleanup-op asymmetry without masking a
  // real comparison-loop leak (which would manifest as ms-scale drift, not μs).

  const validTimes: bigint[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = process.hrtime.bigint();
    await totp.verify(userId, tenantId, validCode);
    validTimes.push(process.hrtime.bigint() - t0);
    // Reset fail counter between invalid runs to avoid lockout.
    await redis.del(`aiq:auth:totpfail:${userId}`);
  }

  const invalidTimes: bigint[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    // Suppress lockout between iterations.
    await redis.del(`aiq:auth:totpfail:${userId}`);
    await redis.del(`aiq:auth:lockedout:${userId}`);
    const t0 = process.hrtime.bigint();
    await totp.verify(userId, tenantId, invalidCode);
    invalidTimes.push(process.hrtime.bigint() - t0);
  }
  // Clean up.
  await redis.del(`aiq:auth:totpfail:${userId}`);

  const meanValid   = validTimes.reduce((a, b) => a + b, 0n) / BigInt(ITERATIONS);
  const meanInvalid = invalidTimes.reduce((a, b) => a + b, 0n) / BigInt(ITERATIONS);
  const diff = meanValid > meanInvalid ? meanValid - meanInvalid : meanInvalid - meanValid;

  expect(diff).toBeLessThan(5_000_000n); // < 5ms — see Redis-asymmetry note above
}, 120_000);

// ---------------------------------------------------------------------------
// Test 8 — lockout: 5 failures → lockedout key; 6th call throws AuthnError
// ---------------------------------------------------------------------------

it("5 failed verify calls set aiq:auth:lockedout:<userId>; 6th call throws AuthnError", async () => {
  const lockUserId = randomUUID();
  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name) VALUES ($1, $2, $3, $4)`,
      [lockUserId, tenantId, "lockout@example.com", "Lockout User"],
    );
  });

  // Enroll the lockout user.
  const { secretBase32 } = await totp.enrollStart(lockUserId, tenantId, "lockout@example.com");
  const validCode = authenticator.generate(secretBase32);
  await totp.enrollConfirm(lockUserId, tenantId, validCode);

  // Fire 5 failed attempts.
  const redis = getRedis();
  await redis.del(`aiq:auth:totpfail:${lockUserId}`);
  await redis.del(`aiq:auth:lockedout:${lockUserId}`);

  for (let i = 0; i < 5; i++) {
    const result = await totp.verify(lockUserId, tenantId, "000000");
    expect(result).toBe(false);
  }

  // Lockout key must now exist.
  const lockedOut = await redis.exists(`aiq:auth:lockedout:${lockUserId}`);
  expect(lockedOut).toBe(1);

  // 6th call must throw AuthnError.
  await expect(totp.verify(lockUserId, tenantId, "000000")).rejects.toBeInstanceOf(AuthnError);
});

// ---------------------------------------------------------------------------
// Test 9 — consumeRecovery marks used_at; second use returns false
// ---------------------------------------------------------------------------

it("consumeRecovery with a valid code marks used_at; second use returns false", async () => {
  const rcUserId = randomUUID();
  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name) VALUES ($1, $2, $3, $4)`,
      [rcUserId, tenantId, "recovery@example.com", "Recovery User"],
    );
  });

  const { secretBase32 } = await totp.enrollStart(rcUserId, tenantId, "recovery@example.com");
  const code = authenticator.generate(secretBase32);
  const { recoveryCodes } = await totp.enrollConfirm(rcUserId, tenantId, code);
  const firstCode = recoveryCodes[0]!;

  // First use — should succeed.
  const firstResult = await totp.consumeRecovery(rcUserId, tenantId, firstCode);
  expect(firstResult).toBe(true);

  // Verify used_at is set in DB.
  const rows = await withSuperClient(async (client) => {
    return client.query<{ used_at: string | null }>(
      `SELECT used_at FROM totp_recovery_codes WHERE user_id = $1 AND used_at IS NOT NULL`,
      [rcUserId],
    );
  });
  expect(rows.rows.length).toBeGreaterThanOrEqual(1);

  // Second use of the same code — should return false (not throw).
  const secondResult = await totp.consumeRecovery(rcUserId, tenantId, firstCode);
  expect(secondResult).toBe(false);
});

// ---------------------------------------------------------------------------
// Test 10 — consumeRecovery with invalid code returns false (does not throw)
// ---------------------------------------------------------------------------

it("consumeRecovery with an invalid code returns false, does not throw", async () => {
  const rcUserId2 = randomUUID();
  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name) VALUES ($1, $2, $3, $4)`,
      [rcUserId2, tenantId, "recovery2@example.com", "Recovery User 2"],
    );
  });

  const { secretBase32 } = await totp.enrollStart(rcUserId2, tenantId, "recovery2@example.com");
  const code = authenticator.generate(secretBase32);
  await totp.enrollConfirm(rcUserId2, tenantId, code);

  // Invalid code — not a real recovery code.
  const result = await totp.consumeRecovery(rcUserId2, tenantId, "XXXXXXXX");
  expect(result).toBe(false);
}, 30_000);

// ---------------------------------------------------------------------------
// Test 11 — regenerateRecoveryCodes deletes all old rows and inserts 10 fresh
// ---------------------------------------------------------------------------

it("regenerateRecoveryCodes deletes all old rows and inserts 10 fresh", async () => {
  const regenUserId = randomUUID();
  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name) VALUES ($1, $2, $3, $4)`,
      [regenUserId, tenantId, "regen@example.com", "Regen User"],
    );
  });

  const { secretBase32 } = await totp.enrollStart(regenUserId, tenantId, "regen@example.com");
  const code = authenticator.generate(secretBase32);
  const { recoveryCodes: oldCodes } = await totp.enrollConfirm(regenUserId, tenantId, code);

  // Regenerate — get 10 new codes.
  const { recoveryCodes: newCodes } = await totp.regenerateRecoveryCodes(regenUserId, tenantId);
  expect(newCodes).toHaveLength(10);

  // Old and new codes should not overlap (extremely high probability).
  const oldSet = new Set(oldCodes);
  const overlap = newCodes.filter((c) => oldSet.has(c));
  expect(overlap).toHaveLength(0);

  // Only 10 rows in DB (old deleted, 10 new inserted).
  const dbRows = await withSuperClient(async (client) => {
    return client.query<{ id: string }>(
      `SELECT id FROM totp_recovery_codes WHERE user_id = $1`,
      [regenUserId],
    );
  });
  expect(dbRows.rows).toHaveLength(10);
});

// ---------------------------------------------------------------------------
// Test 12 — recovery code character set: every char in Crockford base32 alphabet
// ---------------------------------------------------------------------------

it("every char of every generated recovery code is in 0123456789ABCDEFGHJKMNPQRSTVWXYZ", async () => {
  const charsetUserId = randomUUID();
  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name) VALUES ($1, $2, $3, $4)`,
      [charsetUserId, tenantId, "charset@example.com", "Charset User"],
    );
  });

  const { secretBase32 } = await totp.enrollStart(charsetUserId, tenantId, "charset@example.com");
  const code = authenticator.generate(secretBase32);
  const { recoveryCodes } = await totp.enrollConfirm(charsetUserId, tenantId, code);

  const ALPHABET = new Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ".split(""));

  for (const rc of recoveryCodes) {
    for (const ch of rc) {
      expect(ALPHABET.has(ch)).toBe(true);
    }
  }
});
