/** RW-48b: purgeArchivedTenants. Live Postgres. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../pool.js";
import { purgeArchivedTenants } from "../purge.js";

let container: StartedTestContainer;
let db: Client;
const NOW = new Date("2026-10-15T00:00:00Z");
const daysAgo = (d: number): string => new Date(NOW.getTime() - d * 86_400_000).toISOString();

async function mkTenant(slug: string, status: string, ageDays: number): Promise<{ t: string; u: string }> {
  const t = randomUUID();
  const u = randomUUID();
  await db.query(`INSERT INTO tenants (id, slug, name, status, updated_at) VALUES ($1,$2,$2,$3,$4)`, [t, slug, status, daysAgo(ageDays)]);
  await db.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [t]);
  await db.query(`INSERT INTO users (id, tenant_id, email, name, role) VALUES ($1,$2,$3,'U','candidate')`, [u, t, `${slug}@x.test`]);
  await db.query(
    `INSERT INTO audit_log (tenant_id, actor_user_id, actor_kind, action, entity_type) VALUES ($1,$2,'user','user.created','user')`,
    [t, u],
  );
  return { t, u };
}
const count = async (table: string, t: string): Promise<number> =>
  Number((await db.query(`SELECT count(*) FROM ${table} WHERE tenant_id = $1`, [t])).rows[0].count);

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "assessiq", POSTGRES_PASSWORD: "pw", POSTGRES_DB: "assessiq" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  const url = `postgres://assessiq:pw@${container.getHost()}:${container.getMappedPort(5432)}/assessiq`;
  db = new Client({ connectionString: url });
  await db.connect();
  await applyAllMigrations(db);
  setPoolForTesting(url);
}, 120_000);

afterAll(async () => {
  await closePool();
  await db?.end();
  if (container !== undefined) await container.stop();
});

describe("purgeArchivedTenants", () => {
  it("dry run (gate off) reports candidates and changes nothing", async () => {
    const old = await mkTenant("dry-old", "archived", 200);
    const r = await purgeArchivedTenants({ now: NOW });
    expect(r.dryRun).toBe(true);
    expect(r.tenants.map((x) => x.tenantId)).toContain(old.t);
    expect(await count("users", old.t)).toBe(1);
    expect((await db.query(`SELECT status FROM tenants WHERE id=$1`, [old.t])).rows[0].status).toBe("archived");
    await db.query(`UPDATE tenants SET status='active' WHERE id=$1`, [old.t]); // keep later tests clean
  });

  it("purges only archived >= 180d; keeps audit rows; one tenant.purged row each", async () => {
    const old = await mkTenant("old", "archived", 200);
    const young = await mkTenant("young", "archived", 179);
    const active = await mkTenant("active", "active", 400);
    // the seeded platform tenant (slug='platform') made archived + old must still be skipped
    const pid = (await db.query(`UPDATE tenants SET status='archived', updated_at=$1 WHERE slug='platform' RETURNING id`, [daysAgo(400)])).rows[0].id as string;
    await db.query(`INSERT INTO users (id, tenant_id, email, name, role) VALUES ($1,$2,'p@x.test','P','candidate')`, [randomUUID(), pid]);
    const platform = { t: pid };

    const r = await purgeArchivedTenants({ now: NOW, enabled: true, minDays: 10 }); // clamped to 180
    expect(r.minDays).toBe(180);
    expect(r.tenants.filter((x) => x.purged).map((x) => x.tenantId)).toEqual([old.t]);

    const tomb = (await db.query(`SELECT name, email, erased_at FROM users WHERE id=$1`, [old.u])).rows[0];
    expect(tomb.name).toMatch(/^deleted_user_/);
    expect(tomb.email).toMatch(/@erased\.assessiq\.local$/);
    expect(tomb.erased_at).not.toBeNull();
    expect(await count("tenant_settings", old.t)).toBe(0);
    expect((await db.query(`SELECT status FROM tenants WHERE id=$1`, [old.t])).rows[0].status).toBe("purged");
    expect((await db.query(`SELECT count(*) FROM audit_log WHERE tenant_id=$1 AND action='user.created'`, [old.t])).rows[0].count).toBe("1");
    const purged = await db.query(`SELECT after FROM audit_log WHERE tenant_id=$1 AND action='tenant.purged'`, [old.t]);
    expect(purged.rowCount).toBe(1);
    expect(purged.rows[0].after.counts.users_pseudonymised).toBe(1);

    for (const keep of [young, active, platform]) {
      expect(await count("users", keep.t)).toBeGreaterThanOrEqual(1);
      expect((await db.query(`SELECT count(*) FROM audit_log WHERE tenant_id=$1 AND action='tenant.purged'`, [keep.t])).rows[0].count).toBe("0");
    }
    // idempotent: purged tenants are not selected again
    expect((await purgeArchivedTenants({ now: NOW, enabled: true })).tenants).toHaveLength(0);
  });

  it("one tenant failing does not stop the sweep", async () => {
    const bad = await mkTenant("bad", "archived", 300);
    const good = await mkTenant("good", "archived", 300);
    // tenant-keyed table whose DELETE trigger raises: the purge of bad's tenant fails
    await db.query(`CREATE TABLE zz_block (tenant_id uuid)`);
    await db.query(`CREATE FUNCTION zz_deny() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'zz_deny'; END $$`);
    await db.query(`CREATE TRIGGER zz BEFORE DELETE ON zz_block FOR EACH ROW EXECUTE FUNCTION zz_deny()`);
    await db.query(`INSERT INTO zz_block VALUES ($1)`, [bad.t]);

    const r = await purgeArchivedTenants({ now: NOW, enabled: true });
    const byId = new Map(r.tenants.map((x) => [x.tenantId, x]));
    expect(byId.get(bad.t)!.purged).toBe(false);
    expect(byId.get(bad.t)!.error).toBeDefined();
    expect(byId.get(good.t)!.purged).toBe(true);
    // failed tenant rolled back whole: still archived, data intact, no purged audit row
    expect((await db.query(`SELECT status FROM tenants WHERE id=$1`, [bad.t])).rows[0].status).toBe("archived");
    expect((await db.query(`SELECT erased_at FROM users WHERE id=$1`, [bad.u])).rows[0].erased_at).toBeNull();
    expect((await db.query(`SELECT count(*) FROM audit_log WHERE tenant_id=$1 AND action='tenant.purged'`, [bad.t])).rows[0].count).toBe("0");
  });
});
