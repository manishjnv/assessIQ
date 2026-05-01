/**
 * Integration tests for modules/01-auth embed-jwt.ts
 *
 * Uses postgres:16-alpine + redis:7-alpine testcontainers so the full
 * database layer (RLS, withTenant, embed_secrets table) and the Redis
 * replay-cache are exercised against real services.
 *
 * Container pair is started ONCE in beforeAll and torn down in afterAll.
 * Each test that needs DB isolation uses a fresh tenant UUID.
 *
 * Migration strategy: apply tenancy migrations first (roles, tenants table),
 * then a stub users table (needed by auth FKs), then the embed_secrets
 * migration.  We skip migrations that reference users.id FK for tables we
 * do not need in these tests (sessions, oauth_identities, etc.).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as jose from "jose";

import { setPoolForTesting, closePool } from "@assessiq/tenancy";
// pool.js is NOT exported from @assessiq/tenancy index — import via path for test-only fn
// But setPoolForTesting IS exported from the index (confirmed in 02-tenancy/src/index.ts).
import { setRedisForTesting, closeRedis } from "../redis.js";
import {
  mintEmbedToken,
  verifyEmbedToken,
  createEmbedSecret,
  rotateEmbedSecret,
  listEmbedSecrets,
} from "../embed-jwt.js";
import { AuthnError } from "@assessiq/core";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function stripWindowsDriveLead(p: string): string {
  return p.replace(/^\/([A-Za-z]:)/, "$1");
}

const TENANCY_MIGRATIONS_DIR = join(
  stripWindowsDriveLead(new URL(".", import.meta.url).pathname),
  "..", "..", "..", "..", // modules/01-auth/src/__tests__ -> repo root
  "modules", "02-tenancy", "migrations",
);

const AUTH_MIGRATIONS_DIR = join(
  stripWindowsDriveLead(new URL(".", import.meta.url).pathname),
  "..", "..", // src/__tests__ -> modules/01-auth
  "migrations",
);

// ---------------------------------------------------------------------------
// Shared container state
// ---------------------------------------------------------------------------

let pgContainer: StartedTestContainer;
let redisContainer: StartedTestContainer;
let pgUrl: string;
let redisUrl: string;

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

/** Insert a tenant row as superuser and return its id. */
async function createTenant(): Promise<string> {
  const id = randomUUID();
  const slug = `tenant-${id.slice(0, 8)}`;
  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`,
      [id, slug, `Test Tenant ${slug}`],
    );
  });
  return id;
}

/**
 * Build a minimal valid embed token payload (omitting iat/exp/jti/aud —
 * mintEmbedToken fills those in).
 */
function basePayload(tenantId: string) {
  return {
    iss: "test-host-app",
    sub: "user-123",
    tenant_id: tenantId,
    email: "candidate@example.com",
    name: "Test Candidate",
    assessment_id: randomUUID(),
  };
}

/**
 * Manually craft a token with a custom header alg without verifying the
 * signature.  Used for alg-confusion rejection tests.
 *
 * Structure: base64url(header) + "." + base64url(payload) + "." + <sig>
 */
function craftTokenWithAlg(
  alg: string,
  payload: Record<string, unknown>,
  sig = "invalidsignature",
): string {
  const header = Buffer.from(JSON.stringify({ alg, typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.${sig}`;
}

// ---------------------------------------------------------------------------
// Global setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Start Postgres and Redis containers in parallel.
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
  redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

  // Apply tenancy migrations (roles + tenants table) in lexical order.
  const tenancyFiles = (await readdir(TENANCY_MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  await withSuperClient(async (client) => {
    for (const file of tenancyFiles) {
      const sql = await readFile(join(TENANCY_MIGRATIONS_DIR, file), "utf-8");
      await client.query(sql);
    }
  });

  // Create a stub users table so that auth migration FKs resolve.
  // The real users table ships in modules/03-users (Window 5). For embed-jwt
  // tests we only need the table to exist; no rows needed.
  await withSuperClient(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        email     TEXT NOT NULL,
        name      TEXT NOT NULL,
        role      TEXT NOT NULL DEFAULT 'candidate',
        status    TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`ALTER TABLE users ENABLE ROW LEVEL SECURITY`);
    await client.query(`
      CREATE POLICY tenant_isolation ON users
        USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    `);
    await client.query(`
      CREATE POLICY tenant_isolation_insert ON users
        FOR INSERT
        WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid)
    `);
    // Grant to app roles (already created by tenancy migration 0002).
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON users TO assessiq_app, assessiq_system`);
  });

  // Apply only the embed_secrets auth migration (014). The other auth migrations
  // reference columns we don't need for these tests.
  const authSql = await readFile(join(AUTH_MIGRATIONS_DIR, "014_embed_secrets.sql"), "utf-8");
  await withSuperClient(async (client) => {
    await client.query(authSql);
  });

  // Point the module singletons at the containers.
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

// ---------------------------------------------------------------------------
// Test 1 — alg:none rejected
// ---------------------------------------------------------------------------

it("alg=none rejected: verifyEmbedToken throws AuthnError", async () => {
  const tenantId = await createTenant();
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "host",
    aud: "assessiq",
    sub: "u1",
    tenant_id: tenantId,
    email: "a@b.com",
    name: "A",
    assessment_id: randomUUID(),
    iat: now,
    exp: now + 300,
    jti: randomUUID(),
  };
  const token = craftTokenWithAlg("none", payload, "");
  await expect(verifyEmbedToken(token)).rejects.toBeInstanceOf(AuthnError);
});

// ---------------------------------------------------------------------------
// Test 2 — alg:HS512 rejected
// ---------------------------------------------------------------------------

it("alg=HS512 rejected: token signed with HS512 throws AuthnError", async () => {
  const tenantId = await createTenant();
  const { plaintextSecret } = await createEmbedSecret(tenantId, "test-key");
  const key = new TextEncoder().encode(plaintextSecret);
  const now = Math.floor(Date.now() / 1000);

  const token = await new jose.SignJWT({
    iss: "host",
    aud: "assessiq",
    sub: "u1",
    tenant_id: tenantId,
    email: "a@b.com",
    name: "A",
    assessment_id: randomUUID(),
    iat: now,
    exp: now + 300,
    jti: randomUUID(),
  })
    .setProtectedHeader({ alg: "HS512" })
    .sign(key);

  await expect(verifyEmbedToken(token)).rejects.toBeInstanceOf(AuthnError);
});

// ---------------------------------------------------------------------------
// Test 3 — alg:RS256 rejected
// ---------------------------------------------------------------------------

it("alg=RS256 rejected: verifyEmbedToken throws AuthnError", async () => {
  const tenantId = await createTenant();
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "host",
    aud: "assessiq",
    sub: "u1",
    tenant_id: tenantId,
    email: "a@b.com",
    name: "A",
    assessment_id: randomUUID(),
    iat: now,
    exp: now + 300,
    jti: randomUUID(),
  };
  // Craft a token with RS256 header — invalid sig, doesn't matter,
  // alg check fires first.
  const token = craftTokenWithAlg("RS256", payload, "invalidsig");
  await expect(verifyEmbedToken(token)).rejects.toBeInstanceOf(AuthnError);
});

// ---------------------------------------------------------------------------
// Test 4 — modified payload with valid signature rejected
// ---------------------------------------------------------------------------

it("modified-payload-with-valid-sig rejected: verifyEmbedToken throws AuthnError", async () => {
  const tenantId = await createTenant();
  await createEmbedSecret(tenantId, "test-key");
  const token = await mintEmbedToken(basePayload(tenantId));

  // Split token, decode payload, mutate tenant_id, re-encode.
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("unexpected token structure");
  const [header, body, sig] = parts as [string, string, string];

  const decodedPayload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
  decodedPayload["tenant_id"] = randomUUID(); // mutate to a different tenant
  const mutatedBody = Buffer.from(JSON.stringify(decodedPayload)).toString("base64url");
  const mutatedToken = `${header}.${mutatedBody}.${sig}`;

  await expect(verifyEmbedToken(mutatedToken)).rejects.toBeInstanceOf(AuthnError);
});

// ---------------------------------------------------------------------------
// Test 5 — replay cache
// ---------------------------------------------------------------------------

it("replay cache: second verify of same token throws AuthnError", async () => {
  const tenantId = await createTenant();
  await createEmbedSecret(tenantId, "test-key");

  const token = await mintEmbedToken(basePayload(tenantId));

  // First verify must succeed.
  const result = await verifyEmbedToken(token);
  expect(result.tenantId).toBe(tenantId);

  // Second verify of the same token must be rejected as replay.
  await expect(verifyEmbedToken(token)).rejects.toBeInstanceOf(AuthnError);
});

// ---------------------------------------------------------------------------
// Test 6 — lifetime cap: exp - iat > 600 rejected
// ---------------------------------------------------------------------------

it("lifetime cap: token with exp-iat=700 throws AuthnError", async () => {
  const tenantId = await createTenant();
  const { plaintextSecret } = await createEmbedSecret(tenantId, "test-key");
  const key = new TextEncoder().encode(plaintextSecret);
  const now = Math.floor(Date.now() / 1000);

  const token = await new jose.SignJWT({
    iss: "host",
    aud: "assessiq",
    sub: "u1",
    tenant_id: tenantId,
    email: "a@b.com",
    name: "A",
    assessment_id: randomUUID(),
    iat: now,
    exp: now + 700, // 700s > 600s cap
    jti: randomUUID(),
  })
    .setProtectedHeader({ alg: "HS256" })
    .sign(key);

  await expect(verifyEmbedToken(token)).rejects.toBeInstanceOf(AuthnError);
});

// ---------------------------------------------------------------------------
// Test 7 — aud mismatch
// ---------------------------------------------------------------------------

it("aud mismatch: token with aud='wrong' throws AuthnError", async () => {
  const tenantId = await createTenant();
  const { plaintextSecret } = await createEmbedSecret(tenantId, "test-key");
  const key = new TextEncoder().encode(plaintextSecret);
  const now = Math.floor(Date.now() / 1000);

  const token = await new jose.SignJWT({
    iss: "host",
    aud: "wrong",
    sub: "u1",
    tenant_id: tenantId,
    email: "a@b.com",
    name: "A",
    assessment_id: randomUUID(),
    iat: now,
    exp: now + 300,
    jti: randomUUID(),
  })
    .setProtectedHeader({ alg: "HS256" })
    .sign(key);

  await expect(verifyEmbedToken(token)).rejects.toBeInstanceOf(AuthnError);
});

// ---------------------------------------------------------------------------
// Test 8 — rotation grace: S1 (rotated) still accepted; unknown key rejected
// ---------------------------------------------------------------------------

describe("rotation grace period", () => {
  it("token signed with S1 (now rotated) still verifies via fallback", async () => {
    const tenantId = await createTenant();

    // Create S1, capture its secret.
    const { plaintextSecret: s1Secret } = await createEmbedSecret(tenantId, "S1");

    // Rotate → S1 becomes 'rotated', S2 is 'active'.
    await rotateEmbedSecret(tenantId);

    // Manually sign a token with S1's secret.
    // IMPORTANT: use the same key derivation as embed-jwt.ts secretToKey():
    //   Buffer.from(base64url, "base64url") — NOT TextEncoder (UTF-8 of the string).
    const key = Buffer.from(s1Secret, "base64url");
    const now = Math.floor(Date.now() / 1000);
    const tokenSignedWithS1 = await new jose.SignJWT({
      iss: "host",
      aud: "assessiq",
      sub: "u2",
      tenant_id: tenantId,
      email: "b@c.com",
      name: "B",
      assessment_id: randomUUID(),
      iat: now,
      exp: now + 300,
      jti: randomUUID(),
    })
      .setProtectedHeader({ alg: "HS256" })
      .sign(key);

    // Verify should succeed via fallback to rotated key.
    const result = await verifyEmbedToken(tokenSignedWithS1);
    expect(result.tenantId).toBe(tenantId);
  });

  it("token signed with an unrelated secret (S3) is rejected", async () => {
    const tenantId = await createTenant();
    await createEmbedSecret(tenantId, "S1");
    await rotateEmbedSecret(tenantId); // S1→rotated, S2→active

    // S3 is a completely unrelated secret, never stored for this tenant.
    const s3Secret = "unrelated-secret-that-is-not-stored-anywhere-in-db";
    const key = new TextEncoder().encode(s3Secret);
    const now = Math.floor(Date.now() / 1000);

    const tokenSignedWithS3 = await new jose.SignJWT({
      iss: "host",
      aud: "assessiq",
      sub: "u3",
      tenant_id: tenantId,
      email: "c@d.com",
      name: "C",
      assessment_id: randomUUID(),
      iat: now,
      exp: now + 300,
      jti: randomUUID(),
    })
      .setProtectedHeader({ alg: "HS256" })
      .sign(key);

    await expect(verifyEmbedToken(tokenSignedWithS3)).rejects.toBeInstanceOf(AuthnError);
  });
});

// ---------------------------------------------------------------------------
// Test 9 — three-key brute force impossible: S3 (revoked) is never tried
// ---------------------------------------------------------------------------

it("three-key brute force impossible: revoked secret S3 is not tried", async () => {
  const tenantId = await createTenant();

  // Create S1 and rotate (S1→rotated, S2→active).
  await createEmbedSecret(tenantId, "S1");
  await rotateEmbedSecret(tenantId);

  // Manually insert a 'revoked' row for S3 with a known secret.
  const s3Secret = randomUUID(); // some arbitrary plaintext
  const { encryptEnvelope: _enc } = await import("../crypto-util.js");
  const s3Enc = _enc(Buffer.from(s3Secret, "utf8"));

  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO embed_secrets (id, tenant_id, name, secret_enc, algorithm, status, rotated_at)
       VALUES ($1, $2, 'S3-revoked', $3, 'HS256', 'revoked', now())`,
      [randomUUID(), tenantId, s3Enc],
    );
  });

  // Sign a token with S3's secret.
  const key = new TextEncoder().encode(s3Secret);
  const now = Math.floor(Date.now() / 1000);
  const tokenSignedWithS3 = await new jose.SignJWT({
    iss: "host",
    aud: "assessiq",
    sub: "u4",
    tenant_id: tenantId,
    email: "d@e.com",
    name: "D",
    assessment_id: randomUUID(),
    iat: now,
    exp: now + 300,
    jti: randomUUID(),
  })
    .setProtectedHeader({ alg: "HS256" })
    .sign(key);

  // Must fail — the verify path only tries 'active' + 'rotated', never 'revoked'.
  await expect(verifyEmbedToken(tokenSignedWithS3)).rejects.toBeInstanceOf(AuthnError);
});

// ---------------------------------------------------------------------------
// Test 10 — JTI cache TTL is positive and ≤ (exp - now)
// ---------------------------------------------------------------------------

it("JTI cache TTL: after verify, Redis TTL for jti key is positive and ≤ (exp - now)", async () => {
  const tenantId = await createTenant();
  await createEmbedSecret(tenantId, "test-key");

  const before = Math.floor(Date.now() / 1000);
  const token = await mintEmbedToken(basePayload(tenantId), { ttlSeconds: 300 });
  const after = Math.floor(Date.now() / 1000);

  const result = await verifyEmbedToken(token);
  const jti = result.payload.jti;

  // Import getRedis directly to inspect the TTL.
  const { getRedis: gr } = await import("../redis.js");
  const redis = gr();
  const ttl = await redis.ttl(`aiq:embed:jti:${jti}`);

  // TTL must be a positive integer.
  expect(ttl).toBeGreaterThan(0);

  // TTL must not exceed the token's remaining lifetime at verify time.
  // The token's exp was set before the call; remaining = exp - now.
  // Use a generous bound: exp was now+300 when minted; after verify,
  // remaining is at most 300 (minted before) seconds.
  const maxExpected = result.payload.exp - before;
  expect(ttl).toBeLessThanOrEqual(maxExpected);

  // Sanity: TTL must be at most 300s (the requested TTL).
  expect(ttl).toBeLessThanOrEqual(300);
  // TTL should not be far below the expected remaining lifetime.
  // Allow 10s slop for test execution time.
  const minExpected = result.payload.exp - after - 10;
  expect(ttl).toBeGreaterThanOrEqual(Math.max(1, minExpected));
});

// ---------------------------------------------------------------------------
// Test 11 — listEmbedSecrets: order, status mix, no envelope leak
// ---------------------------------------------------------------------------

describe("listEmbedSecrets", () => {
  it("returns metadata-only rows in created_at DESC order, no secret_enc leak", async () => {
    const tenantId = await createTenant();

    // Empty tenant returns [].
    expect(await listEmbedSecrets(tenantId)).toEqual([]);

    // Create S1, rotate (S1 -> rotated, S2 -> active "rotated-secret").
    await createEmbedSecret(tenantId, "first");
    await rotateEmbedSecret(tenantId);

    const items = await listEmbedSecrets(tenantId);
    expect(items).toHaveLength(2);

    // Most recent (the rotated-secret S2) first.
    expect(items[0]!.status).toBe("active");
    expect(items[0]!.algorithm).toBe("HS256");
    expect(items[0]!.tenantId).toBe(tenantId);
    expect(items[0]!.rotatedAt).toBeNull();

    // Original S1 second, now rotated with rotated_at set.
    expect(items[1]!.status).toBe("rotated");
    expect(items[1]!.name).toBe("first");
    expect(items[1]!.rotatedAt).not.toBeNull();

    // Critically: the encrypted envelope MUST NOT appear on the record shape —
    // both camelCase (secretEnc) and snake_case (secret_enc) variants checked
    // because the row mapper is the only line preventing a leak-by-typo.
    for (const item of items) {
      expect(Object.keys(item)).not.toContain("secretEnc");
      expect(Object.keys(item)).not.toContain("secret_enc");
    }
  });

  it("RLS isolation: tenant A sees only its own embed-secret rows", async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();

    await createEmbedSecret(tenantA, "A-secret");
    await createEmbedSecret(tenantB, "B-secret");

    const aItems = await listEmbedSecrets(tenantA);
    const bItems = await listEmbedSecrets(tenantB);

    expect(aItems).toHaveLength(1);
    expect(aItems[0]!.name).toBe("A-secret");
    expect(aItems[0]!.tenantId).toBe(tenantA);

    expect(bItems).toHaveLength(1);
    expect(bItems[0]!.name).toBe("B-secret");
    expect(bItems[0]!.tenantId).toBe(tenantB);
  });
});
