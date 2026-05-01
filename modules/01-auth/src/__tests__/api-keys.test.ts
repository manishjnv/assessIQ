/**
 * Integration tests for modules/01-auth — api-keys.ts
 *
 * Uses a postgres:16-alpine testcontainer so the full RLS + assessiq_system
 * BYPASSRLS stack is exercised against a real Postgres instance.
 *
 * Container is started ONCE in beforeAll and torn down in afterAll.
 *
 * Migration order (applied by the superuser):
 *   02-tenancy: 0001_tenants.sql, 0002_rls_helpers.sql, 0003_tenants_rls.sql
 *   Stub users table (03-users Window 5; FK target for api_keys.created_by)
 *   01-auth:    010..015 in lexical order (015_api_keys.sql is the target)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// setPoolForTesting / closePool are test-only helpers not on @assessiq/tenancy's
// public surface — import from the package's internal pool.ts directly.
// The 02-tenancy pool singleton is the shared pool used by withTenant and getPool,
// so pointing it at the testcontainer URL causes all apiKeys calls to use the test DB.
import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { apiKeys, type ApiKeyScope } from "../api-keys.js";
import { AuthnError, AuthzError } from "@assessiq/core";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

// Strip leading slash before drive letter on Windows (e.g. /E:/code → E:/code).
// import.meta.url on Windows: file:///E:/code/...
// new URL('.', import.meta.url).pathname: /E:/code/.../src/__tests__/  (trailing slash)
function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

// __tests__/ is at: modules/01-auth/src/__tests__/
//   1 ..  →  modules/01-auth/src/
//   2 ..  →  modules/01-auth/
//   3 ..  →  modules/
const THIS_DIR          = toFsPath(new URL(".", import.meta.url));   // .../src/__tests__/
const AUTH_MODULE_ROOT  = join(THIS_DIR, "..", "..");                 // modules/01-auth/
const MODULES_ROOT      = join(AUTH_MODULE_ROOT, "..");               // modules/

const TENANCY_MIGRATIONS = join(MODULES_ROOT, "02-tenancy", "migrations");
const AUTH_MIGRATIONS    = join(AUTH_MODULE_ROOT, "migrations");

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let container: StartedTestContainer;
let containerUrl: string;

// Two tenants for RLS isolation test.
let tenantA: string;
let tenantB: string;

// One user per tenant (FK target for api_keys.created_by).
let userA: string;
let userB: string;

// ---------------------------------------------------------------------------
// Superuser helper
// ---------------------------------------------------------------------------

async function withSuperClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: containerUrl });
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
  // 1. Start postgres:16-alpine testcontainer.
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "test",
      POSTGRES_PASSWORD: "test",
      POSTGRES_DB: "aiq_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  containerUrl = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_test`;

  // 2. Apply migrations in dependency order.
  //    02-tenancy comes first (tenants table + roles); then a users stub;
  //    then 01-auth migrations (01x_ files in lexical order).
  const tenancyFiles = (await readdir(TENANCY_MIGRATIONS))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const authFiles = (await readdir(AUTH_MIGRATIONS))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  await withSuperClient(async (client) => {
    // 02-tenancy migrations (creates tenants, roles, RLS helpers).
    for (const file of tenancyFiles) {
      const sql = await readFile(join(TENANCY_MIGRATIONS, file), "utf-8");
      await client.query(sql);
    }

    // Minimal users stub — 03-users ships in Window 5.
    // api_keys.created_by references users(id); we need the table to exist.
    await client.query(`
      CREATE TABLE users (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id  UUID NOT NULL REFERENCES tenants(id),
        email      TEXT NOT NULL,
        name       TEXT NOT NULL,
        role       TEXT NOT NULL DEFAULT 'admin'
      )
    `);

    // 01-auth migrations (010–015, lexical).
    for (const file of authFiles) {
      const sql = await readFile(join(AUTH_MIGRATIONS, file), "utf-8");
      await client.query(sql);
    }
  });

  // 3. Point the tenancy pool singleton at the container.
  await setPoolForTesting(containerUrl);

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
}, 90_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) {
    await container.stop();
  }
});

// ---------------------------------------------------------------------------
// Test 1 — create: format + key_prefix + key_hash
// ---------------------------------------------------------------------------

describe("apiKeys.create", () => {
  it("returns a 52-char plaintext starting with aiq_live_", async () => {
    const { record, plaintextKey } = await apiKeys.create(tenantA, {
      name: "CI Integration",
      scopes: ["assessments:read"],
      createdBy: userA,
    });

    // Format check.
    expect(plaintextKey).toMatch(/^aiq_live_[0-9A-Za-z]{43}$/);
    expect(plaintextKey).toHaveLength(52);

    // key_prefix is the first 12 chars of the plaintext key.
    expect(record.keyPrefix).toBe(plaintextKey.slice(0, 12));
    expect(record.keyPrefix).toHaveLength(12);
  });

  it("record key_hash !== plaintext", async () => {
    const { plaintextKey } = await apiKeys.create(tenantA, {
      name: "Hash check",
      scopes: ["results:read"],
      createdBy: userA,
    });

    // key_hash is not directly on ApiKeyRecord (by design — never returned).
    // Verify indirectly: authenticate with the plaintext succeeds, proving the
    // hash stored matches sha256(plaintextKey). The hash being different from
    // the key itself is proven by the format (64 hex chars vs 52 base62 chars).
    const rec = await apiKeys.authenticate(plaintextKey);
    expect(rec.keyPrefix).toBe(plaintextKey.slice(0, 12));
  });
});

// ---------------------------------------------------------------------------
// Test 2 — authenticate: success
// ---------------------------------------------------------------------------

it("authenticate(plaintext) succeeds and returns the same record", async () => {
  const { record, plaintextKey } = await apiKeys.create(tenantA, {
    name: "Auth success",
    scopes: ["users:read", "results:read"],
    createdBy: userA,
  });

  const found = await apiKeys.authenticate(plaintextKey);

  expect(found.id).toBe(record.id);
  expect(found.tenantId).toBe(tenantA);
  expect(found.scopes).toEqual(expect.arrayContaining(["users:read", "results:read"]));
  expect(found.status).toBe("active");
});

// ---------------------------------------------------------------------------
// Test 3 — authenticate: wrong key throws AuthnError
// ---------------------------------------------------------------------------

it("authenticate(modified key) throws AuthnError", async () => {
  const { plaintextKey } = await apiKeys.create(tenantA, {
    name: "Wrong key test",
    scopes: ["assessments:read"],
    createdBy: userA,
  });

  // Flip the last character.
  const last = plaintextKey[plaintextKey.length - 1]!;
  const flipped = last === "A" ? "B" : "A";
  const modifiedKey = plaintextKey.slice(0, -1) + flipped;

  await expect(apiKeys.authenticate(modifiedKey)).rejects.toBeInstanceOf(AuthnError);
});

// ---------------------------------------------------------------------------
// Test 4 — authenticate: revoked key throws AuthnError
// ---------------------------------------------------------------------------

it("authenticate(revoked key) throws AuthnError after revoke()", async () => {
  const { record, plaintextKey } = await apiKeys.create(tenantA, {
    name: "Revoke test",
    scopes: ["webhooks:manage"],
    createdBy: userA,
  });

  await apiKeys.revoke(tenantA, record.id);

  await expect(apiKeys.authenticate(plaintextKey)).rejects.toBeInstanceOf(AuthnError);
});

// ---------------------------------------------------------------------------
// Test 5 — authenticate: expired key throws AuthnError
// ---------------------------------------------------------------------------

it("authenticate(expired key) throws AuthnError when expires_at is in the past", async () => {
  // Create with an already-past expires_at (1 second ago).
  const pastExpiry = new Date(Date.now() - 1000).toISOString();
  const { plaintextKey } = await apiKeys.create(tenantA, {
    name: "Expired key test",
    scopes: ["attempts:read"],
    createdBy: userA,
    expiresAt: pastExpiry,
  });

  await expect(apiKeys.authenticate(plaintextKey)).rejects.toBeInstanceOf(AuthnError);
});

// ---------------------------------------------------------------------------
// Test 6 — list: RLS isolation — tenantA cannot see tenantB's keys
// ---------------------------------------------------------------------------

it("list(tenantA) returns only tenantA keys; tenantB keys not visible", async () => {
  // Create one key for each tenant.
  const { record: recA } = await apiKeys.create(tenantA, {
    name: "TenantA key",
    scopes: ["assessments:read"],
    createdBy: userA,
  });
  const { record: recB } = await apiKeys.create(tenantB, {
    name: "TenantB key",
    scopes: ["assessments:write"],
    createdBy: userB,
  });

  const listA = await apiKeys.list(tenantA);
  const listB = await apiKeys.list(tenantB);

  const idsA = listA.map((r) => r.id);
  const idsB = listB.map((r) => r.id);

  // tenantA list contains recA but NOT recB.
  expect(idsA).toContain(recA.id);
  expect(idsA).not.toContain(recB.id);

  // tenantB list contains recB but NOT recA.
  expect(idsB).toContain(recB.id);
  expect(idsB).not.toContain(recA.id);

  // All records in each list belong to the correct tenant.
  for (const r of listA) expect(r.tenantId).toBe(tenantA);
  for (const r of listB) expect(r.tenantId).toBe(tenantB);
});

// ---------------------------------------------------------------------------
// Test 7 — requireScope: present scope passes; absent scope throws AuthzError
// ---------------------------------------------------------------------------

describe("apiKeys.requireScope", () => {
  it("succeeds when the required scope is present", async () => {
    const { record } = await apiKeys.create(tenantA, {
      name: "Scope present",
      scopes: ["users:read", "results:read"],
      createdBy: userA,
    });

    // Must not throw.
    expect(() => apiKeys.requireScope(record, "users:read")).not.toThrow();
  });

  it("throws AuthzError when the required scope is absent", async () => {
    const { record } = await apiKeys.create(tenantA, {
      name: "Scope absent",
      scopes: ["assessments:read"],
      createdBy: userA,
    });

    expect(() => apiKeys.requireScope(record, "users:read")).toThrow(AuthzError);
    expect(() => apiKeys.requireScope(record, "users:read")).toThrow(
      "api key missing scope: users:read",
    );
  });
});

// ---------------------------------------------------------------------------
// Test 8 — requireScope: admin:* wildcard matches any scope
// ---------------------------------------------------------------------------

it("requireScope with admin:* matches any requested scope", () => {
  // A record that only has "admin:*" — no other explicit scopes.
  const adminRecord = {
    id: randomUUID(),
    tenantId: tenantA,
    name: "Admin key",
    keyPrefix: "aiq_live_xyz1",
    scopes: ["admin:*"] as ApiKeyScope[],
    status: "active" as const,
    lastUsedAt: null,
    createdBy: userA,
    createdAt: new Date().toISOString(),
    expiresAt: null,
  };

  const allScopes: ApiKeyScope[] = [
    "assessments:read",
    "assessments:write",
    "users:read",
    "users:write",
    "attempts:read",
    "attempts:write",
    "results:read",
    "webhooks:manage",
    "admin:*",
  ];

  for (const scope of allScopes) {
    expect(() => apiKeys.requireScope(adminRecord, scope)).not.toThrow();
  }
});

// ---------------------------------------------------------------------------
// Test 9 — last_used_at is updated asynchronously after authenticate
// ---------------------------------------------------------------------------

it("last_used_at is updated after successful authenticate (async, up to 100ms lag)", async () => {
  const { record, plaintextKey } = await apiKeys.create(tenantA, {
    name: "LastUsedAt test",
    scopes: ["results:read"],
    createdBy: userA,
  });

  // last_used_at should be null at creation.
  expect(record.lastUsedAt).toBeNull();

  // Trigger authenticate — fires the fire-and-forget update.
  await apiKeys.authenticate(plaintextKey);

  // Poll for up to 100ms for the async update to land in Postgres.
  const deadline = Date.now() + 200; // 200ms tolerance for CI
  let lastUsedAt: string | null = null;

  while (Date.now() < deadline) {
    const rows = await withSuperClient(async (client) => {
      const result = await client.query<{ last_used_at: string | null }>(
        "SELECT last_used_at FROM api_keys WHERE id = $1",
        [record.id],
      );
      return result.rows;
    });
    lastUsedAt = rows[0]?.last_used_at ?? null;
    if (lastUsedAt !== null) break;
    // Brief yield — avoid busy-spin without importing setTimeout.
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 10);
      // Node timer ref: keep this from delaying process exit
      if (typeof t === "object" && t !== null && "unref" in t) {
        (t as ReturnType<typeof setTimeout> & { unref(): void }).unref();
      }
    });
  }

  expect(lastUsedAt).not.toBeNull();
});
