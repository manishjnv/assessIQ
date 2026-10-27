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
    expect(secs.map((x) => x["minutes"])).toEqual([undefined, undefined, undefined, undefined]); // Z-42: no even split
    expect(s["whole_test_minutes"]).toBe(60);
    expect(secs.map((x) => x["marks_per_question"])).toEqual([2, 2, 2, 2]); // 25 x 2 = 50 per section, 200 total
    expect(secs.map((x) => x["negative_marks_per_question"])).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(secs.every((x) => x["qualifying"] === undefined && x["cutoff_marks"] === undefined && x["calculator"] === undefined)).toBe(true);
    expect(s["exam_blueprint"]).toMatchObject({ id: BP, verification_status: "verified" });
    expect(warnings).toHaveLength(0); // verified blueprint; timer and marks are now applied
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
    expect(warnings).toHaveLength(0);
    expect((assessment.settings as Record<string, unknown>)["whole_test_minutes"]).toBeUndefined(); // sectional: per-section minutes
    expect(assessment.name).toBe("Mock 2");
  });

  it("goes through the existing guards: unpublished pack, wrong level, missing opens_at, unknown blueprint", async () => {
    await expect(createMockFromBlueprint(tenant, BP, { pack_id: draftPack, level_id: level, opens_at: opensAt }, admin)).rejects.toMatchObject({ status: 409 });
    await expect(createMockFromBlueprint(tenant, BP, { pack_id: pack, level_id: randomUUID(), opens_at: opensAt }, admin)).rejects.toMatchObject({ status: 404 });
    await expect(createMockFromBlueprint(tenant, BP, { pack_id: pack, level_id: level, opens_at: null }, admin)).rejects.toMatchObject({ status: 400 });
    await expect(createMockFromBlueprint(tenant, randomUUID(), { pack_id: pack, level_id: level, opens_at: opensAt }, admin)).rejects.toMatchObject({ status: 404 });
  });

  it("EXP-35 short mock: chosen sections, scaled counts and minutes, marks kept, no cutoff, practice name", async () => {
    const { assessment } = await createMockFromBlueprint(tenant, BP, { pack_id: pack, level_id: level, opens_at: opensAt, section_positions: [0, 2], scale_percent: 50 }, admin);
    const secs = (assessment.settings as { sections: Array<Record<string, unknown>> }).sections;
    expect(secs.map((x) => x["name"])).toEqual(["Reasoning", "Quantitative Aptitude (Quant)"]);
    expect(secs.map((x) => x["question_count"])).toEqual([13, 13]);
    expect(secs.map((x) => x["minutes"])).toEqual([8, 8]);
    expect(secs.map((x) => x["marks_per_question"])).toEqual([2, 2]);
    expect(secs.every((x) => x["qualifying"] === undefined && x["cutoff_marks"] === undefined)).toBe(true);
    expect(assessment.question_count).toBe(26);
    expect(assessment.name).toBe("SSC CGL Tier 1 practice mock");
    await expect(createMockFromBlueprint(tenant, BP, { pack_id: pack, level_id: level, opens_at: opensAt, section_positions: [9] }, admin)).rejects.toMatchObject({ status: 400 });
  });

  it("EXP-35 fixed count: total is exact, refused above the chosen sections or with a percent", async () => {
    const { assessment } = await createMockFromBlueprint(tenant, BP, { pack_id: pack, level_id: level, opens_at: opensAt, question_count: 30 }, admin);
    const secs = (assessment.settings as { sections: Array<Record<string, unknown>> }).sections;
    expect(assessment.question_count).toBe(30);
    expect(secs.reduce((n, x) => n + (x["question_count"] as number), 0)).toBe(30);
    expect(assessment.name).toBe("SSC CGL Tier 1 practice mock");
    await expect(createMockFromBlueprint(tenant, BP, { pack_id: pack, level_id: level, opens_at: opensAt, section_positions: [0], question_count: 100 }, admin)).rejects.toMatchObject({ status: 400 });
    await expect(createMockFromBlueprint(tenant, BP, { pack_id: pack, level_id: level, opens_at: opensAt, question_count: 10, scale_percent: 50 }, admin)).rejects.toMatchObject({ status: 400 });
  });

  it("each section keeps its own marks and negative marks", async () => {
    await sup((c) => c.query(`UPDATE exam_blueprint_sections SET negative_marks_per_question=0.25 WHERE blueprint_id=$1 AND position=1`, [BP]));
    const { assessment } = await createMockFromBlueprint(tenant, BP, { pack_id: pack, level_id: level, opens_at: opensAt }, admin);
    const secs = (assessment.settings as { sections: Array<Record<string, unknown>> }).sections;
    expect(secs.map((x) => x["negative_marks_per_question"])).toEqual([0.25, 0.5, 0.5, 0.5]);
  });
});

describe("POST /api/admin/blueprints/:id/mock", () => {
  it("201 with { assessment, warnings }; 400 on a bad body", async () => {
    await sup((c) => c.query(`UPDATE exam_blueprint_sections SET negative_marks_per_question=0.5 WHERE blueprint_id=$1`, [BP]));
    const app = Fastify({ logger: false });
    app.addHook("preHandler", async (req) => {
      (req as unknown as { session: unknown }).session = { tenantId: tenant, userId: admin, role: "admin" };
    });
    app.setErrorHandler((e, _r, reply) => reply.code((e as { status?: number }).status ?? 500).send({ message: (e as Error).message }));
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

// CT-2: two platform subject nodes with real labels (the blueprint seed leaves its subject nodes NULL on a fresh database).
let nodeCache: Array<{ id: string; label: string }> | null = null;
async function seedNodes(): Promise<Array<{ id: string; label: string }>> {
  if (nodeCache !== null) return nodeCache;
  nodeCache = await sup(async (c) => {
    const fw = (await c.query<{ id: string }>(`INSERT INTO frameworks (tenant_id, slug, name) VALUES (NULL, 'ct2-test', 'CT2 test') RETURNING id`)).rows[0]!.id;
    const out: Array<{ id: string; label: string }> = [];
    for (const [code, label] of [["pct", "Percentages"], ["series", "Number series"]] as const) {
      const id = (await c.query<{ id: string }>(
        `INSERT INTO taxonomy_nodes (tenant_id, framework_id, kind, code, label) VALUES (NULL, $1, 'subject', $2, $3) RETURNING id`, [fw, code, label])).rows[0]!.id;
      out.push({ id, label });
    }
    return out;
  });
  return nodeCache;
}

describe("POST /api/admin/tests (CT-2 Create a test)", () => {
  async function app() {
    const a = Fastify({ logger: false });
    a.addHook("preHandler", async (req) => {
      (req as unknown as { session: unknown }).session = { tenantId: tenant, userId: admin, role: "admin" };
    });
    a.setErrorHandler((e, _r, reply) => reply.code((e as { status?: number }).status ?? 500).send({ message: (e as Error).message }));
    await registerAssessmentLifecycleRoutes(a, { adminOnly: [] });
    await a.ready();
    return a;
  }
  const base = () => ({ pack_id: pack, level_id: level, opens_at: opensAt.toISOString(), delivery_mode: "mock" });

  it("pattern cover: a DRAFT with the pattern sections, the type-card settings and no invitation", async () => {
    const a = await app();
    const r = await a.inject({
      method: "POST", url: "/api/admin/tests",
      payload: { ...base(), cover: { kind: "pattern", blueprint_id: BP, section_positions: [0, 1], scale_percent: 50 }, settings: { integrity: { fullscreen: false, block_copy_paste: true }, feedback_level: "right_wrong" } },
    });
    expect(r.statusCode).toBe(201);
    const { assessment } = r.json();
    expect(assessment.status).toBe("draft");
    expect(assessment.delivery_mode).toBe("mock");
    expect(assessment.name).toBe("SSC CGL Tier 1 practice mock");
    const st = assessment.settings;
    expect(st.sections.map((x: { name: string }) => x.name)).toEqual(["Reasoning", "General Awareness"]);
    expect(st.integrity).toEqual({ fullscreen: false, block_copy_paste: true });
    expect(st.feedback_level).toBe("right_wrong");
    expect(st.exam_blueprint).toMatchObject({ id: BP });
    const inv = await sup(async (c) => (await c.query(`SELECT count(*)::int AS n FROM assessment_invitations WHERE assessment_id=$1`, [assessment.id])).rows[0].n);
    expect(inv).toBe(0);
  });

  it("whole cover: count and time limit, no sections; a Real test cannot switch integrity off", async () => {
    const a = await app();
    const ok = await a.inject({ method: "POST", url: "/api/admin/tests", payload: { ...base(), name: "Plain", cover: { kind: "whole", question_count: 40 }, minutes: 50 } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().assessment).toMatchObject({ name: "Plain", question_count: 40, duration_minutes: 50, status: "draft" });
    expect(ok.json().assessment.settings.sections).toBeUndefined();
    const real = await a.inject({
      method: "POST", url: "/api/admin/tests",
      payload: { ...base(), delivery_mode: "real", cover: { kind: "whole", question_count: 10 }, settings: { integrity: { fullscreen: false, block_copy_paste: false } } },
    });
    expect(real.statusCode).toBe(409); // the settings reach createAssessment on every cover
  });

  it("topics cover: uneven counts, real topic names, one timer, the total is the sum", async () => {
    const a = await app();
    const nodes = (await seedNodes()).map((n) => ({ id: n.id, name: n.label }));
    expect(nodes).toHaveLength(2);
    const r = await a.inject({
      method: "POST", url: "/api/admin/tests",
      payload: { ...base(), cover: { kind: "topics", topics: [{ node_id: nodes[0]!.id, count: 12 }, { node_id: nodes[1]!.id, count: 3 }] } },
    });
    expect(r.statusCode).toBe(201);
    const { assessment } = r.json();
    expect(assessment.question_count).toBe(15);
    expect(assessment.settings.sections.map((x: { name: string; question_count: number }) => [x.name, x.question_count])).toEqual([[nodes[0]!.name, 12], [nodes[1]!.name, 3]]);
    expect(assessment.settings.whole_test_minutes).toBe(23);
    expect(assessment.settings.drill).toBe(true);
  });

  it("refuses a bad body, an unknown pattern and a topic total above 100", async () => {
    const a = await app();
    expect((await a.inject({ method: "POST", url: "/api/admin/tests", payload: base() })).statusCode).toBe(400); // no cover
    expect((await a.inject({ method: "POST", url: "/api/admin/tests", payload: { ...base(), cover: { kind: "whole", question_count: 101 } } })).statusCode).toBe(400);
    expect((await a.inject({ method: "POST", url: "/api/admin/tests", payload: { ...base(), cover: { kind: "pattern", blueprint_id: randomUUID() } } })).statusCode).toBe(404);
    expect((await a.inject({ method: "POST", url: "/api/admin/tests", payload: { ...base(), cover: { kind: "topics", topics: [{ node_id: randomUUID(), count: 60 }, { node_id: randomUUID(), count: 41 }] } } })).statusCode).toBe(400);
  });
});

describe("POST /api/admin/drills reads real topic names (CT-0 fix, S62)", () => {
  it("names each section with the taxonomy node label (the CT-0 query used a column that does not exist)", async () => {
    const a = Fastify({ logger: false });
    a.addHook("preHandler", async (req) => {
      (req as unknown as { session: unknown }).session = { tenantId: tenant, userId: admin, role: "admin" };
    });
    a.setErrorHandler((e, _r, reply) => reply.code((e as { status?: number }).status ?? 500).send({ message: (e as Error).message }));
    await registerAssessmentLifecycleRoutes(a, { adminOnly: [] });
    await a.ready();
    const nodes = await seedNodes();
    const body = { pack_id: pack, level_id: level, opens_at: opensAt.toISOString() };
    const uneven = await a.inject({ method: "POST", url: "/api/admin/drills", payload: { ...body, topics: [{ node_id: nodes[0]!.id, count: 7 }, { node_id: nodes[1]!.id, count: 2 }] } });
    expect(uneven.statusCode).toBe(201);
    expect(uneven.json().assessment.settings.sections.map((x: { name: string; question_count: number }) => [x.name, x.question_count])).toEqual([[nodes[0]!.label, 7], [nodes[1]!.label, 2]]);
    const even = await a.inject({ method: "POST", url: "/api/admin/drills", payload: { ...body, node_ids: [nodes[0]!.id], question_count: 5 } });
    expect(even.statusCode).toBe(201);
    expect(even.json().assessment.settings.sections[0].name).toBe(nodes[0]!.label);
  });
});
