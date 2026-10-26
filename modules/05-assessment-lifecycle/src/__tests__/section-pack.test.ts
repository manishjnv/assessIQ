/**
 * EXP-23: optional pack_id per assessment section (create guard, freeze across packs,
 * publish entitlement for every section pack). Testcontainers (postgres:16-alpine), full RLS stack.
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
const tenant = randomUUID(); // tier 'pro': entitlement is enforced
const tenantB = randomUUID();
const admin = randomUUID();
const pack1 = randomUUID(); // assessment pack, domain dom-1 (entitled)
const level1 = randomUUID();
const pack2 = randomUUID(); // second pack of the same tenant, domain dom-2 (NOT entitled at first)
const level2 = randomUUID();
const packForeign = randomUUID(); // another tenant's private pack
const levelForeign = randomUUID();

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
const sec = (extra: Record<string, unknown>) => ({ name: "Sec", question_count: 2, minutes: 10, ...extra });
const mk = (sections: unknown[]) =>
  createAssessment(
    tenant,
    { name: "s", pack_id: pack1, level_id: level1, question_count: 2, opens_at: opens(), settings: { sections } } as Parameters<typeof createAssessment>[1],
    admin,
  );
async function addQ(packId: string, levelId: string) {
  const q = await createQuestion(
    tenant,
    { pack_id: packId, level_id: levelId, type: "mcq", topic: "t", points: 1, content: { question: "q?", options: ["A", "B", "C", "D"], correct: 0, rationale: "A" } },
    admin,
  );
  await sup(async (c) => {
    await c.query(`UPDATE questions SET status='active', review_state='verified' WHERE id=$1`, [q.id]);
    await c.query(`INSERT INTO question_versions (id, question_id, version, content, rubric, saved_by, type) SELECT gen_random_uuid(), id, 1, content, rubric, $2, type FROM questions WHERE id = $1`, [q.id, admin]);
  });
  return q.id;
}
const frozenPacks = (aid: string) =>
  sup(async (c) =>
    (await c.query<{ pack_id: string; n: string }>(
      `SELECT q.pack_id, count(*) AS n FROM assessment_frozen_pool f JOIN questions q ON q.id = f.question_id WHERE f.assessment_id = $1 GROUP BY q.pack_id`,
      [aid],
    )).rows,
  );

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
    for (const [id, slug] of [[tenant, "sp-a"], [tenantB, "sp-b"]] as const) {
      await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $2)`, [id, slug]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
    }
    await c.query(`INSERT INTO tenant_plans (tenant_id, tier, included_credits) VALUES ($1,'pro',NULL) ON CONFLICT (tenant_id) DO UPDATE SET tier='pro'`, [tenant]);
    await c.query(`INSERT INTO tenant_entitlements (tenant_id, scope_type, scope_id, status) VALUES ($1,'domain','dom-1','active')`, [tenant]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@example.com','Admin','admin','active')`, [admin, tenant]);
    for (const [pid, t, dom, lid] of [[pack1, tenant, "dom-1", level1], [pack2, tenant, "dom-2", level2], [packForeign, tenantB, "dom-1", levelForeign]] as const) {
      await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,$3,'P',$4,'published',$5)`, [pid, t, `sp-${pid.slice(0, 8)}`, dom, admin]);
      await c.query(`INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count) VALUES ($1,$2,1,'L1',60,10)`, [lid, pid]);
    }
  });
  await setPoolForTesting(url);
  await addQ(pack1, level1);
  await addQ(pack1, level1);
  await addQ(pack2, level2);
  await addQ(pack2, level2);
}, 180_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
});

describe("EXP-23 section pack_id", () => {
  it("(a) an assessment without section pack_id freezes only its own pack", async () => {
    const a = await mk([sec({})]);
    expect((await publishAssessment(tenant, a.id, admin)).status).toBe("published");
    expect(await frozenPacks(a.id)).toEqual([{ pack_id: pack1, n: "2" }]);
  });

  it("(e) a section pack of another tenant, or an unknown pack, is refused at create and at PATCH", async () => {
    for (const bad of [packForeign, randomUUID()]) {
      await expect(mk([sec({}), sec({ name: "X", pack_id: bad })])).rejects.toMatchObject({ details: { code: "INVALID_PARAM", param: "settings.sections.pack_id" } });
    }
    const ok = await mk([sec({})]);
    await expect(updateAssessment(tenant, ok.id, { settings: { sections: [sec({ pack_id: packForeign })] } }, admin)).rejects.toBeInstanceOf(ValidationError);
  });

  it("(c) publish fails NOT_ENTITLED when a section pack has no entitlement", async () => {
    const a = await mk([sec({}), sec({ name: "Two", pack_id: pack2 })]);
    await expect(publishAssessment(tenant, a.id, admin)).rejects.toMatchObject({ details: { code: "NOT_ENTITLED", pack_id: pack2 } });
    expect(await frozenPacks(a.id)).toEqual([]); // nothing frozen on the failed publish
  });

  it("(b) with the entitlement, publish freezes both packs", async () => {
    await sup((c) => c.query(`INSERT INTO tenant_entitlements (tenant_id, scope_type, scope_id, status) VALUES ($1,'domain','dom-2','active')`, [tenant]));
    const a = await mk([sec({}), sec({ name: "Two", pack_id: pack2 })]);
    expect((await publishAssessment(tenant, a.id, admin)).status).toBe("published");
    const byPack = (x: { pack_id: string }, y: { pack_id: string }) => x.pack_id.localeCompare(y.pack_id);
    expect((await frozenPacks(a.id)).sort(byPack)).toEqual([{ pack_id: pack1, n: "2" }, { pack_id: pack2, n: "2" }].sort(byPack));
  });

  it("publish fails when the section pack has too few questions at the assessment level position", async () => {
    const a = await mk([sec({}), sec({ name: "Big", pack_id: pack2, question_count: 3 })]);
    await expect(publishAssessment(tenant, a.id, admin)).rejects.toMatchObject({ details: { section: "Big", available: 2, required: 3 } });
  });
});

describe("CT-0 frozen difficulty and publish pre-flight", () => {
  it("(f) difficulty_est is copied into the frozen pool row and a later live change does not reach it", async () => {
    await sup((c) => c.query(`UPDATE questions SET difficulty_est = 3 WHERE pack_id = $1`, [pack1]));
    const a = await mk([sec({})]);
    await publishAssessment(tenant, a.id, admin);
    await sup((c) => c.query(`UPDATE questions SET difficulty_est = 5 WHERE pack_id = $1`, [pack1]));
    const rows = await sup(async (c) => (await c.query<{ d: number }>(`SELECT difficulty_est AS d FROM assessment_frozen_pool WHERE assessment_id = $1`, [a.id])).rows);
    expect(rows.map((r) => r.d)).toEqual([3, 3]);
  });

  it("(g) publish refuses a section whose allowed type has no questions, even when the pool is big enough", async () => {
    const a = await mk([sec({ allowed_types: ["subjective"] })]);
    await expect(publishAssessment(tenant, a.id, admin)).rejects.toMatchObject({ details: { available: 0, required: 2 } });
  });
});
