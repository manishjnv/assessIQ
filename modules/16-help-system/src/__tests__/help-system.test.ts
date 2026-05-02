/**
 * Integration tests for modules/16-help-system
 *
 * Uses a postgres:16-alpine testcontainer so the full RLS + assessiq_app role
 * stack and the nullable-tenant help_content policies are exercised against a
 * real Postgres instance.
 *
 * Container is started ONCE in beforeAll and torn down in afterAll.
 *
 * Migration order:
 *   02-tenancy: 0001_tenants.sql, 0002_rls_helpers.sql, 0003_tenants_rls.sql
 *   16-help-system: 0010_help_content.sql, 0011_seed_help_content.sql
 *
 * Path arithmetic (RCA 2026-05-01 — W4 test path off-by-one):
 *   THIS_DIR = modules/16-help-system/src/__tests__/
 *   1 ..  →  modules/16-help-system/src/
 *   2 ..  →  modules/16-help-system/          ← MODULE_ROOT
 *   (NOT 3 ..)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client, Pool } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { setPoolForTesting, closePool, withTenant } from "@assessiq/tenancy";
import {
  getHelpKey,
  upsertHelpForTenant,
  shouldSampleHelpEvent,
} from "../service.js";

// ---------------------------------------------------------------------------
// Path helpers — Windows-safe (strips leading /E:/ from import.meta.url)
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

// modules/16-help-system/src/__tests__/
const THIS_DIR = toFsPath(new URL(".", import.meta.url));
// 1 ..  →  modules/16-help-system/src/
// 2 ..  →  modules/16-help-system/
const MODULE_ROOT = join(THIS_DIR, "..", "..");
const HELP_MIGRATIONS = join(MODULE_ROOT, "migrations");
const TENANCY_MIGRATIONS = join(MODULE_ROOT, "..", "02-tenancy", "migrations");

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let container: StartedTestContainer;
let pgUrl: string;

// appPool: connects as assessiq_app (no password in testcontainer — trust auth
// is assumed since assessiq_app was created with LOGIN but no PASSWORD, and
// testcontainers runs on localhost). This pool is used exclusively for RLS
// INSERT-denial tests (Block 3) where we need REAL assessiq_app connections:
// RLS does not apply to superusers even after SET LOCAL ROLE, because the
// session user remains a superuser. A native assessiq_app connection enforces
// the INSERT policy for real.
let appPool: Pool;

// Fixed tenant UUIDs for deterministic assertions.
const TENANT_A = "00000000-0000-0000-0000-00000000a000";
const TENANT_B = "00000000-0000-0000-0000-00000000b000";

// ---------------------------------------------------------------------------
// Superuser helper — bypasses RLS for seeding / verification
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
// App-role helper — real assessiq_app connection; RLS INSERT policy fires
// ---------------------------------------------------------------------------

async function withAppClientTx<T>(
  tenantId: string,
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const pc = await appPool.connect();
  try {
    await pc.query("BEGIN");
    await pc.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    const result = await fn(pc);
    await pc.query("COMMIT");
    return result;
  } catch (err) {
    await pc.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    pc.release();
  }
}

// ---------------------------------------------------------------------------
// Global setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Path-arithmetic guard: surface drift at module-load time, not as opaque ENOENT.
  if (!existsSync(TENANCY_MIGRATIONS)) {
    throw new Error(
      `02-tenancy migrations not found at ${TENANCY_MIGRATIONS} — likely path arithmetic drift`,
    );
  }
  if (!existsSync(HELP_MIGRATIONS)) {
    throw new Error(
      `16-help-system migrations not found at ${HELP_MIGRATIONS} — likely path arithmetic drift`,
    );
  }

  // 1. Start postgres:16-alpine (requires NULLS NOT DISTINCT support = Postgres 15+).
  //    postgres:16-alpine satisfies this.
  container = await new GenericContainer("postgres:16-alpine")
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
    .start();

  pgUrl = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_test`;

  // 2. Apply migrations via superuser (bypasses RLS).
  const tenancyFiles = (await readdir(TENANCY_MIGRATIONS))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const helpFiles = (await readdir(HELP_MIGRATIONS))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  await withSuperClient(async (client) => {
    // 02-tenancy migrations first (creates roles, tenants table, RLS helpers).
    for (const file of tenancyFiles) {
      const sql = await readFile(join(TENANCY_MIGRATIONS, file), "utf-8");
      await client.query(sql);
    }
    // 16-help-system migrations (table + RLS policies + 25-row global seed).
    for (const file of helpFiles) {
      const sql = await readFile(join(HELP_MIGRATIONS, file), "utf-8");
      await client.query(sql);
    }

    // Seed two test tenants + their settings (superuser bypass, no RLS issue).
    await client.query(
      `INSERT INTO tenants (id, slug, name, status) VALUES
         ($1, 'tenant-a', 'Tenant A', 'active'),
         ($2, 'tenant-b', 'Tenant B', 'active')`,
      [TENANT_A, TENANT_B],
    );
    await client.query(
      `INSERT INTO tenant_settings (tenant_id) VALUES ($1), ($2)`,
      [TENANT_A, TENANT_B],
    );
  });

  // 3. Point the @assessiq/tenancy pool singleton at the testcontainer.
  //    withTenant (and service functions) will use this pool.
  //    The pool connects as the superuser; withTenant adds SET LOCAL ROLE assessiq_app
  //    which re-engages RLS for SELECT/UPDATE. For INSERT-policy testing (Block 3)
  //    we need a separate native assessiq_app pool (see appPool below), because
  //    RLS INSERT WITH CHECK is not enforced for superuser session users even after
  //    SET LOCAL ROLE — the session_user check in pg bypasses RLS for superusers.
  await setPoolForTesting(pgUrl);

  // 4. Build an assessiq_app pool for INSERT-policy denial tests.
  //    assessiq_app was created with no password in the migration (production
  //    sets it from a Docker secret post-migration). For testcontainers we set
  //    a throwaway password via the superuser so pg's SCRAM auth doesn't fail.
  const APP_TEST_PASSWORD = "testpw-assessiq-app";
  await withSuperClient((client) =>
    client.query(`ALTER ROLE assessiq_app PASSWORD '${APP_TEST_PASSWORD}'`),
  );

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  appPool = new Pool({
    host,
    port,
    user: "assessiq_app",
    password: APP_TEST_PASSWORD,
    database: "aiq_test",
    max: 2,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
  });
}, 90_000);

afterAll(async () => {
  await closePool();
  await appPool?.end();
  await container?.stop();
});

// ---------------------------------------------------------------------------
// Cleanup helper — remove per-tenant overrides between tests that create them.
// ---------------------------------------------------------------------------

async function deleteTenantOverrides(): Promise<void> {
  await withSuperClient((client) =>
    client.query("DELETE FROM help_content WHERE tenant_id IS NOT NULL"),
  );
}

// ---------------------------------------------------------------------------
// Block 1 — RLS visibility (nullable-tenant variant)
// ---------------------------------------------------------------------------

describe("Block 1 — RLS visibility", () => {
  beforeEach(async () => {
    await deleteTenantOverrides();
  });

  it("tenant A sees all global rows (25 from seed)", async () => {
    const count = await withTenant(TENANT_A, async (client) => {
      const res = await client.query<{ count: string }>(
        "SELECT COUNT(*) FROM help_content WHERE tenant_id IS NULL AND status = 'active'",
      );
      return Number(res.rows[0]?.count ?? 0);
    });
    expect(count).toBe(25);
  });

  it("tenant B also sees all global rows (25 from seed)", async () => {
    const count = await withTenant(TENANT_B, async (client) => {
      const res = await client.query<{ count: string }>(
        "SELECT COUNT(*) FROM help_content WHERE tenant_id IS NULL AND status = 'active'",
      );
      return Number(res.rows[0]?.count ?? 0);
    });
    expect(count).toBe(25);
  });

  it("tenant A override is visible to tenant A", async () => {
    await upsertHelpForTenant(TENANT_A, "admin.users.role", {
      audience: "admin",
      locale: "en",
      shortText: "TENANT A OVERRIDE",
      longMd: null,
    });

    const result = await getHelpKey(TENANT_A, "admin.users.role", "en");
    expect(result).not.toBeNull();
    expect(result?.shortText).toBe("TENANT A OVERRIDE");
  });

  it("tenant B does NOT see tenant A's override — sees global instead", async () => {
    await upsertHelpForTenant(TENANT_A, "admin.users.role", {
      audience: "admin",
      locale: "en",
      shortText: "TENANT A OVERRIDE",
      longMd: null,
    });

    const result = await getHelpKey(TENANT_B, "admin.users.role", "en");
    expect(result).not.toBeNull();
    // Tenant B must see the global seed content, not A's override.
    expect(result?.shortText).toBe(
      "admin = full access · reviewer = grade and override only · candidate = take assessments only.",
    );
  });

  it("globals are visible to anonymous (no tenant context)", async () => {
    const result = await getHelpKey(null, "admin.users.role", "en");
    expect(result).not.toBeNull();
    expect(result?.shortText).toBe(
      "admin = full access · reviewer = grade and override only · candidate = take assessments only.",
    );
  });

  it("tenant A override is NOT visible to anonymous — anonymous sees global", async () => {
    await upsertHelpForTenant(TENANT_A, "admin.users.role", {
      audience: "admin",
      locale: "en",
      shortText: "TENANT A OVERRIDE",
      longMd: null,
    });

    const result = await getHelpKey(null, "admin.users.role", "en");
    expect(result).not.toBeNull();
    // Anonymous read uses withGlobalsOnly → no tenant GUC → only tenant_id IS NULL visible.
    expect(result?.shortText).toBe(
      "admin = full access · reviewer = grade and override only · candidate = take assessments only.",
    );
  });
});

// ---------------------------------------------------------------------------
// Block 2 — Locale fallback (decision #17)
// ---------------------------------------------------------------------------

describe("Block 2 — Locale fallback", () => {
  it("unknown locale falls back to 'en' with _fallback: true", async () => {
    const result = await getHelpKey(null, "candidate.attempt.flag", "hi-IN");
    expect(result).not.toBeNull();
    expect(result?._fallback).toBe(true);
    // Must have returned the English content.
    expect(result?.locale).toBe("en");
  });

  it("existing 'en' locale does NOT carry _fallback flag", async () => {
    const result = await getHelpKey(null, "candidate.attempt.flag", "en");
    expect(result).not.toBeNull();
    // _fallback should be absent (undefined), not true.
    expect(result?._fallback).toBeUndefined();
  });

  it("truly missing key returns null", async () => {
    const result = await getHelpKey(null, "admin.does_not_exist", "en");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Block 3 — INSERT-policy denial
//
// These tests use appPool (native assessiq_app connections), NOT withTenant.
// Reason: pg.Pool connects as the superuser in tests. Even after SET LOCAL ROLE
// assessiq_app, the session_user is still the superuser, and Postgres does NOT
// apply RLS INSERT WITH CHECK to superuser session users (only FORCE ROW LEVEL
// SECURITY would override this, which is not set on help_content). The native
// assessiq_app pool has the app role as both session_user and current_user, so
// RLS INSERT policy fires correctly.
// ---------------------------------------------------------------------------

describe("Block 3 — INSERT-policy denial", () => {
  it("app role cannot insert a global row (tenant_id IS NULL) from a tenant context", async () => {
    await expect(
      withAppClientTx(TENANT_A, async (client) => {
        await client.query(
          `INSERT INTO help_content (tenant_id, key, audience, locale, short_text, version, status)
           VALUES (NULL, 'foo.bar.test', 'admin', 'en', 'forbidden global', 1, 'active')`,
        );
      }),
    ).rejects.toThrow(/violates row-level security|new row violates|42501|23514/i);
  });

  it("app role cannot insert into a different tenant's bucket", async () => {
    await expect(
      withAppClientTx(TENANT_A, async (client) => {
        // GUC is set to TENANT_A; trying to write TENANT_B's tenant_id should be denied.
        await client.query(
          `INSERT INTO help_content (tenant_id, key, audience, locale, short_text, version, status)
           VALUES ($1, 'foo.bar.cross', 'admin', 'en', 'cross-tenant inject', 1, 'active')`,
          [TENANT_B],
        );
      }),
    ).rejects.toThrow(/violates row-level security|new row violates|42501|23514/i);
  });
});

// ---------------------------------------------------------------------------
// Block 4 — Upsert versioning
// ---------------------------------------------------------------------------

describe("Block 4 — Upsert versioning", () => {
  beforeEach(async () => {
    await deleteTenantOverrides();
  });

  it("upsertHelp creates version 1 on first call", async () => {
    const entry = await upsertHelpForTenant(TENANT_A, "test.upsert.v1", {
      audience: "admin",
      locale: "en",
      shortText: "First version",
      longMd: null,
    });
    expect(entry.version).toBe(1);
  });

  it("upsertHelp bumps version to 2 on second call; both rows still present", async () => {
    const key = "test.upsert.bump";

    const v1 = await upsertHelpForTenant(TENANT_A, key, {
      audience: "admin",
      locale: "en",
      shortText: "Version one",
      longMd: null,
    });
    expect(v1.version).toBe(1);

    const v2 = await upsertHelpForTenant(TENANT_A, key, {
      audience: "admin",
      locale: "en",
      shortText: "Version two",
      longMd: null,
    });
    expect(v2.version).toBe(2);

    // Both rows should persist in the table (versioned history).
    const count = await withSuperClient(async (client) => {
      const res = await client.query<{ count: string }>(
        "SELECT COUNT(*) FROM help_content WHERE tenant_id = $1 AND key = $2",
        [TENANT_A, key],
      );
      return Number(res.rows[0]?.count ?? 0);
    });
    expect(count).toBe(2);
  });

  it("version is per (tenant_id, key, locale) — en and es are independent v1s", async () => {
    const key = "test.upsert.locale";

    const enEntry = await upsertHelpForTenant(TENANT_A, key, {
      audience: "admin",
      locale: "en",
      shortText: "English version",
      longMd: null,
    });
    expect(enEntry.version).toBe(1);

    const esEntry = await upsertHelpForTenant(TENANT_A, key, {
      audience: "admin",
      locale: "es",
      shortText: "Spanish version",
      longMd: null,
    });
    // es locale has no prior row for this (tenant, key) → starts at 1.
    expect(esEntry.version).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Block 5 — Telemetry sampler determinism
// ---------------------------------------------------------------------------

describe("Block 5 — Telemetry sampler determinism", () => {
  it("shouldSampleHelpEvent with sampleRate=0.0 always returns false (no jitter fires)", () => {
    // At sampleRate=0.0: threshold = floor(0.0 * 10) = 0, so bucket < 0 is never true.
    // Jitter: Math.random() < 0.0 * 0.1 = 0.0, also never true.
    // Result must be deterministically false for every key.
    const key = "candidate.attempt.flag";
    for (let i = 0; i < 100; i++) {
      expect(shouldSampleHelpEvent(key, 0.0)).toBe(false);
    }
  });

  it("shouldSampleHelpEvent with sampleRate=1.0 always returns true", () => {
    // At sampleRate=1.0: threshold = floor(1.0 * 10) = 10, bucket is [0..9] so always < 10.
    // Result must be deterministically true for every key.
    const key = "candidate.attempt.flag";
    for (let i = 0; i < 100; i++) {
      expect(shouldSampleHelpEvent(key, 1.0)).toBe(true);
    }
  });

  it("different keys distribute roughly evenly at sampleRate=0.5 (30%–70% acceptance)", () => {
    // 100 distinct keys → deterministic djb2 buckets spread across [0..9].
    // At sampleRate=0.5: threshold=5, so ~50% of bucket-space accepts.
    // Jitter adds at most sampleRate*0.1 = 5% additional acceptance probability.
    // Expect between 30% and 70% of keys to be sampled (loose bound, not flaky).
    const results = Array.from({ length: 100 }, (_, i) =>
      shouldSampleHelpEvent(`key.${i}`, 0.5),
    );
    const trueCount = results.filter(Boolean).length;
    expect(trueCount).toBeGreaterThanOrEqual(30);
    expect(trueCount).toBeLessThanOrEqual(70);
  });
});
