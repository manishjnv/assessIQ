/**
 * EXP-25 part b: loading the bundled subject-map twice leaves the node counts equal (the upsert is idempotent).
 * postgres:16 testcontainer. Same scaffold as exam-blueprints.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { loadFrameworkSeed } from "../framework-seeds.js";

let container: StartedTestContainer;
let url = "";
const userP = randomUUID();

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_test" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_test`;
  await sup((c) => applyAllMigrations(c));
  await setPoolForTesting(url);
  await sup(async (c) => {
    const tP = (await c.query(`SELECT id FROM tenants WHERE slug='platform'`)).rows[0].id;
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'p-exp25b@x.io','Admin','admin','active')`, [userP, tP]);
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

const counts = () => sup(async (c) => (await c.query(
  `SELECT n.kind, count(*)::int AS n FROM taxonomy_nodes n JOIN frameworks f ON f.id = n.framework_id
    WHERE f.slug = 'subject-map' GROUP BY n.kind ORDER BY n.kind`)).rows as Array<{ kind: string; n: number }>);

describe("subject-map load", () => {
  it("loads once, loads again, and the counts stay equal", async () => {
    await loadFrameworkSeed(userP, "subject-map");
    const first = await counts();
    await loadFrameworkSeed(userP, "subject-map");
    const second = await counts();
    expect(second).toEqual(first);
    const by = Object.fromEntries(first.map((r) => [r.kind, r.n]));
    expect(by["subject"]).toBe(5);
    expect(by["outcome"]).toBe(125);
    expect(by["unit"]).toBe(37); // 25 from part A, 12 new in part b
  });
});
