/**
 * EXP-6: "Start a full mock" — a DRAFT assessment from the seeded SSC CGL Tier 1 blueprint, built through
 * the existing createAssessment path. postgres:16 testcontainer (all migrations, incl. 0201 seed).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { createMockFromBlueprint } from "../service.js";
import { registerAssessmentLifecycleRoutes } from "../routes.js";

const BP = "5c0e6a10-0000-4000-8000-000000000001";
let container: StartedTestContainer;
let url: string;
const tenant = randomUUID();
const admin = randomUUID();
const pack = randomUUID();
const draftPack = randomUUID();
const level = randomUUID();
const opensAt = new Date(Date.now() + 86_400_000);

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
  await sup(async (c) => {
    await applyAllMigrations(c);
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'ta','A')`, [tenant]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [tenant]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@x.io','Admin','admin','active')`, [admin, tenant]);
    for (const [id, status] of [[pack, "published"], [draftPack, "draft"]] as const) {
      await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,$3,'P','aptitude',$4,$5)`, [id, tenant, `p-${id.slice(0, 6)}`, status, admin]);
    }
    await c.query(`INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count) VALUES ($1,$2,1,'L1',60,100)`, [level, pack]);
  });
  await setPoolForTesting(url);
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

describe("createMockFromBlueprint", () => {
  it("creates a DRAFT with the four sections, negative marks and the pass-through qualifying data", async () => {
    const { assessment, warnings } = await createMockFromBlueprint(tenant, BP, { pack_id: pack, level_id: level, opens_at: opensAt }, admin);
    expect(assessment.status).toBe("draft");
    expect(assessment.name).toBe("SSC CGL Tier 1 full mock");
    expect(assessment.question_count).toBe(100);
    const s = assessment.settings as Record<string, unknown>;
    const secs = s["sections"] as Array<Record<string, unknown>>;
    expect(secs.map((x) => x["name"])).toEqual(["Reasoning", "General Awareness", "Quantitative Aptitude (Quant)", "English"]);
    expect(secs.map((x) => x["question_count"])).toEqual([25, 25, 25, 25]);
    expect(secs.map((x) => x["minutes"])).toEqual([15, 15, 15, 15]); // even split of 60; sum equals total_minutes
    expect(secs.every((x) => x["qualifying"] === undefined && x["cutoff_marks"] === undefined && x["calculator"] === undefined)).toBe(true);
    expect(s["scoring"]).toEqual({ negative_marks_default: 0.5 });
    expect(s["exam_blueprint"]).toMatchObject({ id: BP, verification_status: "verified" });
    expect(warnings).toHaveLength(2); // one overall timer is not modelled by sections + marks-per-question note
    expect(warnings.join(" ")).toContain("marks per question");
    const row = await sup(async (c) => (await c.query(`SELECT status, settings FROM assessments WHERE id=$1`, [assessment.id])).rows[0]);
    expect(row.status).toBe("draft");
    expect(row.settings.sections).toHaveLength(4);
  });

  it("uses a sectional blueprint's own minutes, cutoffs and calculator flags", async () => {
    await sup(async (c) => {
      await c.query(`UPDATE exam_blueprint_sections SET sectional_timing=true, minutes=15, qualifying=true, cutoff_marks=10, calculator_allowed=true WHERE blueprint_id=$1 AND position=3`, [BP]);
      await c.query(`UPDATE exam_blueprint_sections SET sectional_timing=true, minutes=15 WHERE blueprint_id=$1 AND position<>3`, [BP]);
    });
    const { assessment, warnings } = await createMockFromBlueprint(tenant, BP, { pack_id: pack, level_id: level, opens_at: opensAt, name: "Mock 2" }, admin);
    const secs = (assessment.settings as { sections: Array<Record<string, unknown>> }).sections;
    expect(secs[2]).toMatchObject({ minutes: 15, qualifying: true, cutoff_marks: 10, calculator: true });
    expect(warnings).toHaveLength(1); // only the marks-per-question note
    expect(assessment.name).toBe("Mock 2");
  });

  it("goes through the existing guards: unpublished pack, wrong level, missing opens_at, unknown blueprint", async () => {
    await expect(createMockFromBlueprint(tenant, BP, { pack_id: draftPack, level_id: level, opens_at: opensAt }, admin)).rejects.toMatchObject({ status: 409 });
    await expect(createMockFromBlueprint(tenant, BP, { pack_id: pack, level_id: randomUUID(), opens_at: opensAt }, admin)).rejects.toMatchObject({ status: 404 });
    await expect(createMockFromBlueprint(tenant, BP, { pack_id: pack, level_id: level, opens_at: null }, admin)).rejects.toMatchObject({ status: 400 });
    await expect(createMockFromBlueprint(tenant, randomUUID(), { pack_id: pack, level_id: level, opens_at: opensAt }, admin)).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a blueprint whose sections use different negative marks", async () => {
    await sup((c) => c.query(`UPDATE exam_blueprint_sections SET negative_marks_per_question=0.25 WHERE blueprint_id=$1 AND position=1`, [BP]));
    await expect(createMockFromBlueprint(tenant, BP, { pack_id: pack, level_id: level, opens_at: opensAt }, admin)).rejects.toMatchObject({ status: 400 });
  });
});

describe("POST /api/admin/blueprints/:id/mock", () => {
  it("201 with { assessment, warnings }; 400 on a bad body", async () => {
    await sup((c) => c.query(`UPDATE exam_blueprint_sections SET negative_marks_per_question=0.5 WHERE blueprint_id=$1`, [BP]));
    const app = Fastify({ logger: false });
    app.addHook("preHandler", async (req) => {
      (req as unknown as { session: unknown }).session = { tenantId: tenant, userId: admin, role: "admin" };
    });
    app.setErrorHandler((e, _r, reply) => reply.code((e as { status?: number }).status ?? 500).send({ message: e.message }));
    await registerAssessmentLifecycleRoutes(app, { adminOnly: [] });
    await app.ready();
    const ok = await app.inject({ method: "POST", url: `/api/admin/blueprints/${BP}/mock`, payload: { pack_id: pack, level_id: level, opens_at: opensAt.toISOString() } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().assessment.status).toBe("draft");
    const bad = await app.inject({ method: "POST", url: `/api/admin/blueprints/${BP}/mock`, payload: { pack_id: pack } });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/admin/blueprints/not-a-uuid/mock`, payload: {} })).statusCode).toBe(400);
  });
});
