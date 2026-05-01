/**
 * Integration tests for modules/01-auth/src/google-sso.ts
 *
 * Testcontainer strategy: one postgres:16-alpine + one redis:7-alpine container
 * started in beforeAll, torn down in afterAll. All tests share the containers.
 *
 * Google token exchange (fetch) and JWKS (jose.jwtVerify) are fully mocked —
 * real Google endpoints are never contacted. jose is hoisted via vi.mock so
 * its ESM live bindings become configurable; jwtVerify is replaced per-test
 * via vi.mocked(jose.jwtVerify).mockResolvedValue(...).
 *
 * The users table is created via a minimal shim before the auth migrations are
 * applied, because 03-users has not shipped yet.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// vi.mock must be called at the top level (hoisted) for ESM. The factory
// creates a partial mock that stubs only jwtVerify + createRemoteJWKSet;
// all other exports remain real so the implementation can call them normally.
vi.mock("jose", async (importActual) => {
  const actual = await importActual<typeof import("jose")>();
  return {
    ...actual,
    // jwtVerify is replaced per-test via vi.mocked(jose.jwtVerify).mockResolvedValue(...)
    jwtVerify: vi.fn(),
    // createRemoteJWKSet returns a stub keyset; jwtVerify is what we actually mock.
    createRemoteJWKSet: vi.fn(() => ({})),
  };
});

import * as jose from "jose";

// setPoolForTesting / closePool are test-only helpers not on @assessiq/tenancy's
// public surface — import from @assessiq/tenancy.
import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { setRedisForTesting, closeRedis } from "../redis.js";
import {
  startGoogleSso,
  handleGoogleCallback,
  normalizeEmail,
  _resetJwksForTesting,
} from "../google-sso.js";
import { sessions } from "../sessions.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// Strip leading slash before drive letter on Windows: "/E:/code/..." → "E:/code/..."
function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

// __tests__/ is at:  modules/01-auth/src/__tests__/
//   1 ..  →  modules/01-auth/src/
//   2 ..  →  modules/01-auth/
//   3 ..  →  modules/
const THIS_DIR         = toFsPath(new URL(".", import.meta.url));    // .../src/__tests__/
const AUTH_MODULE_ROOT = join(THIS_DIR, "..", "..");                  // modules/01-auth/
const MODULES_ROOT     = join(THIS_DIR, "..", "..", "..");            // modules/

const TENANCY_MIGRATIONS_DIR = join(MODULES_ROOT, "02-tenancy", "migrations");
const AUTH_MIGRATIONS_DIR    = join(AUTH_MODULE_ROOT, "migrations");

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let pgContainer: StartedTestContainer;
let redisContainer: StartedTestContainer;
let pgUrl: string;
let redisUrl: string;

let tenantId: string;

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

/** Insert a user row directly via superuser (bypasses RLS). */
async function insertUser(overrides: {
  id?: string;
  tenantId?: string;
  email: string;
  role?: "admin" | "reviewer" | "candidate";
  status?: string;
  deleted_at?: string | null;
}): Promise<string> {
  const id = overrides.id ?? randomUUID();
  const tid = overrides.tenantId ?? tenantId;
  const role = overrides.role ?? "admin";
  const status = overrides.status ?? "active";
  const deletedAt = overrides.deleted_at ?? null;

  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO users (id, tenant_id, email, role, status, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, tid, overrides.email, role, status, deletedAt],
    );
  });

  return id;
}

/** Insert an oauth_identity row directly via superuser. */
async function insertOauthIdentity(opts: {
  userId: string;
  tenantId?: string;
  provider?: string;
  subject: string;
}): Promise<void> {
  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO oauth_identities (tenant_id, user_id, provider, subject, email_verified)
       VALUES ($1, $2, $3, $4, false)`,
      [opts.tenantId ?? tenantId, opts.userId, opts.provider ?? "google", opts.subject],
    );
  });
}

// ---------------------------------------------------------------------------
// Mock helpers for Google flow
// ---------------------------------------------------------------------------

/** Build a state+nonce cookie pair by calling startGoogleSso. */
async function buildStateAndNonce(): Promise<{
  stateCookieValue: string;
  nonceCookieValue: string;
}> {
  const result = await startGoogleSso({ tenantId });
  return {
    stateCookieValue: result.stateCookie.value,
    nonceCookieValue: result.nonceCookie.value,
  };
}

/**
 * Stubs fetch (token exchange) and jose.jwtVerify (JWKS verify) so that
 * handleGoogleCallback succeeds with the provided claims.
 */
function mockGoogleFlow(claims: {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  nonce: string;
}): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        access_token: "mock-access-token",
        id_token: "mock-id-token",
        token_type: "Bearer",
        expires_in: 3600,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );

  vi.mocked(jose.jwtVerify).mockResolvedValue({
    payload: {
      iss: "https://accounts.google.com",
      aud: "test-client-id",
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      ...claims,
    },
    protectedHeader: { alg: "RS256" },
    key: {} as jose.KeyLike,
  } as Awaited<ReturnType<typeof jose.jwtVerify>>);
}

// ---------------------------------------------------------------------------
// Global setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Google env vars are set in vitest.setup.ts (??= pattern) so the eager
  // config singleton in 00-core has them before any module loads.

  // 1. Start containers in parallel.
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

  // 2. Apply migrations: tenancy first, then users shim, then auth.
  const tenancyFiles = (await readdir(TENANCY_MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const authFiles = (await readdir(AUTH_MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  await withSuperClient(async (client) => {
    // Tenancy migrations: roles, tenants, tenant_settings.
    for (const file of tenancyFiles) {
      const sql = await readFile(join(TENANCY_MIGRATIONS_DIR, file), "utf-8");
      await client.query(sql);
    }

    // Shim: minimal users table to satisfy FKs in auth migrations (sessions,
    // oauth_identities). Matches exactly the columns google-sso.ts queries.
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        email       TEXT NOT NULL,
        role        TEXT NOT NULL DEFAULT 'admin'
                    CHECK (role IN ('admin','reviewer','candidate')),
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

    // Auth migrations.
    for (const file of authFiles) {
      const sql = await readFile(join(AUTH_MIGRATIONS_DIR, file), "utf-8");
      await client.query(sql);
    }
  });

  // 3. Wire singletons to testcontainers.
  await setPoolForTesting(pgUrl);
  await setRedisForTesting(redisUrl);

  // 4. Insert a shared tenant for all tests.
  tenantId = randomUUID();
  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`,
      [tenantId, "test-tenant", "Test Tenant"],
    );
    await client.query(
      `INSERT INTO tenant_settings (tenant_id) VALUES ($1)`,
      [tenantId],
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

beforeEach(() => {
  // Restore fetch spies between tests; jose.jwtVerify reset is handled by
  // vi.mocked(jose.jwtVerify).mockReset() below. The JWKS singleton is reset
  // so each test starts fresh — necessary because createRemoteJWKSet is also mocked.
  vi.restoreAllMocks();
  vi.mocked(jose.jwtVerify).mockReset();
  vi.mocked(jose.createRemoteJWKSet).mockReturnValue({} as ReturnType<typeof jose.createRemoteJWKSet>);
  _resetJwksForTesting();
});

// ---------------------------------------------------------------------------
// 1. startGoogleSso — redirect URL shape
// ---------------------------------------------------------------------------

describe("startGoogleSso", () => {
  it("produces a redirect URL containing client_id, redirect_uri, state, nonce, scope, response_type", async () => {
    const result = await startGoogleSso({ tenantId });

    const url = new URL(result.redirectUrl);
    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://assessiq.automateedge.cloud/api/auth/google/cb",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("nonce")).toBeTruthy();
  });

  it("embeds tenantId in the state so callback can scope queries", async () => {
    const result = await startGoogleSso({ tenantId });
    // State format: <random>|<tenantId>[|<returnTo>]
    const stateParts = result.stateCookie.value.split("|");
    expect(stateParts[1]).toBe(tenantId);
  });

  it("state and nonce cookies have httpOnly=true, secure=true, sameSite=lax, path=/, maxAge<=600", async () => {
    const result = await startGoogleSso({ tenantId });

    for (const cookie of [result.stateCookie, result.nonceCookie]) {
      expect(cookie.opts.httpOnly).toBe(true);
      expect(cookie.opts.secure).toBe(true);
      expect(cookie.opts.sameSite).toBe("lax");
      expect(cookie.opts.path).toBe("/");
      expect(cookie.opts.maxAge).toBeLessThanOrEqual(600);
      expect(cookie.opts.maxAge).toBeGreaterThan(0);
    }
  });

  it("cookie names are aiq_oauth_state and aiq_oauth_nonce", async () => {
    const result = await startGoogleSso({ tenantId });
    expect(result.stateCookie.name).toBe("aiq_oauth_state");
    expect(result.nonceCookie.name).toBe("aiq_oauth_nonce");
  });
});

// ---------------------------------------------------------------------------
// 2. normalizeEmail
// ---------------------------------------------------------------------------

it("normalizeEmail trims and lowercases", () => {
  expect(normalizeEmail("  Foo@BAR.com  ")).toBe("foo@bar.com");
  expect(normalizeEmail("USER@EXAMPLE.COM")).toBe("user@example.com");
  // Plus-addresses and dots are preserved — valid distinct addresses.
  expect(normalizeEmail("user+tag@example.com")).toBe("user+tag@example.com");
  expect(normalizeEmail("first.last@example.com")).toBe("first.last@example.com");
});

// ---------------------------------------------------------------------------
// 3. State mismatch → AuthnError
// ---------------------------------------------------------------------------

it("state mismatch throws AuthnError", async () => {
  await expect(
    handleGoogleCallback({
      code: "any-code",
      state: "tampered-state-value-xx",
      stateCookieValue: "different-cookie-value-",
      nonceCookieValue: "some-nonce",
      ip: "127.0.0.1",
      ua: "test-agent",
    }),
  ).rejects.toMatchObject({ name: "AuthnError" });
});

it("missing state cookie throws AuthnError", async () => {
  await expect(
    handleGoogleCallback({
      code: "any-code",
      state: "some-state",
      stateCookieValue: undefined,
      nonceCookieValue: "some-nonce",
      ip: "127.0.0.1",
      ua: "test-agent",
    }),
  ).rejects.toMatchObject({ name: "AuthnError" });
});

// ---------------------------------------------------------------------------
// 4. Nonce mismatch → AuthnError
// ---------------------------------------------------------------------------

it("nonce mismatch throws AuthnError", async () => {
  const { stateCookieValue } = await buildStateAndNonce();

  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        access_token: "mock-access",
        id_token: "mock-id-token",
        token_type: "Bearer",
        expires_in: 3600,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );

  // jwtVerify returns a nonce that differs from the cookie value.
  vi.mocked(jose.jwtVerify).mockResolvedValue({
    payload: {
      iss: "https://accounts.google.com",
      aud: "test-client-id",
      sub: "google-sub-nonce-test",
      email: "nonce@example.com",
      nonce: "wrong-nonce-that-does-not-match",
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    },
    protectedHeader: { alg: "RS256" },
    key: {} as jose.KeyLike,
  } as Awaited<ReturnType<typeof jose.jwtVerify>>);

  await expect(
    handleGoogleCallback({
      code: "any-code",
      state: stateCookieValue,
      stateCookieValue,
      nonceCookieValue: "correct-nonce-cookie-value",
      ip: "127.0.0.1",
      ua: "test-agent",
    }),
  ).rejects.toMatchObject({ name: "AuthnError" });
});

// ---------------------------------------------------------------------------
// 5. Resolve via oauth_identities hit → returns that user
// ---------------------------------------------------------------------------

it("resolves user via oauth_identities when subject matches", async () => {
  const userId = await insertUser({ email: "linked@example.com", tenantId });
  await insertOauthIdentity({ userId, subject: "google-sub-linked-12345", tenantId });

  const { stateCookieValue, nonceCookieValue } = await buildStateAndNonce();

  mockGoogleFlow({
    sub: "google-sub-linked-12345",
    email: "linked@example.com",
    nonce: nonceCookieValue,
  });

  const result = await handleGoogleCallback({
    code: "auth-code",
    state: stateCookieValue,
    stateCookieValue,
    nonceCookieValue,
    ip: "10.0.0.1",
    ua: "Mozilla/5.0",
  });

  expect(result.user.id).toBe(userId);
  expect(result.user.email).toBe("linked@example.com");
  expect(result.user.tenantId).toBe(tenantId);
  expect(result.sessionToken).toBeTruthy();
});

// ---------------------------------------------------------------------------
// 6. Resolve via email JIT-link → INSERT oauth_identities, return user
// ---------------------------------------------------------------------------

it("JIT-links oauth_identities when no identity row exists but email matches a user", async () => {
  const email = "jit@example.com";
  const userId = await insertUser({ email, tenantId });

  const { stateCookieValue, nonceCookieValue } = await buildStateAndNonce();

  mockGoogleFlow({
    sub: "google-sub-jit-67890",
    email,
    nonce: nonceCookieValue,
  });

  const result = await handleGoogleCallback({
    code: "auth-code",
    state: stateCookieValue,
    stateCookieValue,
    nonceCookieValue,
    ip: "10.0.0.2",
    ua: "Mozilla/5.0",
  });

  expect(result.user.id).toBe(userId);

  // Verify the JIT-linked oauth_identities row was inserted.
  const identityCheck = await withSuperClient((client) =>
    client.query(
      `SELECT user_id FROM oauth_identities WHERE provider = 'google' AND subject = $1`,
      ["google-sub-jit-67890"],
    ),
  );
  expect(identityCheck.rows).toHaveLength(1);
  expect(identityCheck.rows[0]!.user_id).toBe(userId);
});

// ---------------------------------------------------------------------------
// 7. No user, no JIT → AuthnError("user not in tenant")
// ---------------------------------------------------------------------------

it("throws AuthnError when email does not exist in the tenant", async () => {
  const { stateCookieValue, nonceCookieValue } = await buildStateAndNonce();

  mockGoogleFlow({
    sub: "google-sub-unknown-99999",
    email: "nobody@example.com",
    nonce: nonceCookieValue,
  });

  await expect(
    handleGoogleCallback({
      code: "auth-code",
      state: stateCookieValue,
      stateCookieValue,
      nonceCookieValue,
      ip: "10.0.0.3",
      ua: "Mozilla/5.0",
    }),
  ).rejects.toMatchObject({ name: "AuthnError", message: "user not in tenant" });
});

// ---------------------------------------------------------------------------
// 8. Disabled user → AuthnError
// ---------------------------------------------------------------------------

it("throws AuthnError when user status is 'disabled'", async () => {
  const email = "disabled@example.com";
  const userId = await insertUser({ email, tenantId, status: "disabled" });
  await insertOauthIdentity({ userId, subject: "google-sub-disabled", tenantId });

  const { stateCookieValue, nonceCookieValue } = await buildStateAndNonce();

  mockGoogleFlow({
    sub: "google-sub-disabled",
    email,
    nonce: nonceCookieValue,
  });

  await expect(
    handleGoogleCallback({
      code: "auth-code",
      state: stateCookieValue,
      stateCookieValue,
      nonceCookieValue,
      ip: "10.0.0.4",
      ua: "Mozilla/5.0",
    }),
  ).rejects.toMatchObject({ name: "AuthnError" });
});

// ---------------------------------------------------------------------------
// 9. Soft-deleted user → AuthnError
// ---------------------------------------------------------------------------

it("throws AuthnError when user has deleted_at set", async () => {
  const email = "deleted@example.com";
  const userId = await insertUser({
    email,
    tenantId,
    deleted_at: new Date().toISOString(),
  });
  await insertOauthIdentity({ userId, subject: "google-sub-deleted", tenantId });

  const { stateCookieValue, nonceCookieValue } = await buildStateAndNonce();

  mockGoogleFlow({
    sub: "google-sub-deleted",
    email,
    nonce: nonceCookieValue,
  });

  await expect(
    handleGoogleCallback({
      code: "auth-code",
      state: stateCookieValue,
      stateCookieValue,
      nonceCookieValue,
      ip: "10.0.0.5",
      ua: "Mozilla/5.0",
    }),
  ).rejects.toMatchObject({ name: "AuthnError" });
});

// ---------------------------------------------------------------------------
// 10. Soft-deleted user reached via JIT email path → AuthnError
// ---------------------------------------------------------------------------

it("blocks soft-deleted user when JIT email path resolves them", async () => {
  const email = "deleted-jit@example.com";
  // status='active' but deleted_at is set — both guards must fire.
  await insertUser({
    email,
    tenantId,
    status: "active",
    deleted_at: new Date().toISOString(),
  });

  const { stateCookieValue, nonceCookieValue } = await buildStateAndNonce();

  mockGoogleFlow({
    sub: "google-sub-deleted-jit",
    email,
    nonce: nonceCookieValue,
  });

  await expect(
    handleGoogleCallback({
      code: "auth-code",
      state: stateCookieValue,
      stateCookieValue,
      nonceCookieValue,
      ip: "10.0.0.6",
      ua: "Mozilla/5.0",
    }),
  ).rejects.toMatchObject({ name: "AuthnError" });
});

// ---------------------------------------------------------------------------
// 11. Session is minted with totpVerified=false
// ---------------------------------------------------------------------------

it("mints a pre-MFA session with totpVerified=false", async () => {
  const email = "mfa-pending@example.com";
  const userId = await insertUser({ email, tenantId, role: "admin" });
  await insertOauthIdentity({ userId, subject: "google-sub-mfa-check", tenantId });

  const { stateCookieValue, nonceCookieValue } = await buildStateAndNonce();

  mockGoogleFlow({
    sub: "google-sub-mfa-check",
    email,
    nonce: nonceCookieValue,
  });

  const result = await handleGoogleCallback({
    code: "auth-code",
    state: stateCookieValue,
    stateCookieValue,
    nonceCookieValue,
    ip: "10.0.0.7",
    ua: "Mozilla/5.0",
  });

  expect(result.sessionToken).toBeTruthy();
  expect(result.redirectTo).toBe("/admin/mfa");

  // Retrieve session from Redis and confirm totpVerified=false.
  const session = await sessions.get(result.sessionToken);
  expect(session).not.toBeNull();
  expect(session!.totpVerified).toBe(false);
  expect(session!.userId).toBe(userId);
});
