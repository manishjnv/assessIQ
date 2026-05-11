/**
 * embed-jwt-db.test.ts — DB-backed integration tests for the embed JWT
 * verification + session-minting path.
 *
 * Spins up ephemeral postgres:16-alpine + redis:7-alpine via testcontainers.
 * Each test that writes state uses a fresh tenant so tests are fully isolated.
 *
 * Migration sequence applied in beforeAll:
 *   1. 02-tenancy/0001_tenants.sql       — tenants table + pgcrypto
 *   2. 02-tenancy/0002_rls_helpers.sql   — assessiq_app/system roles + GRANTS
 *   3. 02-tenancy/0003_tenants_rls.sql   — RLS on tenants
 *   4. 03-users/020_users.sql            — users table (real schema)
 *   5. 01-auth/011_sessions.sql          — sessions table
 *   6. 01-auth/014_embed_secrets.sql     — embed_secrets table
 *   7. 12-embed-sdk/0071_tenants_embed_metadata.sql — session_type col
 *
 * Cases covered (reference: task brief §"Test coverage to ship"):
 *   T1.  Valid JWT → verifyEmbedToken + mintEmbedSession (happy path)
 *   T2.  Wrong secret → AuthnError
 *   T6.  Nonexistent tenant_id → AuthnError
 *   T7.  Cross-tenant JWT forge → AuthnError  ← headline security test
 *   T8.  Replay attack (same JWT twice) → AuthnError
 *   T12. 100 KB assessment_id claim (gap: no size limit in verifyEmbedToken)
 *   T13. Cyrillic homograph in tenant_id → AuthnError
 *
 * Bugs flagged (not fixed):
 *   BUG-A: jit-user.ts references columns password_hash + email_verified that
 *          do not exist in the users table (020_users.sql). resolveJitUser will
 *          throw on any INSERT. Test T1 inserts the user directly to demonstrate
 *          the core path works; the JIT path is flagged in the report.
 *
 * INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any AI SDK.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as jose from 'jose';

import { setPoolForTesting, closePool } from '@assessiq/tenancy';
import {
  setRedisForTesting,
  closeRedis,
  verifyEmbedToken,
  createEmbedSecret,
  mintEmbedToken,
} from '@assessiq/auth';
import { AuthnError } from '@assessiq/core';
import { mintEmbedSession } from '../session-mint.js';

// ─── Path helpers ─────────────────────────────────────────────────────────────

/**
 * On Windows, import.meta.url gives a path like /C:/foo/bar. Strip the leading
 * slash before the drive letter so join() works correctly.
 */
function stripWindowsDriveLead(p: string): string {
  return p.replace(/^\/([A-Za-z]:)/, '$1');
}

const THIS_DIR = stripWindowsDriveLead(new URL('.', import.meta.url).pathname);

// modules/12-embed-sdk/src/__tests__ → repo root: 4 levels up
const REPO_ROOT = join(THIS_DIR, '..', '..', '..', '..');

const TENANCY_MIGRATIONS = join(REPO_ROOT, 'modules', '02-tenancy', 'migrations');
const USERS_MIGRATIONS   = join(REPO_ROOT, 'modules', '03-users',   'migrations');
const AUTH_MIGRATIONS    = join(REPO_ROOT, 'modules', '01-auth',    'migrations');
// modules/12-embed-sdk/src/__tests__ → migrations: 2 levels up
const EMBED_SDK_MIGRATIONS = join(THIS_DIR, '..', '..', 'migrations');

// ─── Container state ──────────────────────────────────────────────────────────

let pgContainer:    StartedTestContainer;
let redisContainer: StartedTestContainer;
let pgUrl:          string;
let redisUrl:       string;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Run fn with a direct superuser connection (bypasses RLS). */
async function withSuperClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: pgUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Insert a tenant row and return its id. */
async function createTenant(): Promise<string> {
  const id   = randomUUID();
  const slug = `t-${id.slice(0, 8)}`;
  await withSuperClient((c) =>
    c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`, [
      id,
      slug,
      `Test Tenant ${slug}`,
    ]),
  );
  return id;
}

/**
 * Insert a candidate user row for the given tenant.
 * NOTE: inserts using the REAL users schema (020_users.sql) which does NOT have
 * password_hash or email_verified columns.  Do NOT use resolveJitUser() here —
 * see BUG-A in the file header.
 */
async function createUser(tenantId: string): Promise<string> {
  const userId = randomUUID();
  const email  = `user-${userId.slice(0, 8)}@embed.test`;
  await withSuperClient((c) =>
    c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, 'Embed Test User', 'candidate', 'active', '{}'::jsonb, now(), now())`,
      [userId, tenantId, email],
    ),
  );
  return userId;
}

/**
 * Manually sign a JWT with a raw base64url secret (Buffer.from(secret, 'base64url')).
 * Use when you need to control the key independently of what is stored in the DB.
 */
async function signWithRawSecret(
  secret: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const key = Buffer.from(secret, 'base64url');
  return new jose.SignJWT(payload as jose.JWTPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .sign(key);
}

/** Return a valid, non-expired base payload for a given tenant. */
function basePayload(tenantId: string, assessmentId = randomUUID()): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'test-host-app',
    aud: 'assessiq',
    sub: `host-user-${randomUUID().slice(0, 8)}`,
    tenant_id: tenantId,
    email: `candidate-${randomUUID().slice(0, 8)}@embed.test`,
    name: 'Embed Test Candidate',
    assessment_id: assessmentId,
    iat: now,
    exp: now + 300,
    jti: randomUUID(),
  };
}

// ─── Global setup / teardown ─────────────────────────────────────────────────

beforeAll(async () => {
  // Start postgres + redis containers in parallel.
  [pgContainer, redisContainer] = await Promise.all([
    new GenericContainer('postgres:16-alpine')
      .withEnvironment({
        POSTGRES_USER:     'test',
        POSTGRES_PASSWORD: 'test',
        POSTGRES_DB:       'aiq_test',
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .withStartupTimeout(60_000)
      .start(),
    new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .withStartupTimeout(60_000)
      .start(),
  ]);

  pgUrl    = `postgres://test:test@${pgContainer.getHost()}:${pgContainer.getMappedPort(5432)}/aiq_test`;
  redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

  // Apply migrations in dependency order.
  await withSuperClient(async (c) => {
    for (const file of [
      '0001_tenants.sql',
      '0002_rls_helpers.sql',
      '0003_tenants_rls.sql',
    ]) {
      const sql = await readFile(join(TENANCY_MIGRATIONS, file), 'utf-8');
      await c.query(sql);
    }
  });

  // Real users schema (no password_hash / email_verified).
  await withSuperClient(async (c) => {
    const sql = await readFile(join(USERS_MIGRATIONS, '020_users.sql'), 'utf-8');
    await c.query(sql);
  });

  // Sessions + embed_secrets.
  await withSuperClient(async (c) => {
    for (const file of ['011_sessions.sql', '014_embed_secrets.sql']) {
      const sql = await readFile(join(AUTH_MIGRATIONS, file), 'utf-8');
      await c.query(sql);
    }
  });

  // session_type column on sessions (D6) + privacy_disclosed on tenants (D13).
  await withSuperClient(async (c) => {
    const sql = await readFile(
      join(EMBED_SDK_MIGRATIONS, '0071_tenants_embed_metadata.sql'),
      'utf-8',
    );
    await c.query(sql);
  });

  // Wire the module singletons to the testcontainers instances.
  await setPoolForTesting(pgUrl);
  await setRedisForTesting(redisUrl);
}, 120_000);

afterAll(async () => {
  await closeRedis();
  await closePool();
  await Promise.all([
    pgContainer?.stop(),
    redisContainer?.stop(),
  ]);
});

// ─── T4: Future-dated iat → AuthnError (DB-backed genuine regression guard) ──

describe('T4: JWT with future-dated iat (clock-skew attack)', () => {
  /**
   * Uses a REAL tenant + embed_secret so that the JWT signature would pass if
   * not for the iat-future-skew check.  This makes the test a genuine regression
   * guard: if the iat check is removed from verifyEmbedToken, this test goes RED
   * (the JWT is accepted rather than rejected) instead of staying green due to
   * a DB fallback error.
   */
  it('T4: JWT with iat 60s in the future is rejected even when signature is valid', async () => {
    const tenantId = await createTenant();
    const { plaintextSecret } = await createEmbedSecret(tenantId, 'iat-guard-key');

    const now = Math.floor(Date.now() / 1000);
    // iat = now + 60: exceeds the ±5s clock-skew tolerance.
    // exp = now + 360: not expired.
    // exp - iat = 300: within the 600s lifetime cap (so that check does NOT fire first).
    const token = await signWithRawSecret(plaintextSecret, {
      iss: 'test',
      aud: 'assessiq',
      sub: 'usr-iat-test',
      tenant_id: tenantId,
      email: 'iat@embed.test',
      name: 'IAT Test',
      assessment_id: randomUUID(),
      iat: now + 60,   // 60s future — well past the ±5s allowed skew
      exp: now + 360,  // not expired; valid sig; only the iat check stops this
      jti: randomUUID(),
    });

    // Must be rejected by the iat-future-skew check, NOT by DB or signature failure.
    await expect(verifyEmbedToken(token)).rejects.toBeInstanceOf(AuthnError);
  });
});

// ─── T1: Happy path — valid JWT → verifyEmbedToken + mintEmbedSession ────────

describe('T1: valid JWT → verifyEmbedToken succeeds + mintEmbedSession mints session', () => {
  it('T1: minted session has a non-empty token, positive maxAge, correct tenantId', async () => {
    const tenantId = await createTenant();
    await createEmbedSecret(tenantId, 'test-key');
    const userId = await createUser(tenantId);

    // mintEmbedToken uses the DB-stored secret internally → real JWT.
    // Explicitly request 300s TTL so the maxAge assertion below is tight.
    const token = await mintEmbedToken(
      {
        iss: 'test-host',
        sub: userId,
        tenant_id: tenantId,
        email: 't1@embed.test',
        name: 'T1 User',
        assessment_id: randomUUID(),
      },
      { ttlSeconds: 300 },
    );

    // 1. Verify the JWT — must succeed and surface tenant_id.
    const verified = await verifyEmbedToken(token);
    expect(verified.tenantId).toBe(tenantId);
    expect(verified.payload.sub).toBe(userId);

    // 2. Mint an embed session using the verified payload.
    const sessionResult = await mintEmbedSession({
      userId,
      tenantId,
      jwtExp: verified.payload.exp,
      ip: '127.0.0.1',
      ua: 'vitest/integration',
    });

    expect(sessionResult.token).toBeTruthy();
    expect(sessionResult.maxAge).toBeGreaterThan(0);
    // maxAge must not exceed the JWT's remaining lifetime (≤ 300s at mint time).
    expect(sessionResult.maxAge).toBeLessThanOrEqual(300);

    // 3. Verify the session row was marked as 'embed' in Postgres.
    const rows = await withSuperClient((c) =>
      c.query<{ session_type: string }>(
        `SELECT session_type FROM sessions WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [tenantId],
      ),
    );
    expect(rows.rows[0]?.session_type).toBe('embed');
  });
});

// ─── T2: Wrong secret → AuthnError ──────────────────────────────────────────

describe('T2: JWT signed with wrong secret → AuthnError', () => {
  it('T2: a JWT signed with a random secret (not the tenant\'s embed_secret) is rejected', async () => {
    const tenantId = await createTenant();
    // Create the tenant's real secret (stored in DB but NOT used for signing below).
    await createEmbedSecret(tenantId, 'real-key');

    // Sign with a completely different random secret that is never stored for this tenant.
    const wrongSecret = Buffer.alloc(32, 0xff).toString('base64url');
    const token = await signWithRawSecret(wrongSecret, basePayload(tenantId));

    // verifyEmbedToken must load the real secret from the DB, fail signature
    // verification, check rotated fallback (none), and throw.
    await expect(verifyEmbedToken(token)).rejects.toBeInstanceOf(AuthnError);
  });
});

// ─── T6: Nonexistent tenant_id → AuthnError ─────────────────────────────────

describe('T6: JWT with nonexistent tenant_id → AuthnError', () => {
  it('T6: a syntactically valid UUID that exists in no tenant row returns AuthnError', async () => {
    // This UUID is crafted to be syntactically valid but will never appear
    // in the tenants table.
    const ghostTenantId = '019d8000-0001-7f00-8000-deadbeefffff';
    const anySecret = Buffer.alloc(32, 0xcd).toString('base64url');
    const token = await signWithRawSecret(anySecret, basePayload(ghostTenantId));

    // withTenant sets app.current_tenant = ghostTenantId; the embed_secrets
    // SELECT returns 0 rows (no tenant, so no secret row) → AuthnError.
    await expect(verifyEmbedToken(token)).rejects.toBeInstanceOf(AuthnError);
  });
});

// ─── T7: Cross-tenant forge → AuthnError (headline security test) ───────────

describe('T7: cross-tenant JWT forge → AuthnError', () => {
  it('T7: JWT with tenant_id=A signed with tenant B\'s secret is rejected', async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();

    // Give each tenant its own embed secret.
    await createEmbedSecret(tenantA, 'secret-A');
    const { plaintextSecret: secretB } = await createEmbedSecret(tenantB, 'secret-B');

    // Forge: craft a JWT that CLAIMS to be for tenant A but is signed with B's secret.
    // An attacker who controls tenant B cannot impersonate tenant A this way.
    const forgedToken = await signWithRawSecret(
      secretB,
      basePayload(tenantA), // tenant_id points to A
    );

    // verifyEmbedToken: looks up tenant A's active secret (not B's),
    // signature verification fails → falls back to rotated (none) → AuthnError.
    await expect(verifyEmbedToken(forgedToken)).rejects.toBeInstanceOf(AuthnError);
  });
});

// ─── T8: Replay attack → AuthnError ─────────────────────────────────────────

describe('T8: replay attack — same JWT submitted twice → AuthnError', () => {
  it('T8: second submission of the same valid JWT is rejected by the JTI replay cache', async () => {
    const tenantId = await createTenant();
    await createEmbedSecret(tenantId, 'replay-key');

    const token = await mintEmbedToken({
      iss: 'test-host',
      sub: 'user-replay',
      tenant_id: tenantId,
      email: 'replay@embed.test',
      name: 'Replay User',
      assessment_id: randomUUID(),
    });

    // First verify: must succeed — JTI stored in Redis with NX.
    const first = await verifyEmbedToken(token);
    expect(first.tenantId).toBe(tenantId);

    // Second verify of the SAME token: JTI already in cache → SET NX returns null → AuthnError.
    await expect(verifyEmbedToken(token)).rejects.toBeInstanceOf(AuthnError);
  });
});

// ─── T12: Massive payload (gap: no size limit in verifyEmbedToken) ───────────

describe('T12: JWT with 100 KB assessment_id claim', () => {
  /**
   * REGRESSION GAP: verifyEmbedToken has no payload size validation.
   * A JWT with a 100 KB assessment_id is accepted if the signature is valid.
   * DoS protection is assumed to be at the HTTP body-size layer (Fastify) rather
   * than the JWT verification function itself.
   *
   * This test documents the current behaviour.  If a size check is added in
   * future, update the expectation from "resolves" to "rejects".
   */
  it('T12: 100 KB assessment_id is accepted (no AuthnError — no size guard in verifyEmbedToken)', async () => {
    const tenantId = await createTenant();
    const { plaintextSecret } = await createEmbedSecret(tenantId, 'big-payload-key');

    const largeAssessmentId = 'x'.repeat(100_000); // 100 KB of ASCII
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: 'test-host',
      aud: 'assessiq',
      sub: 'user-large',
      tenant_id: tenantId,
      email: 'large@embed.test',
      name: 'Large Payload User',
      assessment_id: largeAssessmentId,
      iat: now,
      exp: now + 300,
      jti: randomUUID(),
    };

    // Sign with the real tenant secret so signature verification passes.
    const token = await signWithRawSecret(plaintextSecret, payload);

    // The token IS accepted — no size limit in the impl.
    // FLAG: add a payload size cap (e.g. 8 KB) to verifyEmbedToken to close
    // this gap. Ref: embed-jwt.ts step 1 (jose.decodeJwt) does not size-check.
    const result = await verifyEmbedToken(token);
    expect(result.tenantId).toBe(tenantId);
    expect(result.payload.assessment_id).toHaveLength(100_000);
  });
});

// ─── T13: Unicode / Cyrillic homograph in tenant_id → AuthnError ─────────────

describe('T13: Unicode homograph attack — Cyrillic chars in tenant_id', () => {
  it('T13: a tenant_id containing Cyrillic lookalikes is rejected', async () => {
    // Craft a UUID-like string where some hex characters are replaced with
    // visually identical Cyrillic codepoints:
    //   'а' (U+0430, Cyrillic small а) ≈ 'a' (U+0061, Latin a)
    //   'е' (U+0435, Cyrillic small е) ≈ 'e' (U+0065, Latin e)
    // Result passes typeof === 'string' check but is not a valid UUID.
    const cyrillicTenantId =
      '019d8000-0001-7f00-8000-d\u0435\u0430db\u0435\u0435ffff'; // Cyrillic е, а

    const anySecret = Buffer.alloc(32, 0xaa).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const token = await signWithRawSecret(anySecret, {
      iss: 'attacker',
      aud: 'assessiq',
      sub: 'attacker-sub',
      tenant_id: cyrillicTenantId,
      email: 'attacker@evil.test',
      name: 'Attacker',
      assessment_id: randomUUID(),
      iat: now,
      exp: now + 300,
      jti: randomUUID(),
    });

    // The impl: passes typeof string check, passes numeric iat/exp checks,
    // then calls withTenant(cyrillicTenantId) which executes a Postgres query
    // with RLS policy `current_setting('app.current_tenant', true)::uuid`.
    // PostgreSQL's ::uuid cast rejects the Cyrillic string → DB error →
    // caught by outer catch → re-thrown as AuthnError.
    await expect(verifyEmbedToken(token)).rejects.toBeInstanceOf(AuthnError);
  });
});
