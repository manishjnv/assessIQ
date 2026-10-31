/**
 * PATCH /api/admin/assessments/:id/result-release — per-assessment result release override (migration 0285).
 * Real Postgres (testcontainers); stubbed admin gate (tenant switchable per request via x-test-tenant).
 *
 * Covers: set 'auto' stamps auto_since, 'manual' / null clear it, any status; an unchanged value is a no-op
 * (no audit row, auto_since not moved); audit row assessment.release_mode.set with before/after; the table CHECK
 * (auto_since only with mode 'auto'); tenant B can neither read nor set tenant A's override (404); the admin
 * detail read carries the override and the SP11 turnaround text; body validation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { AppError, config } from "@assessiq/core";
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

async function newAssessment(status = "draft"): Promise<string> {
  const id = randomUUID();
  await sql(
    `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, randomize, opens_at, settings, created_by)
     VALUES ($1, $2, $3, $4, 1, 'Release override', $5, 3, false, now() + interval '1 hour', '{}'::jsonb, $6)`,
    [id, tenants.A, packId, levelId, status, admins.A],
  );
  return id;
}

const patch = (id: string, body: unknown, tenant: "A" | "B" = "A") =>
  app.inject({
    method: "PATCH",
    url: `/api/admin/assessments/${id}/result-release`,
    headers: { "x-test-tenant": tenant, "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
const detail = (id: string, tenant: "A" | "B" = "A") =>
  app.inject({ method: "GET", url: `/api/admin/assessments/${id}`, headers: { "x-test-tenant": tenant } });
const row = (id: string) =>
  sql(`SELECT result_release_mode AS mode, result_release_auto_since AS since FROM assessments WHERE id = $1`, [id]).then((r) => r[0]);
const audits = (id: string) =>
  sql(`SELECT actor_user_id::text AS actor, before, after FROM audit_log WHERE entity_id = $1 AND action = 'assessment.release_mode.set' ORDER BY at`, [id]);

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_relmode_test" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(150_000)
    .start();
  containerUrl = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_relmode_test`;

  await withSuperClient(async (client) => {
    await applyAllMigrations(client);
    await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_system`);
    await client.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
  });
  await setPoolForTesting(containerUrl);

  for (const k of ["A", "B"] as const) {
    await sql(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`, [tenants[k], `rel-${k}`, `Tenant ${k}`]);
    await sql(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [tenants[k]]);
    await sql(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1, $2, $3, 'Admin', 'admin', 'active')`,
      [admins[k], tenants[k], `admin-${k}@example.com`],
    );
  }
  packId = randomUUID();
  levelId = randomUUID();
  await sql(
    `INSERT INTO question_packs (id, tenant_id, slug, name, domain, created_by) VALUES ($1, $2, 'rel-pack', 'Pack', 'soc', $3)`,
    [packId, tenants.A, admins.A],
  );
  await sql(
    `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count) VALUES ($1, $2, 1, 'L1', 30, 3)`,
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

describe("PATCH /api/admin/assessments/:id/result-release", () => {
  it("a new assessment inherits the organisation default (mode NULL, no auto_since)", async () => {
    const id = await newAssessment();
    expect(await row(id)).toEqual({ mode: null, since: null });
  });

  it("'auto' stamps auto_since = now() and works after publish; 'manual' and null clear it; each change writes one audit row with before/after", async () => {
    const id = await newAssessment("published");

    const auto = await patch(id, { result_release_mode: "auto" });
    expect(auto.statusCode).toBe(200);
    expect(auto.json().result_release_mode).toBe("auto");
    const afterAuto = await row(id);
    expect(afterAuto.mode).toBe("auto");
    expect(afterAuto.since).toBeInstanceOf(Date);

    const manual = await patch(id, { result_release_mode: "manual" });
    expect(manual.statusCode).toBe(200);
    expect(await row(id)).toEqual({ mode: "manual", since: null });

    const inherit = await patch(id, { result_release_mode: null });
    expect(inherit.statusCode).toBe(200);
    expect(await row(id)).toEqual({ mode: null, since: null });

    const a = await audits(id);
    expect(a.map((r) => [r.before.result_release_mode, r.after.result_release_mode])).toEqual([
      [null, "auto"],
      ["auto", "manual"],
      ["manual", null],
    ]);
    expect(a.every((r) => r.actor === admins.A)).toBe(true);
  });

  it("an unchanged value is a no-op: no audit row, auto_since does not move", async () => {
    const id = await newAssessment();
    await patch(id, { result_release_mode: "auto" });
    const first = await row(id);
    expect(await audits(id)).toHaveLength(1);

    const again = await patch(id, { result_release_mode: "auto" });
    expect(again.statusCode).toBe(200);
    expect((await row(id)).since).toEqual(first.since);
    expect(await audits(id)).toHaveLength(1);

    const fresh = await newAssessment();
    const nullToNull = await patch(fresh, { result_release_mode: null });
    expect(nullToNull.statusCode).toBe(200);
    expect(await audits(fresh)).toHaveLength(0);
  });

  it("auto -> manual -> auto moves auto_since forward (results ready in between are not released retroactively)", async () => {
    const id = await newAssessment();
    await patch(id, { result_release_mode: "auto" });
    const s1 = (await row(id)).since as Date;
    await patch(id, { result_release_mode: "manual" });
    await patch(id, { result_release_mode: "auto" });
    const s2 = (await row(id)).since as Date;
    expect(s2.getTime()).toBeGreaterThan(s1.getTime());
  });

  it("the admin detail read carries the override and the turnaround text from config (read only)", async () => {
    const id = await newAssessment();
    await patch(id, { result_release_mode: "manual" });
    const res = await detail(id);
    expect(res.statusCode).toBe(200);
    expect(res.json().result_release_mode).toBe("manual");
    expect(res.json().evaluation_turnaround_text).toBe(config.EVALUATION_TURNAROUND_TEXT);
  });

  it("tenant B cannot read or set tenant A's override (404); nothing changes, nothing audited", async () => {
    const id = await newAssessment();
    const set = await patch(id, { result_release_mode: "auto" }, "B");
    expect(set.statusCode).toBe(404);
    const read = await detail(id, "B");
    expect(read.statusCode).toBe(404);
    expect(await row(id)).toEqual({ mode: null, since: null });
    expect(await audits(id)).toHaveLength(0);
  });

  it("rejects a bad body (422/400) and an unknown assessment (404)", async () => {
    const id = await newAssessment();
    for (const body of [{ result_release_mode: "sometimes" }, {}, { result_release_mode: "auto", extra: 1 }, { result_release_mode: undefined }]) {
      const res = await patch(id, body);
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    }
    expect(await row(id)).toEqual({ mode: null, since: null });
    expect((await patch(randomUUID(), { result_release_mode: "auto" })).statusCode).toBe(404);
  });

  it("the CHECK rejects auto_since without mode 'auto', and a mode outside manual/auto", async () => {
    const id = await newAssessment();
    await expect(sql(`UPDATE assessments SET result_release_auto_since = now() WHERE id = $1`, [id])).rejects.toThrow(/assessments_release_since_chk/);
    await expect(sql(`UPDATE assessments SET result_release_mode = 'manual', result_release_auto_since = now() WHERE id = $1`, [id])).rejects.toThrow(/assessments_release_since_chk/);
    await expect(sql(`UPDATE assessments SET result_release_mode = 'sometimes' WHERE id = $1`, [id])).rejects.toThrow();
  });
});
