/**
 * Super-admin platform login + gate tests
 *
 * Tests acceptance criteria from the super-admin-onboarding contract:
 *
 *   (a) Platform login mints super_admin ONLY when ALL 4 gates pass;
 *       each missing gate → AuthnError.
 *   (b) REGRESSION: customer-tenant login path unchanged — a normal
 *       Google login for a non-platform tenant still uses oauth_identities,
 *       still mints a non-super_admin session, and the super_admin gate
 *       is NEVER involved. Proves the customer branch is byte-identical
 *       to pre-contract behaviour.
 *   (e) super_admin route rejects sessions where role !== 'super_admin'
 *       OR totpVerified !== true (MFA always-on for super_admin, independent
 *       of MFA_REQUIRED env).
 *
 * Strategy: same testcontainer approach as google-sso.test.ts (one postgres +
 * one redis, shared across tests). Google token exchange (fetch) and JWKS
 * (jose.jwtVerify) are fully mocked. The platform tenant + super_admin user
 * are inserted via superuser SQL before tests run — the C1 migration is not
 * applied here (Opus applies it surgically to prod). We replicate the DDL
 * inline so the tests are self-contained.
 *
 * Tests (c), (d), (f) live in super-admin-route.test.ts (C4 route integration)
 * because they require inviteUser, seedTenantTaxonomy, and the full service
 * stack. Splitting keeps this file focused on auth-layer concerns.
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

// jose must be hoisted so the ESM mock resolves before google-sso.ts loads.
vi.mock("jose", async (importActual) => {
  const actual = await importActual<typeof import("jose")>();
  return {
    ...actual,
    jwtVerify: vi.fn(),
    createRemoteJWKSet: vi.fn(() => ({})),
  };
});

import * as jose from "jose";
import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { setRedisForTesting, closeRedis } from "../redis.js";
import {
  startGoogleSso,
  handleGoogleCallback,
  _resetJwksForTesting,
} from "../google-sso.js";
import { sessions } from "../sessions.js";
import { requireAuth } from "../middleware/require-auth.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

const THIS_DIR         = toFsPath(new URL(".", import.meta.url));
const AUTH_MODULE_ROOT = join(THIS_DIR, "..", "..");
const MODULES_ROOT     = join(THIS_DIR, "..", "..", "..");
const TENANCY_MIGRATIONS_DIR = join(MODULES_ROOT, "02-tenancy", "migrations");
const AUTH_MIGRATIONS_DIR    = join(AUTH_MODULE_ROOT, "migrations");

// ---------------------------------------------------------------------------
// Constants matching the migration seed values
// ---------------------------------------------------------------------------

const PLATFORM_TENANT_ID = "00000000-0000-7000-0000-000000000001";
const PLATFORM_USER_ID   = "00000000-0000-7000-0000-000000000002";
const SUPER_ADMIN_EMAIL  = "manishjnvk@gmail.com";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let pgContainer: StartedTestContainer;
let redisContainer: StartedTestContainer;
let pgUrl: string;
let redisUrl: string;

/** A regular customer tenant (not platform). */
let customerTenantId: string;

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

function mockGoogleFlow(claims: {
  sub: string;
  email: string;
  email_verified?: boolean;
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

// P1: tenantId no longer embedded in state — startGoogleSso takes no tenantId.
// The parameter is kept for call-site compatibility but ignored.
async function buildStateAndNonce(_tenantId?: string): Promise<{
  stateCookieValue: string;
  nonceCookieValue: string;
}> {
  const result = await startGoogleSso({});
  return {
    stateCookieValue: result.stateCookie.value,
    nonceCookieValue: result.nonceCookie.value,
  };
}

// ---------------------------------------------------------------------------
// Global setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Set env vars for the platform tenant + super-admin allowlist.
  process.env.PLATFORM_TENANT_ID = PLATFORM_TENANT_ID;
  process.env.SUPER_ADMIN_EMAILS = SUPER_ADMIN_EMAIL;

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

  const tenancyFiles = (await readdir(TENANCY_MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const authFiles = (await readdir(AUTH_MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  await withSuperClient(async (client) => {
    // Tenancy migrations.
    for (const file of tenancyFiles) {
      const sql = await readFile(join(TENANCY_MIGRATIONS_DIR, file), "utf-8");
      await client.query(sql);
    }

    // Users table shim (mirrors google-sso.test.ts; includes super_admin role).
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

    // Auth migrations (sessions, oauth_identities — excludes 016 which Opus applies).
    for (const file of authFiles) {
      // Skip 016_super_admin.sql — that updates CHECK constraints and seeds data
      // that we replicate here via explicit SQL so tests are self-contained.
      if (file.includes("016_super_admin")) continue;
      const sql = await readFile(join(AUTH_MIGRATIONS_DIR, file), "utf-8");
      await client.query(sql);
    }

    // Patch the sessions.role CHECK to allow 'super_admin' (mirrors C1 DDL).
    await client.query(`
      ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_role_check;
      ALTER TABLE sessions ADD CONSTRAINT sessions_role_check
        CHECK (role IN ('admin', 'super_admin', 'reviewer', 'candidate'));
    `);

    // Seed platform tenant + settings + super_admin user (mirrors C1 data).
    await client.query(`
      INSERT INTO tenants (id, slug, name, status)
      VALUES ('${PLATFORM_TENANT_ID}', 'platform', 'AssessIQ Platform', 'active')
      ON CONFLICT DO NOTHING;

      INSERT INTO tenant_settings (tenant_id)
      VALUES ('${PLATFORM_TENANT_ID}')
      ON CONFLICT DO NOTHING;

      INSERT INTO users (id, tenant_id, email, name, role, status)
      VALUES (
        '${PLATFORM_USER_ID}',
        '${PLATFORM_TENANT_ID}',
        '${SUPER_ADMIN_EMAIL}',
        'Manish Kumar',
        'super_admin',
        'active'
      )
      ON CONFLICT DO NOTHING;
    `);

    // Seed a regular customer tenant for regression tests.
    customerTenantId = randomUUID();
    await client.query(`
      INSERT INTO tenants (id, slug, name) VALUES ($1, 'acme', 'Acme Corp')
    `, [customerTenantId]);
    await client.query(`
      INSERT INTO tenant_settings (tenant_id) VALUES ($1)
    `, [customerTenantId]);
  });

  await setPoolForTesting(pgUrl);
  await setRedisForTesting(redisUrl);
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
  vi.restoreAllMocks();
  vi.mocked(jose.jwtVerify).mockReset();
  vi.mocked(jose.createRemoteJWKSet).mockReturnValue({} as ReturnType<typeof jose.createRemoteJWKSet>);
  _resetJwksForTesting();
});

// ---------------------------------------------------------------------------
// (a) Platform login — all 4 gates
// ---------------------------------------------------------------------------

describe("platform login — super_admin", () => {
  it("mints a super_admin session when all 4 gates pass", async () => {
    const { stateCookieValue, nonceCookieValue } = await buildStateAndNonce(PLATFORM_TENANT_ID);

    mockGoogleFlow({
      sub: "google-sub-superadmin",
      email: SUPER_ADMIN_EMAIL,
      email_verified: true,
      nonce: nonceCookieValue,
    });

    const result = await handleGoogleCallback({
      code: "auth-code",
      state: stateCookieValue,
      stateCookieValue,
      nonceCookieValue,
      ip: "1.2.3.4",
      ua: "TestAgent/1.0",
    });

    expect(result.kind).toBe("session");
    if (result.kind !== "session") throw new Error("expected session");
    expect(result.user.role).toBe("super_admin");
    expect(result.user.tenantId).toBe(PLATFORM_TENANT_ID);
    expect(result.redirectTo).toBe("/admin/mfa");
    expect(result.sessionToken).toBeTruthy();

    // Verify session in Redis: role=super_admin, totpVerified=false.
    const sess = await sessions.get(result.sessionToken);
    expect(sess).not.toBeNull();
    expect(sess!.role).toBe("super_admin");
    expect(sess!.totpVerified).toBe(false);
    expect(sess!.tenantId).toBe(PLATFORM_TENANT_ID);
  });

  it("gate 2 failure: email NOT in SUPER_ADMIN_EMAILS → AuthnError", async () => {
    const { stateCookieValue, nonceCookieValue } = await buildStateAndNonce(PLATFORM_TENANT_ID);

    mockGoogleFlow({
      sub: "google-sub-attacker",
      email: "attacker@example.com",
      nonce: nonceCookieValue,
    });

    await expect(
      handleGoogleCallback({
        code: "auth-code",
        state: stateCookieValue,
        stateCookieValue,
        nonceCookieValue,
        ip: "1.2.3.4",
        ua: "TestAgent/1.0",
      }),
    ).rejects.toMatchObject({ name: "AuthnError" });
  });

  it("gate 3 failure: email in allowlist but no DB user in platform tenant → AuthnError", async () => {
    // Temporarily add a second email to SUPER_ADMIN_EMAILS that has no DB row.
    const original = process.env.SUPER_ADMIN_EMAILS;
    process.env.SUPER_ADMIN_EMAILS = `${SUPER_ADMIN_EMAIL},nobody@example.com`;

    const { stateCookieValue, nonceCookieValue } = await buildStateAndNonce(PLATFORM_TENANT_ID);

    mockGoogleFlow({
      sub: "google-sub-nobody",
      email: "nobody@example.com",
      nonce: nonceCookieValue,
    });

    await expect(
      handleGoogleCallback({
        code: "auth-code",
        state: stateCookieValue,
        stateCookieValue,
        nonceCookieValue,
        ip: "1.2.3.4",
        ua: "TestAgent/1.0",
      }),
    ).rejects.toMatchObject({ name: "AuthnError" });

    process.env.SUPER_ADMIN_EMAILS = original;
  });

  it("gate 3 failure: user row exists but role !== super_admin → AuthnError", async () => {
    // Insert a plain 'admin' user in the platform tenant with a different email
    // and add that email to SUPER_ADMIN_EMAILS.
    const impostor = "impostor@example.com";
    await withSuperClient(async (client) => {
      await client.query(
        `INSERT INTO users (id, tenant_id, email, name, role, status)
         VALUES ($1, $2, $3, 'Impostor', 'admin', 'active')
         ON CONFLICT DO NOTHING`,
        [randomUUID(), PLATFORM_TENANT_ID, impostor],
      );
    });

    const original = process.env.SUPER_ADMIN_EMAILS;
    process.env.SUPER_ADMIN_EMAILS = `${SUPER_ADMIN_EMAIL},${impostor}`;

    const { stateCookieValue, nonceCookieValue } = await buildStateAndNonce(PLATFORM_TENANT_ID);

    mockGoogleFlow({
      sub: "google-sub-impostor",
      email: impostor,
      nonce: nonceCookieValue,
    });

    await expect(
      handleGoogleCallback({
        code: "auth-code",
        state: stateCookieValue,
        stateCookieValue,
        nonceCookieValue,
        ip: "1.2.3.4",
        ua: "TestAgent/1.0",
      }),
    ).rejects.toMatchObject({ name: "AuthnError" });

    process.env.SUPER_ADMIN_EMAILS = original;
  });

  it("gate 4: session is always minted with totpVerified=false (MFA forced)", async () => {
    const { stateCookieValue, nonceCookieValue } = await buildStateAndNonce(PLATFORM_TENANT_ID);

    mockGoogleFlow({
      sub: "google-sub-superadmin-mfa",
      email: SUPER_ADMIN_EMAIL,
      nonce: nonceCookieValue,
    });

    const result = await handleGoogleCallback({
      code: "auth-code",
      state: stateCookieValue,
      stateCookieValue,
      nonceCookieValue,
      ip: "10.0.0.1",
      ua: "UA",
    });

    if (result.kind !== "session") throw new Error("expected session");
    const sess = await sessions.get(result.sessionToken);
    expect(sess!.totpVerified).toBe(false);
    expect(result.redirectTo).toBe("/admin/mfa");
  });

  it("NO oauth_identities row is inserted for platform login (option c invariant)", async () => {
    const { stateCookieValue, nonceCookieValue } = await buildStateAndNonce(PLATFORM_TENANT_ID);
    const uniqueSub = `google-sub-no-oi-${randomUUID()}`;

    mockGoogleFlow({
      sub: uniqueSub,
      email: SUPER_ADMIN_EMAIL,
      nonce: nonceCookieValue,
    });

    await handleGoogleCallback({
      code: "auth-code",
      state: stateCookieValue,
      stateCookieValue,
      nonceCookieValue,
      ip: "10.0.0.2",
      ua: "UA",
    });

    // Verify oauth_identities has NO row for this subject.
    const oiCheck = await withSuperClient((client) =>
      client.query(
        `SELECT count(*) AS cnt FROM oauth_identities WHERE subject = $1`,
        [uniqueSub],
      ),
    );
    expect(Number(oiCheck.rows[0]!.cnt)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (b) REGRESSION: customer-tenant login path unchanged
// ---------------------------------------------------------------------------

describe("customer-tenant login — regression (path UNCHANGED)", () => {
  it("normal admin in customer tenant: resolves via oauth_identities, mints admin session, no super_admin involvement", async () => {
    // Insert a customer-tenant admin user and link their oauth_identities row.
    const customerEmail = "admin@acme-corp.com";
    const customerId = randomUUID();
    await withSuperClient(async (client) => {
      await client.query(
        `INSERT INTO users (id, tenant_id, email, role, status)
         VALUES ($1, $2, $3, 'admin', 'active')
         ON CONFLICT DO NOTHING`,
        [customerId, customerTenantId, customerEmail],
      );
      await client.query(
        `INSERT INTO oauth_identities (tenant_id, user_id, provider, subject, email_verified)
         VALUES ($1, $2, 'google', 'google-sub-customer-admin', false)
         ON CONFLICT DO NOTHING`,
        [customerTenantId, customerId],
      );
    });

    const { stateCookieValue, nonceCookieValue } = await buildStateAndNonce(customerTenantId);

    mockGoogleFlow({
      sub: "google-sub-customer-admin",
      email: customerEmail,
      nonce: nonceCookieValue,
    });

    const result = await handleGoogleCallback({
      code: "auth-code",
      state: stateCookieValue,
      stateCookieValue,
      nonceCookieValue,
      ip: "10.0.1.1",
      ua: "UA",
    });

    expect(result.kind).toBe("session");
    if (result.kind !== "session") throw new Error("expected session");
    // Must be admin role (never super_admin) from the customer tenant.
    expect(result.user.role).toBe("admin");
    expect(result.user.tenantId).toBe(customerTenantId);
    // Redirect: MFA_REQUIRED=true in test (default) → /admin/mfa.
    // The customer path is the EXISTING logic, which redirects based on MFA_REQUIRED.
    // In the test env MFA_REQUIRED defaults to 'true' → /admin/mfa.
    expect(result.redirectTo).toBe("/admin/mfa");
    expect(result.sessionToken).toBeTruthy();

    const sess = await sessions.get(result.sessionToken);
    expect(sess!.role).toBe("admin");
    expect(sess!.tenantId).toBe(customerTenantId);

    // The oauth_identities row already existed; no new row should have been added
    // (Pass 1 hit; Pass 2 JIT-link not needed).
    const oiCheck = await withSuperClient((client) =>
      client.query(
        `SELECT count(*) AS cnt FROM oauth_identities
         WHERE provider = 'google' AND subject = 'google-sub-customer-admin'`,
      ),
    );
    expect(Number(oiCheck.rows[0]!.cnt)).toBe(1); // exactly one row, the original
  });

  it("customer-tenant JIT-link still works: email match inserts oauth_identities", async () => {
    const jitEmail = "jit-customer@acme-corp.com";
    const jitUserId = randomUUID();
    await withSuperClient(async (client) => {
      await client.query(
        `INSERT INTO users (id, tenant_id, email, role, status)
         VALUES ($1, $2, $3, 'admin', 'active')
         ON CONFLICT DO NOTHING`,
        [jitUserId, customerTenantId, jitEmail],
      );
    });

    const { stateCookieValue, nonceCookieValue } = await buildStateAndNonce(customerTenantId);
    const jitSub = `google-sub-jit-customer-${randomUUID()}`;

    mockGoogleFlow({
      sub: jitSub,
      email: jitEmail,
      nonce: nonceCookieValue,
    });

    const result = await handleGoogleCallback({
      code: "auth-code",
      state: stateCookieValue,
      stateCookieValue,
      nonceCookieValue,
      ip: "10.0.1.2",
      ua: "UA",
    });

    expect(result.kind).toBe("session");
    if (result.kind !== "session") throw new Error("expected session");
    expect(result.user.id).toBe(jitUserId);
    expect(result.user.role).toBe("admin");

    // JIT-link: oauth_identities row must have been inserted.
    const oiCheck = await withSuperClient((client) =>
      client.query(
        `SELECT user_id FROM oauth_identities WHERE subject = $1`,
        [jitSub],
      ),
    );
    expect(oiCheck.rows).toHaveLength(1);
    expect(oiCheck.rows[0]!.user_id).toBe(jitUserId);
  });

  it("unknown user in customer tenant still throws AuthnError (no self-registration)", async () => {
    const { stateCookieValue, nonceCookieValue } = await buildStateAndNonce(customerTenantId);

    mockGoogleFlow({
      sub: "google-sub-stranger",
      email: "stranger@acme-corp.com",
      nonce: nonceCookieValue,
    });

    await expect(
      handleGoogleCallback({
        code: "auth-code",
        state: stateCookieValue,
        stateCookieValue,
        nonceCookieValue,
        ip: "10.0.1.3",
        ua: "UA",
      }),
    // P1: cross-tenant resolve returns empty → generic "authentication failed".
    ).rejects.toMatchObject({ name: "AuthnError", message: "authentication failed" });
  });
});

// ---------------------------------------------------------------------------
// (e) Super-admin route guard — requireAuth MFA-always-on behaviour
// ---------------------------------------------------------------------------

describe("requireAuth: super_admin always requires totpVerified=true", () => {
  /**
   * Build a minimal fake request and reply for requireAuth.
   * requireAuth reads req.session.role and req.session.totpVerified.
   */
  function makeReq(sessionOverrides: Partial<{
    role: string;
    totpVerified: boolean;
    lastTotpAt: string | null;
    tenantId: string;
    userId: string;
    expiresAt: string;
    lastSeenAt: string;
    createdAt: string;
  }>): Record<string, unknown> {
    return {
      session: {
        id: randomUUID(),
        userId: randomUUID(),
        tenantId: PLATFORM_TENANT_ID,
        role: "super_admin",
        totpVerified: false,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
        lastSeenAt: new Date().toISOString(),
        lastTotpAt: null,
        ip: "10.0.0.1",
        ua: "UA",
        ...sessionOverrides,
      },
    };
  }

  it("super_admin + totpVerified=true → requireAuth passes", async () => {
    const req = makeReq({ role: "super_admin", totpVerified: true, lastTotpAt: new Date().toISOString() });
    const hook = requireAuth({ roles: ["super_admin"] });
    await expect(hook(req as never, {} as never)).resolves.toBeUndefined();
  });

  it("super_admin + totpVerified=false → requireAuth throws AuthnError (MFA always-on)", async () => {
    // Even when MFA_REQUIRED could be false in the env, super_admin is always gated.
    const req = makeReq({ role: "super_admin", totpVerified: false });
    const hook = requireAuth({ roles: ["super_admin"] });
    await expect(hook(req as never, {} as never)).rejects.toMatchObject({
      name: "AuthnError",
      message: "totp verification required",
    });
  });

  it("admin + totpVerified=false → requireAuth also throws (MFA_REQUIRED=true default in tests)", async () => {
    const req = makeReq({ role: "admin", totpVerified: false });
    const hook = requireAuth({ roles: ["admin"] });
    await expect(hook(req as never, {} as never)).rejects.toMatchObject({
      name: "AuthnError",
    });
  });

  it("non-super_admin session with super_admin role gate → AuthzError", async () => {
    const req = makeReq({ role: "admin", totpVerified: true });
    const hook = requireAuth({ roles: ["super_admin"] });
    await expect(hook(req as never, {} as never)).rejects.toMatchObject({
      name: "AuthzError",
    });
  });

  it("no session → requireAuth throws AuthnError", async () => {
    const req = { session: undefined };
    const hook = requireAuth({ roles: ["super_admin"] });
    await expect(hook(req as never, {} as never)).rejects.toMatchObject({
      name: "AuthnError",
      message: "authentication required",
    });
  });
});
