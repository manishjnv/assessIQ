/**
 * FUT-10: assessiq_system membership closure. Live Postgres, REAL two-login setup
 * (assessiq_app and assessiq_system both log in with passwords; no superuser SET ROLE).
 *
 *   a. before the revoke an app session can SET ROLE assessiq_system (documents the hole)
 *   b. after `REVOKE assessiq_system FROM assessiq_app` it cannot, nor SET SESSION AUTHORIZATION
 *   c. RESET ROLE from the app login does not escalate
 *   d. the app login sees no other tenant's rows without a tenant set
 *   e. withSystemRole through the system pool reads cross-tenant
 *   f. (after the step-2 swap) mixed pattern: system, then SET LOCAL ROLE assessiq_app + tenant GUC, back to system
 *   g. withSystemRoleDetached works inside withTenant and runs on the system pool
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, setSystemPoolForTesting, closePool, getPool } from "../pool.js";
import { withTenant, withSystemRole, withSystemRoleDetached } from "../with-tenant.js";

let container: StartedTestContainer;
let base: string;
let appUrl: string;
let sysUrl: string;
let A: string;
let B: string;

const login = (user: string, pw: string) => `postgres://${user}:${pw}@${base}/assessiq`;

async function asApp<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: appUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "assessiq", POSTGRES_PASSWORD: "pw", POSTGRES_DB: "assessiq" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  base = `${container.getHost()}:${container.getMappedPort(5432)}`;
  const su = new Client({ connectionString: login("assessiq", "pw") });
  await su.connect();
  await applyAllMigrations(su);
  await su.query("ALTER ROLE assessiq_app LOGIN NOINHERIT PASSWORD 'apppw'");
  await su.query("ALTER ROLE assessiq_system LOGIN NOINHERIT PASSWORD 'syspw'");
  A = randomUUID();
  B = randomUUID();
  for (const [id, slug] of [[A, "a"], [B, "b"]] as const) {
    await su.query("INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $2)", [id, slug]);
    await su.query("INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
  }
  await su.end();
  appUrl = login("assessiq_app", "apppw");
  sysUrl = login("assessiq_system", "syspw");
  await setPoolForTesting(appUrl);
  await setSystemPoolForTesting(sysUrl);
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
});

describe("assessiq_system membership (FUT-10)", () => {
  it("app login can read the table only per tenant, none without a tenant set", async () => {
    const n = await asApp(async (c) => (await c.query("SELECT count(*)::int AS n FROM tenant_settings")).rows[0].n);
    expect(n).toBe(0);
  });

  it("system pool through withSystemRole reads across tenants and logs in as assessiq_system", async () => {
    const out = await withSystemRole("test: cross-tenant read", async (c) => {
      const who = (await c.query("SELECT session_user AS s, current_user AS u")).rows[0];
      const n = (await c.query("SELECT count(*)::int AS n FROM tenant_settings")).rows[0].n;
      return { who, n };
    });
    expect(out.who).toEqual({ s: "assessiq_system", u: "assessiq_system" });
    expect(out.n).toBeGreaterThanOrEqual(2);
  });

  it("withSystemRoleDetached runs inside withTenant on its own system connection", async () => {
    const out = await withTenant(A, async () => {
      return withSystemRoleDetached("test: detached", async (c) => {
        const s = (await c.query("SELECT session_user AS s")).rows[0].s;
        const n = (await c.query("SELECT count(*)::int AS n FROM tenant_settings")).rows[0].n;
        return { s, n };
      });
    });
    expect(out.s).toBe("assessiq_system");
    expect(out.n).toBeGreaterThanOrEqual(2);
  });

  it("role does not leak across pool checkouts (SET LOCAL dies with the tx)", async () => {
    await withTenant(A, async () => 1);
    await withSystemRole("test: leak", async () => 1);
    const app = getPool();
    for (let i = 0; i < 3; i++) {
      const r = await app.query("SELECT current_user AS u");
      expect(r.rows[0].u).toBe("assessiq_app");
    }
  });

  it("BEFORE the revoke the app login can SET ROLE assessiq_system (the hole)", async () => {
    const who = await asApp(async (c) => {
      await c.query("SET ROLE assessiq_system");
      return (await c.query("SELECT current_user AS u")).rows[0].u;
    });
    expect(who).toBe("assessiq_system");
  });

  it("AFTER the revoke the app login cannot escalate; withSystemRole still works", async () => {
    const su = new Client({ connectionString: login("assessiq", "pw") });
    await su.connect();
    await su.query("BEGIN; REVOKE assessiq_system FROM assessiq_app; GRANT assessiq_app TO assessiq_system; COMMIT");
    await su.end();

    await asApp(async (c) => {
      await expect(c.query("SET ROLE assessiq_system")).rejects.toThrow(/permission denied/);
      await c.query("BEGIN");
      await expect(c.query("SET LOCAL ROLE assessiq_system")).rejects.toThrow(/permission denied/);
      await c.query("ROLLBACK");
      await expect(c.query("SET SESSION AUTHORIZATION assessiq_system")).rejects.toThrow(/permission denied/);
      await c.query("RESET ROLE");
      expect((await c.query("SELECT current_user AS u, session_user AS s")).rows[0]).toEqual({ u: "assessiq_app", s: "assessiq_app" });
      expect((await c.query("SELECT count(*)::int AS n FROM tenant_settings")).rows[0].n).toBe(0);
    });

    const n = await withSystemRole("test: after revoke", async (c) =>
      (await c.query("SELECT count(*)::int AS n FROM tenant_settings")).rows[0].n,
    );
    expect(n).toBeGreaterThanOrEqual(2);
    // tenant path unchanged
    const own = await withTenant(A, async (c) => (await c.query("SELECT count(*)::int AS n FROM tenant_settings")).rows[0].n);
    expect(own).toBe(1);
  });

  it("mixed pattern: system, then app role with tenant GUC, then back to system", async () => {
    const out = await withSystemRole("test: mixed", async (c) => {
      await c.query("SET LOCAL ROLE assessiq_app");
      await c.query("SELECT set_config('app.current_tenant', $1, true)", [A]);
      const own = (await c.query("SELECT count(*)::int AS n FROM tenant_settings")).rows[0].n;
      await c.query("RESET ROLE");
      const all = (await c.query("SELECT count(*)::int AS n FROM tenant_settings")).rows[0].n;
      return { own, all };
    });
    expect(out.own).toBe(1);
    expect(out.all).toBeGreaterThanOrEqual(2);
  });
});
