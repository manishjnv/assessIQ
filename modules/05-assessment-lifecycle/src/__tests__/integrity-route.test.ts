/**
 * PATCH /api/admin/assessments/:id/integrity — merges only settings.integrity.
 * Real Postgres (testcontainers); stubbed admin gate (session switchable per request
 * via the x-test-tenant header). Same migration set as invitation-resend.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { AppError } from "@assessiq/core";
import { registerAssessmentLifecycleRoutes } from "../routes.js";

let container: StartedTestContainer;
let containerUrl: string;
let app: FastifyInstance;
const tenants = { A: randomUUID(), B: randomUUID() };
const admins = { A: randomUUID(), B: randomUUID() };
let packId: string;
let levelId: string;

async function withSuperClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: containerUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
const sql = (text: string, params: unknown[] = []) =>
  withSuperClient((c) => c.query(text, params)).then((r) => r.rows);

async function newAssessment(settings: Record<string, unknown>, status = "draft"): Promise<string> {
  const id = randomUUID();
  await sql(
    `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, randomize, opens_at, settings, created_by)
     VALUES ($1, $2, $3, $4, 1, 'Integrity test', $5, 3, false, now() + interval '1 hour', $6::jsonb, $7)`,
    [id, tenants.A, packId, levelId, status, JSON.stringify(settings), admins.A],
  );
  return id;
}

const patch = (id: string, body: unknown, tenant: "A" | "B" = "A") =>
  app.inject({
    method: "PATCH",
    url: `/api/admin/assessments/${id}/integrity`,
    headers: { "x-test-tenant": tenant, "content-type": "application/json" },
    payload: JSON.stringify(body),
  });

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_integrity_test" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(150_000)
    .start();
  containerUrl = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_integrity_test`;

  await withSuperClient(async (client) => {
    await applyAllMigrations(client);
    await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_system`);
    await client.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
  });
  await setPoolForTesting(containerUrl);

  for (const k of ["A", "B"] as const) {
    await sql(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`, [tenants[k], `int-${k}`, `Tenant ${k}`]);
    await sql(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [tenants[k]]);
    await sql(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1, $2, $3, 'Admin', 'admin', 'active')`,
      [admins[k], tenants[k], `admin-${k}@example.com`],
    );
  }
  packId = randomUUID();
  levelId = randomUUID();
  await sql(
    `INSERT INTO question_packs (id, tenant_id, slug, name, domain, created_by)
     VALUES ($1, $2, 'int-pack', 'Pack', 'soc', $3)`,
    [packId, tenants.A, admins.A],
  );
  await sql(
    `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count)
     VALUES ($1, $2, 1, 'L1', 30, 3)`,
    [levelId, packId],
  );

  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.toJson() });
    return reply.code(500).send({ error: { code: "INTERNAL", message: String(err) } });
  });
  await registerAssessmentLifecycleRoutes(app, {
    adminOnly: async (req) => {
      const k = (req.headers["x-test-tenant"] === "B" ? "B" : "A") as "A" | "B";
      (req as { session?: unknown }).session = { tenantId: tenants[k], userId: admins[k] };
    },
  });
}, 240_000);

afterAll(async () => {
  await app?.close();
  await closePool();
  if (container !== undefined) await container.stop();
});

describe("PATCH /api/admin/assessments/:id/integrity", () => {
  it("merges only integrity (blueprint + other keys kept), works after publish, writes one audit row", async () => {
    const blueprint = { criteria: [{ domain: "soc", count: 3 }] };
    const id = await newAssessment({ blueprint, extra: { keep: 1 }, integrity: { fullscreen: false } }, "published");

    const res = await patch(id, { fullscreen: true, block_copy_paste: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.integrity).toEqual({ fullscreen: true, block_copy_paste: true });

    const [row] = await sql(`SELECT settings, status FROM assessments WHERE id = $1`, [id]);
    expect(row.status).toBe("published");
    expect(row.settings).toEqual({ blueprint, extra: { keep: 1 }, integrity: { fullscreen: true, block_copy_paste: true } });

    const audit = await sql(
      `SELECT before, after, actor_user_id::text AS actor FROM audit_log WHERE entity_id = $1 AND action = 'assessment.updated'`,
      [id],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].actor).toBe(admins.A);
    expect(audit[0].before).toEqual({ integrity: { fullscreen: false } });
    expect(audit[0].after).toEqual({ integrity: { fullscreen: true, block_copy_paste: true } });
  });

  it("creates the integrity key when settings was empty", async () => {
    const id = await newAssessment({});
    expect((await patch(id, { fullscreen: false, block_copy_paste: true })).statusCode).toBe(200);
    const [row] = await sql(`SELECT settings FROM assessments WHERE id = $1`, [id]);
    expect(row.settings).toEqual({ integrity: { fullscreen: false, block_copy_paste: true } });
  });

  it("rejects unknown keys, missing keys and non-booleans with 400 and changes nothing", async () => {
    const id = await newAssessment({ integrity: { fullscreen: true } });
    for (const body of [
      { fullscreen: true, block_copy_paste: true, blueprint: {} },
      { fullscreen: true },
      { fullscreen: "yes", block_copy_paste: false },
    ]) {
      expect((await patch(id, body)).statusCode).toBe(400);
    }
    const [row] = await sql(`SELECT settings FROM assessments WHERE id = $1`, [id]);
    expect(row.settings).toEqual({ integrity: { fullscreen: true } });
  });

  it("another tenant gets 404 and nothing changes", async () => {
    const id = await newAssessment({ integrity: { fullscreen: false } });
    const res = await patch(id, { fullscreen: true, block_copy_paste: true }, "B");
    expect(res.statusCode).toBe(404);
    const [row] = await sql(`SELECT settings FROM assessments WHERE id = $1`, [id]);
    expect(row.settings).toEqual({ integrity: { fullscreen: false } });
  });
});
