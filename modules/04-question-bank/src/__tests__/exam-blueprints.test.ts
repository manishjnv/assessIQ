/**
 * EXP-6: exam blueprints (migration 0201). postgres:16 testcontainer, auth stubbed by a session hook.
 * Covers: seed present once after re-running the migration, node linking, platform RLS (tenants read,
 * never write), super-admin-only routes, audit row, validation, update/delete.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool, withTenant } from "@assessiq/tenancy";
import { registerQuestionBankRoutes } from "../routes.js";
import { loadFrameworkSeed } from "../framework-seeds.js";
import { BlueprintBodySchema } from "../exam-blueprints.js";

const MIGRATION = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations", "0201_exp6_exam_blueprints.sql");
const SEED_ID = "5c0e6a10-0000-4000-8000-000000000001";

let container: StartedTestContainer;
let url: string;
let tP = "";
const tA = randomUUID();
const tB = randomUUID();
const userP = randomUUID();
const userA = randomUUID();

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function buildApp(tenantId: string, userId: string, role: "admin" | "super_admin") {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (req) => {
    (req as unknown as { session: unknown }).session = { tenantId, userId, role };
  });
  app.setErrorHandler((e, _req, reply) => reply.code((e as { status?: number }).status ?? 500).send({ message: (e as Error).message }));
  // The stub chains let everything through: the in-handler super_admin check is what is under test.
  await registerQuestionBankRoutes(app, { adminOnly: [], superAdminOnly: [] });
  await app.ready();
  return app;
}

const sectionBody = (over: Record<string, unknown> = {}) => ({
  name: "Part", question_count: 10, marks_per_question: 1, negative_marks_per_question: 0.25, ...over,
});
const bodyOf = (over: Record<string, unknown> = {}) => ({
  edition: "test-1", name: "Test exam", total_minutes: 30, verification_status: "unverified",
  sections: [sectionBody({ name: "A" }), sectionBody({ name: "B" })], ...over,
});

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
    tP = (await c.query(`SELECT id FROM tenants WHERE slug='platform'`)).rows[0].id;
    for (const [id, slug] of [[tA, "ta"], [tB, "tb"]] as const) {
      await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$2)`, [id, slug]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
    }
    for (const [id, t, e] of [[userP, tP, "p-exp6@x.io"], [userA, tA, "a-exp6@x.io"]] as const) {
      await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Admin','admin','active')`, [id, t, e]);
    }
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

describe("seed (SSC CGL Tier 1)", () => {
  it("exists exactly once after the migration runs twice more, with the verified figures", async () => {
    const sql = await readFile(MIGRATION, "utf-8");
    await sup(async (c) => { await c.query(sql); await c.query(sql); });
    const r = await sup(async (c) => ({
      heads: (await c.query(`SELECT * FROM exam_blueprints`)).rows,
      secs: (await c.query(`SELECT * FROM exam_blueprint_sections ORDER BY position`)).rows,
    }));
    expect(r.heads).toHaveLength(1);
    expect(r.heads[0]).toMatchObject({ id: SEED_ID, name: "SSC CGL Tier 1", total_minutes: 60, qualifying: true, verification_status: "verified", stage_node_id: null });
    expect(r.secs.map((s: { name: string }) => s.name)).toEqual(["Reasoning", "General Awareness", "Quantitative Aptitude (Quant)", "English"]);
    for (const s of r.secs) {
      expect(s).toMatchObject({ question_count: 25, sectional_timing: false, qualifying: false, cutoff_marks: null, calculator_allowed: false, allowed_types: ["mcq"], subject_node_id: null, minutes: null });
      expect(Number(s.marks_per_question)).toBe(2);
      expect(Number(s.negative_marks_per_question)).toBe(0.5);
    }
  });

  it("links the stage and subject nodes when they exist at migration time", async () => {
    await loadFrameworkSeed(userP, "exam-structure");
    await loadFrameworkSeed(userP, "subject-map");
    const sql = await readFile(MIGRATION, "utf-8");
    await sup(async (c) => { await c.query(`DELETE FROM exam_blueprints WHERE id=$1`, [SEED_ID]); await c.query(sql); });
    const r = await sup(async (c) => ({
      stage: (await c.query(`SELECT stage_node_id FROM exam_blueprints WHERE id=$1`, [SEED_ID])).rows[0].stage_node_id,
      subj: (await c.query(`SELECT subject_node_id FROM exam_blueprint_sections ORDER BY position`)).rows.map((x: { subject_node_id: string | null }) => x.subject_node_id),
    }));
    expect(r.stage).not.toBeNull();
    expect(r.subj.every((x: string | null) => x !== null)).toBe(true);
  });
});

describe("read access and RLS", () => {
  it("every tenant admin lists and gets the platform blueprint with totals", async () => {
    for (const [t, u] of [[tA, userA], [tB, userA]] as const) {
      const app = await buildApp(t, u, "admin");
      const list = await app.inject({ method: "GET", url: "/api/admin/blueprints" });
      expect(list.statusCode).toBe(200);
      const item = list.json().items.find((b: { id: string }) => b.id === SEED_ID);
      expect(item).toMatchObject({ total_questions: 100, total_marks: 200, total_minutes: 60 });
      const one = await app.inject({ method: "GET", url: `/api/admin/blueprints/${SEED_ID}` });
      expect(one.statusCode).toBe(200);
      expect(one.json().sections).toHaveLength(4);
    }
    const app = await buildApp(tA, userA, "admin");
    expect((await app.inject({ method: "GET", url: `/api/admin/blueprints/${randomUUID()}` })).statusCode).toBe(404);
  });

  it("the app role (tenant session) can read but never insert, update or delete", async () => {
    await withTenant(tA, async (c) => {
      expect((await c.query(`SELECT 1 FROM exam_blueprints`)).rows.length).toBeGreaterThan(0);
      expect((await c.query(`UPDATE exam_blueprints SET name = 'x'`)).rowCount).toBe(0);
      expect((await c.query(`DELETE FROM exam_blueprint_sections`)).rowCount).toBe(0);
    });
    await expect(withTenant(tA, (c) =>
      c.query(`INSERT INTO exam_blueprints (edition, name, total_minutes, verification_status) VALUES ('e','n',1,'unverified')`),
    )).rejects.toThrow();
    const r = await sup(async (c) => (await c.query(`SELECT name FROM exam_blueprints WHERE id=$1`, [SEED_ID])).rows[0]);
    expect(r.name).toBe("SSC CGL Tier 1");
  });
});

describe("super-admin writes", () => {
  it("a tenant admin gets 403 on create, update and delete and nothing changes", async () => {
    const app = await buildApp(tA, userA, "admin");
    expect((await app.inject({ method: "POST", url: "/api/admin/blueprints", payload: bodyOf() })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: `/api/admin/blueprints/${SEED_ID}`, payload: bodyOf() })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/api/admin/blueprints/${SEED_ID}` })).statusCode).toBe(403);
    expect(await sup(async (c) => (await c.query(`SELECT count(*)::int AS n FROM exam_blueprints`)).rows[0].n)).toBe(1);
  });

  it("create, update and delete work for a super admin, and each is audited", async () => {
    const app = await buildApp(tP, userP, "super_admin");
    const created = await app.inject({ method: "POST", url: "/api/admin/blueprints", payload: bodyOf({ total_questions: 20 }) });
    expect(created.statusCode).toBe(201);
    const bp = created.json();
    expect(bp).toMatchObject({ verification_status: "unverified", total_questions: 20, total_marks: 20 });
    expect(bp.sections.map((s: { position: number }) => s.position)).toEqual([1, 2]);

    const upd = await app.inject({
      method: "PUT", url: `/api/admin/blueprints/${bp.id}`,
      payload: bodyOf({ name: "Renamed", sections: [sectionBody({ name: "Only", question_count: 4, marks_per_question: 2, negative_marks_per_question: 0.5, qualifying: true, cutoff_marks: 3 })] }),
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json()).toMatchObject({ name: "Renamed", total_questions: 4, total_marks: 8 });
    expect(upd.json().sections).toHaveLength(1);
    expect(upd.json().sections[0]).toMatchObject({ qualifying: true, cutoff_marks: 3 });

    expect((await app.inject({ method: "DELETE", url: `/api/admin/blueprints/${bp.id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/admin/blueprints/${bp.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/admin/blueprints/${bp.id}` })).statusCode).toBe(404);

    const actions = await sup(async (c) =>
      (await c.query(`SELECT action FROM audit_log WHERE entity_type='exam_blueprint' AND entity_id=$1 ORDER BY at`, [bp.id])).rows.map((r: { action: string }) => r.action));
    expect(actions).toEqual(["exam_blueprint.created", "exam_blueprint.updated", "exam_blueprint.deleted"]);
  });

  it("rejects a stage or subject id that is not a platform node of the right kind, and a duplicate stage + edition", async () => {
    const app = await buildApp(tP, userP, "super_admin");
    const bad = await app.inject({ method: "POST", url: "/api/admin/blueprints", payload: bodyOf({ stage_node_id: randomUUID() }) });
    expect(bad.statusCode).toBe(400);
    const stage = await sup(async (c) => (await c.query(`SELECT stage_node_id FROM exam_blueprints WHERE id=$1`, [SEED_ID])).rows[0].stage_node_id);
    const dup = await app.inject({ method: "POST", url: "/api/admin/blueprints", payload: bodyOf({ stage_node_id: stage, edition: "current" }) });
    expect(dup.statusCode).toBe(400);
    const subjAsStage = await sup(async (c) => (await c.query(`SELECT subject_node_id FROM exam_blueprint_sections LIMIT 1`)).rows[0].subject_node_id);
    expect((await app.inject({ method: "POST", url: "/api/admin/blueprints", payload: bodyOf({ stage_node_id: subjAsStage }) })).statusCode).toBe(400);
  });
});

describe("validation", () => {
  const ok = (b: unknown) => BlueprintBodySchema.safeParse(b).success;
  it("accepts a consistent body", () => {
    expect(ok(bodyOf())).toBe(true);
    expect(ok(bodyOf({ total_questions: 20 }))).toBe(true);
  });
  it.each([
    ["question_count 0", { sections: [sectionBody({ question_count: 0 })] }],
    ["negative marks above marks", { sections: [sectionBody({ marks_per_question: 1, negative_marks_per_question: 1.5 })] }],
    ["negative marks below 0", { sections: [sectionBody({ negative_marks_per_question: -1 })] }],
    ["marks below 0", { sections: [sectionBody({ marks_per_question: -1, negative_marks_per_question: 0 })] }],
    ["total_questions mismatch", { total_questions: 21 }],
    ["cutoff without qualifying", { sections: [sectionBody({ cutoff_marks: 2 })] }],
    ["cutoff above section marks", { sections: [sectionBody({ qualifying: true, cutoff_marks: 11 })] }],
    ["sectional timing without minutes", { sections: [sectionBody({ sectional_timing: true })] }],
    ["sectional minutes not adding up", { sections: [sectionBody({ sectional_timing: true, minutes: 10 }), sectionBody({ sectional_timing: true, minutes: 10 })] }],
    ["mixed sectional timing", { sections: [sectionBody({ sectional_timing: true, minutes: 30 }), sectionBody()] }],
    ["no sections", { sections: [] }],
    ["11 sections", { sections: Array.from({ length: 11 }, () => sectionBody()) }],
    ["bad verification status", { verification_status: "maybe" }],
    ["unknown key", { tenant_id: randomUUID() }],
    ["unknown question type", { sections: [sectionBody({ allowed_types: ["nope"] })] }],
  ])("rejects %s", (_n, over) => {
    expect(ok(bodyOf(over))).toBe(false);
  });
});
