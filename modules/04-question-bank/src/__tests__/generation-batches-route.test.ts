/**
 * Route + RLS integration tests for /api/admin/generation-batches (E6).
 * postgres:16-alpine testcontainer; auth stubbed via a session-injecting hook.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { registerQuestionBankRoutes } from "../routes.js";

let container: StartedTestContainer;
let containerUrl: string;
const tenantA = randomUUID();
const tenantB = randomUUID();
const userA = randomUUID();
const userA2 = randomUUID();
const userB = randomUUID();
const [c1, c2, c3] = [randomUUID(), randomUUID(), randomUUID()];

async function withSuper<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: containerUrl });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

async function buildApp(tenantId: string, userId: string) {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (req) => {
    (req as unknown as { session: unknown }).session = { tenantId, userId };
  });
  await registerQuestionBankRoutes(app, { adminOnly: [], superAdminOnly: [] });
  await app.ready();
  return app;
}

const plan = (done: string[]) => ({
  domainId: randomUUID(),
  level: "L1",
  categories: [c1, c2, c3].map((id) => ({ categoryId: id, categoryName: id, count: 2, selectedTypes: ["mcq"] })),
  completedCategoryIds: done,
});

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_test" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  containerUrl = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_test`;
  await withSuper((c) => applyAllMigrations(c));
  await setPoolForTesting(containerUrl);
  await withSuper(async (c) => {
    for (const [id, slug] of [[tenantA, "ta"], [tenantB, "tb"]] as const) {
      await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$2)`, [id, slug]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
    }
    for (const [id, t, e] of [[userA, tenantA, "a@x.io"], [userA2, tenantA, "a2@x.io"], [userB, tenantB, "b@x.io"]] as const) {
      await c.query(
        `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Admin','admin','active')`,
        [id, t, e],
      );
    }
  });
}, 90_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

describe("generation-batches routes", () => {
  it("PUT upserts, never shrinks completed ids, GET active returns it, PATCH done clears it", async () => {
    const app = await buildApp(tenantA, userA);
    const id = randomUUID();

    expect((await app.inject({ method: "GET", url: "/api/admin/generation-batches/active" })).json()).toEqual({ batch: null });

    let r = await app.inject({ method: "PUT", url: `/api/admin/generation-batches/${id}`, payload: plan([c1]) });
    expect(r.statusCode).toBe(200);

    // Server-side progress (what admin-generate.ts does) then a stale client PUT with fewer ids.
    await withSuper((c) =>
      c.query(`UPDATE generation_batches SET completed_category_ids = '["${c1}","${c2}"]' WHERE id = $1`, [id]));
    r = await app.inject({ method: "PUT", url: `/api/admin/generation-batches/${id}`, payload: plan([c1]) });
    expect(r.json().batch.completedCategoryIds.sort()).toEqual([c1, c2].sort());

    const active = (await app.inject({ method: "GET", url: "/api/admin/generation-batches/active" })).json().batch;
    expect(active.id).toBe(id);

    expect((await app.inject({ method: "PATCH", url: `/api/admin/generation-batches/${id}`, payload: { status: "done" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/admin/generation-batches/active" })).json()).toEqual({ batch: null });
    await app.close();
  });

  it("rejects invalid id / body / status", async () => {
    const app = await buildApp(tenantA, userA);
    expect((await app.inject({ method: "PUT", url: "/api/admin/generation-batches/nope", payload: plan([]) })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: `/api/admin/generation-batches/${randomUUID()}`, payload: { categories: "x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: `/api/admin/generation-batches/${randomUUID()}`, payload: { status: "active" } })).statusCode).toBe(400);
    await app.close();
  });

  it("other user / other tenant cannot update or patch someone else's batch", async () => {
    const id = randomUUID();
    const a = await buildApp(tenantA, userA);
    await a.inject({ method: "PUT", url: `/api/admin/generation-batches/${id}`, payload: plan([]) });

    const sameTenant = await buildApp(tenantA, userA2);
    expect((await sameTenant.inject({ method: "PUT", url: `/api/admin/generation-batches/${id}`, payload: plan([c3]) })).statusCode).toBe(409);
    expect((await sameTenant.inject({ method: "PATCH", url: `/api/admin/generation-batches/${id}`, payload: { status: "dismissed" } })).statusCode).toBe(404);
    expect((await sameTenant.inject({ method: "GET", url: "/api/admin/generation-batches/active" })).json()).toEqual({ batch: null });

    const otherTenant = await buildApp(tenantB, userB);
    expect((await otherTenant.inject({ method: "PUT", url: `/api/admin/generation-batches/${id}`, payload: plan([c3]) })).statusCode).toBe(409);
    expect((await otherTenant.inject({ method: "PATCH", url: `/api/admin/generation-batches/${id}`, payload: { status: "dismissed" } })).statusCode).toBe(404);

    const row = await withSuper((c) => c.query(`SELECT status, completed_category_ids FROM generation_batches WHERE id=$1`, [id]));
    expect(row.rows[0]).toMatchObject({ status: "active", completed_category_ids: [] });
    await Promise.all([a.close(), sameTenant.close(), otherTenant.close()]);
  });
});
