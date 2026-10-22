/**
 * GATE-8 A2-1/A2-2 (migration 0244): DELETE policies exist under RLS.
 * Real Postgres (testcontainers). A tenant deletes its own webhook endpoint, never another tenant's.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool, withTenant } from "@assessiq/tenancy";

let container: StartedTestContainer;
let url: string;
const A = randomUUID();
const B = randomUUID();
const epA = randomUUID();
const epB = randomUUID();

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
  try {
    await applyAllMigrations(c);
    await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await c.query(`INSERT INTO tenants (id,name,slug) VALUES ($1,'A','a-rls'),($2,'B','b-rls')`, [A, B]);
    for (const [id, t] of [[epA, A], [epB, B]] as const) {
      await c.query(
        `INSERT INTO webhook_endpoints (id,tenant_id,name,url,secret_enc,events) VALUES ($1,$2,'e','https://example.com/h','x','{audit.*}')`,
        [id, t],
      );
    }
  } finally {
    await c.end();
  }
  await setPoolForTesting(url);
}, 180_000);

afterAll(async () => {
  await closePool();
  await container?.stop();
});

describe("webhook_endpoints DELETE policy", () => {
  it("does not delete another tenant's endpoint", async () => {
    const r = await withTenant(A, (c) => c.query(`DELETE FROM webhook_endpoints WHERE id = $1`, [epB]));
    expect(r.rowCount).toBe(0);
  });
  it("deletes the tenant's own endpoint", async () => {
    const r = await withTenant(A, (c) => c.query(`DELETE FROM webhook_endpoints WHERE id = $1`, [epA]));
    expect(r.rowCount).toBe(1);
  });
});
