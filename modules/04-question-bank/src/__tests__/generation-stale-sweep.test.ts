/** RW-94: sweepStaleGenerationAttempts flips old 'running' rows, leaves live and finished ones. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { withTenant } from "../../../02-tenancy/src/with-tenant.js";
import { sweepStaleGenerationAttempts } from "../service/generation-async.js";

let container: StartedTestContainer;
let url: string;
const tenant = randomUUID();
const admin = randomUUID();
const old = randomUUID();
const fresh = randomUUID();
const done = randomUUID();

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_test" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_test`;
  const c = new Client({ connectionString: url });
  await c.connect();
  await applyAllMigrations(c);
  await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'stale', 'Stale')`, [tenant]);
  await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [tenant]);
  await c.query(
    `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@example.com','A','admin','active')`,
    [admin, tenant],
  );
  const ins = (id: string, status: string, ago: string) =>
    c.query(
      `INSERT INTO generation_attempts (id, tenant_id, pack_id, level_id, user_id, count_requested, status, started_at)
       VALUES ($1,$2,$3,$4,$5,5,$6, now() - $7::interval)`,
      [id, tenant, randomUUID(), randomUUID(), admin, status, ago],
    );
  await ins(old, "running", "20 minutes");
  await ins(fresh, "running", "1 minute");
  await ins(done, "success", "20 minutes");
  await c.end();
  await setPoolForTesting(url);
}, 90_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

const row = (id: string) =>
  withTenant(tenant, async (c) => (await c.query(`SELECT status, error_code, finished_at, duration_ms FROM generation_attempts WHERE id = $1`, [id])).rows[0]);

describe("sweepStaleGenerationAttempts", () => {
  it("flips only the old running row, then is a no-op", async () => {
    const r = await sweepStaleGenerationAttempts();
    expect(r.ids).toEqual([old]);
    const o = await row(old);
    expect(o.status).toBe("failed");
    expect(o.error_code).toBe("AIG_STALE_AFTER_RESTART");
    expect(o.finished_at).not.toBeNull();
    expect(o.duration_ms).toBeGreaterThan(19 * 60_000);
    expect((await row(fresh)).status).toBe("running");
    expect((await row(done)).status).toBe("success");
    expect((await sweepStaleGenerationAttempts()).count).toBe(0);
  });

  it("clamps the threshold to 5 minutes", async () => {
    expect((await sweepStaleGenerationAttempts({ olderThanMs: 1 })).count).toBe(0);
    expect((await row(fresh)).status).toBe("running");
  });
});
