/**
 * GET /api/admin/assessments/:id returns pack_domain (question_packs.domain) — Z-129.
 * Read-only field; the sections editor on the edit card uses it to lock the subject.
 * Real Postgres (testcontainers); stubbed admin gate. Same setup as integrity-route.test.ts.
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
const packId = randomUUID();
const levelId = randomUUID();

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

async function newAssessment(): Promise<string> {
  const id = randomUUID();
  await sql(
    `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, randomize, opens_at, settings, created_by)
     VALUES ($1, $2, $3, $4, 1, 'Pack domain test', 'draft', 3, false, now() + interval '1 hour', '{}'::jsonb, $5)`,
    [id, tenants.A, packId, levelId, admins.A],
  );
  return id;
}

const get = (id: string, tenant: "A" | "B" = "A") =>
  app.inject({ method: "GET", url: `/api/admin/assessments/${id}`, headers: { "x-test-tenant": tenant } });

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_pack_domain_test" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(150_000)
    .start();
  containerUrl = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_pack_domain_test`;

  await withSuperClient(async (client) => {
    await applyAllMigrations(client);
    await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_system`);
    await client.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
  });
  await setPoolForTesting(containerUrl);

  for (const k of ["A", "B"] as const) {
    await sql(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`, [tenants[k], `pd-${k}`, `Tenant ${k}`]);
    await sql(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [tenants[k]]);
    await sql(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1, $2, $3, 'Admin', 'admin', 'active')`,
      [admins[k], tenants[k], `admin-pd-${k}@example.com`],
    );
  }
  await sql(
    `INSERT INTO question_packs (id, tenant_id, slug, name, domain, created_by)
     VALUES ($1, $2, 'pd-pack', 'Pack', 'aptitude', $3)`,
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

describe("GET /api/admin/assessments/:id pack_domain", () => {
  it("returns the pack's subject slug as a read-only field", async () => {
    const id = await newAssessment();
    const res = await get(id);
    expect(res.statusCode).toBe(200);
    expect(res.json().pack_domain).toBe("aptitude");
    expect(res.json().pack_name).toBe("Pack");
  });

  it("stays tenant-scoped (another tenant gets 404)", async () => {
    const id = await newAssessment();
    expect((await get(id, "B")).statusCode).toBe(404);
  });
});
