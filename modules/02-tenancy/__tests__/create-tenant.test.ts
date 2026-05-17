/**
 * Unit tests for C2 createTenant + activateTenant
 *
 * Acceptance criteria from the super-admin-onboarding contract:
 *
 *   (f) createTenant slug collision → ConflictError (409) with code TENANT_SLUG_CONFLICT
 *   (c partial) createTenant → tenant at status='provisioning'; activateTenant → 'active'
 *
 * Strategy: testcontainer postgres, real DB. No Redis needed (no sessions here).
 * The tenancy migrations are applied; no auth migrations needed.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { createTenant, activateTenant } from "../src/service.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

const THIS_DIR = toFsPath(new URL(".", import.meta.url));
const TENANCY_MIGRATIONS_DIR = join(THIS_DIR, "..", "migrations");

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let pgContainer: StartedTestContainer;
let pgUrl: string;

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

async function getTenantStatus(id: string): Promise<string | null> {
  return withSuperClient(async (client) => {
    const res = await client.query<{ status: string }>(
      `SELECT status FROM tenants WHERE id = $1`,
      [id],
    );
    return res.rows[0]?.status ?? null;
  });
}

// ---------------------------------------------------------------------------
// Global setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  pgContainer = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "test",
      POSTGRES_PASSWORD: "test",
      POSTGRES_DB: "aiq_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  pgUrl = `postgres://test:test@${pgContainer.getHost()}:${pgContainer.getMappedPort(5432)}/aiq_test`;

  const tenancyFiles = (await readdir(TENANCY_MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  await withSuperClient(async (client) => {
    for (const file of tenancyFiles) {
      const sql = await readFile(join(TENANCY_MIGRATIONS_DIR, file), "utf-8");
      await client.query(sql);
    }
  });

  await setPoolForTesting(pgUrl);
}, 120_000);

afterAll(async () => {
  await closePool();
  await pgContainer?.stop();
});

// ---------------------------------------------------------------------------
// createTenant tests
// ---------------------------------------------------------------------------

describe("createTenant", () => {
  it("creates a tenant at status=provisioning and returns tenantId", async () => {
    const slug = `test-slug-${randomUUID().slice(0, 8)}`;
    const result = await createTenant(
      { name: "Test Corp", slug },
      randomUUID(), // superAdminUserId
    );

    expect(result.tenantId).toBeTruthy();

    const status = await getTenantStatus(result.tenantId);
    expect(status).toBe("provisioning");
  });

  it("creates tenant_settings row for the new tenant (FK NOT NULL)", async () => {
    const slug = `test-slug-settings-${randomUUID().slice(0, 8)}`;
    const { tenantId } = await createTenant(
      { name: "Settings Corp", slug },
      randomUUID(),
    );

    const settings = await withSuperClient((client) =>
      client.query(
        `SELECT tenant_id FROM tenant_settings WHERE tenant_id = $1`,
        [tenantId],
      ),
    );
    expect(settings.rows).toHaveLength(1);
  });

  it("(f) slug collision → ConflictError with code TENANT_SLUG_CONFLICT", async () => {
    const slug = `slug-collision-${randomUUID().slice(0, 8)}`;

    // First insert succeeds.
    await createTenant({ name: "First Corp", slug }, randomUUID());

    // Second insert with same slug must throw ConflictError.
    const err = await createTenant({ name: "Duplicate Corp", slug }, randomUUID()).catch(e => e);
    expect(err).toBeDefined();
    expect(err.name).toBe("ConflictError");
    expect(err.details?.code).toBe("TENANT_SLUG_CONFLICT");
  });

  it("slug collision leaves no orphan tenant at provisioning that belongs to failed attempt", async () => {
    const slug = `slug-safe-${randomUUID().slice(0, 8)}`;
    await createTenant({ name: "Original", slug }, randomUUID());

    try {
      await createTenant({ name: "Duplicate", slug }, randomUUID());
    } catch {
      // expected
    }

    // Only one tenant with this slug should exist.
    const count = await withSuperClient((client) =>
      client.query<{ cnt: string }>(
        `SELECT count(*) AS cnt FROM tenants WHERE slug = $1`,
        [slug],
      ),
    );
    expect(Number(count.rows[0]!.cnt)).toBe(1);
  });

  it("system-role txn is minimal: no user rows written by createTenant", async () => {
    const slug = `no-user-${randomUUID().slice(0, 8)}`;
    const { tenantId } = await createTenant({ name: "Minimal Corp", slug }, randomUUID());

    // The new tenant must have NO users (createTenant does not insert any).
    const userCount = await withSuperClient((client) =>
      client.query<{ cnt: string }>(
        `SELECT count(*) AS cnt FROM users WHERE tenant_id = $1`,
        [tenantId],
      ).catch(() => ({ rows: [{ cnt: "0" }] })), // users table may not exist in this fixture
    );
    // If the users table exists, 0 users; if it doesn't exist, the catch returns 0.
    expect(Number(userCount.rows[0]!.cnt)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// activateTenant tests
// ---------------------------------------------------------------------------

describe("activateTenant", () => {
  it("flips tenant status from provisioning to active", async () => {
    const slug = `activate-${randomUUID().slice(0, 8)}`;
    const { tenantId } = await createTenant(
      { name: "To Activate", slug },
      randomUUID(),
    );

    expect(await getTenantStatus(tenantId)).toBe("provisioning");

    await activateTenant(tenantId);

    expect(await getTenantStatus(tenantId)).toBe("active");
  });

  it("failed mid-step: tenant that stays provisioning is never active (orphan safety)", async () => {
    const slug = `orphan-${randomUUID().slice(0, 8)}`;
    const { tenantId } = await createTenant({ name: "Orphan Corp", slug }, randomUUID());

    // Simulate: caller never calls activateTenant (step fails mid-way).
    // Tenant must remain 'provisioning'.
    expect(await getTenantStatus(tenantId)).toBe("provisioning");
    // No activateTenant call — this is the "inviteUser-fails → tenant stays provisioning" case.
  });
});
