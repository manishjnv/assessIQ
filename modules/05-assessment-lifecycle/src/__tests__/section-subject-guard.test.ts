/**
 * Z-122 / Z-123: section subject guard (create, PATCH), per-section publish pool check, node_id sections.
 * from-set delegates to createAssessment (same guard), so it shares these cases.
 * Testcontainers (postgres:16-alpine), full RLS stack. Pattern mirrors blueprint-taxonomy-draw.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { ValidationError } from "@assessiq/core";
import { createAssessment, updateAssessment, publishAssessment } from "../service.js";
import { createQuestion } from "../../../04-question-bank/src/service.js";

let container: StartedTestContainer;
let url: string;
const tenant = randomUUID();
const tenantB = randomUUID();
const admin = randomUUID();
const domA = randomUUID(); // subject of the pack
const domOther = randomUUID(); // another subject, same tenant
const domForeign = randomUUID(); // same slug as the pack subject, other tenant
const catA = randomUUID();
const catOther = randomUUID();
const catForeign = randomUUID();
const fw = randomUUID();
const NODE = randomUUID();
const packId = randomUUID();
const levelId = randomUUID();

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
const opens = () => new Date(Date.now() + 60_000);
const sec = (extra: Record<string, unknown>) => ({ name: "Sec", question_count: 1, minutes: 10, ...extra });
const mk = (sections: unknown[]) =>
  createAssessment(
    tenant,
    { name: "s", pack_id: packId, level_id: levelId, question_count: 1, opens_at: opens(), settings: { sections } } as Parameters<typeof createAssessment>[1],
    admin,
  );
async function rejected(p: Promise<unknown>): Promise<ValidationError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ValidationError) return e;
    throw e;
  }
  throw new Error("expected a ValidationError");
}
async function addQ(category: string | null, node: string | null) {
  const q = await createQuestion(
    tenant,
    {
      pack_id: packId, level_id: levelId, type: "mcq", topic: "t", points: 1,
      content: { question: "q?", options: ["A", "B", "C", "D"], correct: 0, rationale: "A" },
    },
    admin,
  );
  await sup(async (c) => {
    await c.query(`UPDATE questions SET domain_id=$2, category_id=$3, status='active', review_state='verified' WHERE id=$1`, [q.id, category === null ? null : domA, category]);
    await c.query(`INSERT INTO question_versions (id, question_id, version, content, rubric, saved_by, type) SELECT gen_random_uuid(), id, 1, content, rubric, $2, type FROM questions WHERE id = $1`, [q.id, admin]);
    if (node !== null) await c.query(`INSERT INTO question_taxonomy (question_id, node_id) VALUES ($1,$2)`, [q.id, node]);
  });
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
    await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await c.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
    for (const [id, slug] of [[tenant, "sg-a"], [tenantB, "sg-b"]] as const) {
      await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $2)`, [id, slug]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
      await c.query(`INSERT INTO tenant_plans (tenant_id, tier, included_credits) VALUES ($1,'internal',NULL) ON CONFLICT DO NOTHING`, [id]);
    }
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@example.com','Admin','admin','active')`, [admin, tenant]);
    for (const [id, t, slug] of [[domA, tenant, "dom-a"], [domOther, tenant, "dom-other"], [domForeign, tenantB, "dom-a"]] as const) {
      await c.query(`INSERT INTO domains (id, tenant_id, slug, name) VALUES ($1,$2,$3,$3)`, [id, t, slug]);
    }
    for (const [id, t, d, slug] of [[catA, tenant, domA, "ca"], [catOther, tenant, domOther, "co"], [catForeign, tenantB, domForeign, "cf"]] as const) {
      await c.query(`INSERT INTO categories (id, tenant_id, domain_id, slug, name) VALUES ($1,$2,$3,$4,$4)`, [id, t, d, slug]);
    }
    await c.query(`INSERT INTO frameworks (id, tenant_id, slug, name) VALUES ($1,NULL,'sg-f','F')`, [fw]);
    await c.query(`INSERT INTO taxonomy_nodes (id, tenant_id, framework_id, parent_id, kind, code, label) VALUES ($1,NULL,$2,NULL,'subject','quant','quant')`, [NODE, fw]);
    await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,'sg-pack','P','dom-a','published',$3)`, [packId, tenant, admin]);
    await c.query(`INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count) VALUES ($1,$2,1,'L1',60,10)`, [levelId, packId]);
  });
  await setPoolForTesting(url);
}, 180_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
});

describe("Z-122 section category guard", () => {
  it("rejects a category of another subject on create, naming the section", async () => {
    const e = await rejected(mk([sec({ name: "Finance part", category_ids: [catOther] })]));
    expect(e.details).toMatchObject({ code: "INVALID_PARAM", param: "settings.sections" });
    expect(e.message).toContain("Finance part");
    expect(e.message).toContain("not from this pack's subject");
  });

  it("rejects a category id of another tenant (same subject slug) and an unknown id", async () => {
    await rejected(mk([sec({ category_ids: [catForeign] })]));
    await rejected(mk([sec({ category_ids: [randomUUID()] })]));
  });

  it("rejects when one of several categories is wrong", async () => {
    await rejected(mk([sec({ category_ids: [catA, catOther] })]));
  });

  it("accepts a category of the pack's subject; question_count-only and node_id sections pass", async () => {
    await mk([sec({ category_ids: [catA] })]);
    await mk([sec({})]);
    await mk([sec({ node_id: NODE })]);
  });

  it("rejects a node_id that does not exist", async () => {
    await rejected(mk([sec({ node_id: randomUUID() })]));
  });

  it("PATCH: rejects a wrong-subject category and accepts a right one", async () => {
    const a = await mk([sec({ category_ids: [catA] })]);
    await rejected(updateAssessment(tenant, a.id, { settings: { sections: [sec({ category_ids: [catOther] })] } }, admin));
    const ok = await updateAssessment(tenant, a.id, { settings: { sections: [sec({ category_ids: [catA] })] } }, admin);
    expect(ok.id).toBe(a.id);
  });
});

describe("Z-122 publish checks each section pool", () => {
  it("fails when one section pool is too small although the whole pool is large; passes once it fills", async () => {
    for (let i = 0; i < 4; i++) await addQ(null, null); // large pool with no category
    await addQ(catA, null);
    const a = await mk([sec({ name: "Big", question_count: 3 }), sec({ name: "Small", category_ids: [catA], question_count: 2 })]);
    const e = await rejected(publishAssessment(tenant, a.id, admin));
    expect(e.message).toContain("Small");
    expect(e.details).toMatchObject({ section: "Small", available: 1, required: 2 });
    await addQ(catA, null);
    expect((await publishAssessment(tenant, a.id, admin)).status).toBe("published");
  });

  it("a node_id section counts imported questions (taxonomy only, no category)", async () => {
    await addQ(null, NODE);
    await addQ(null, NODE);
    const ok = await mk([sec({ name: "Node ok", node_id: NODE, question_count: 2 })]);
    expect((await publishAssessment(tenant, ok.id, admin)).status).toBe("published");
    const bad = await mk([sec({ name: "Node big", node_id: NODE, question_count: 3 })]);
    const e = await rejected(publishAssessment(tenant, bad.id, admin));
    expect(e.details).toMatchObject({ section: "Node big", available: 2, required: 3 });
  });
});
