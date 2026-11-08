/**
 * EXAM-STYLE (migration 0289): exam_blueprints.style_node_id against a real Postgres.
 * Valid exam-style node is stored and returned; a node of another framework is refused; update and
 * versioned create keep the style.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { loadFrameworkSeed } from "../framework-seeds.js";
import { BlueprintBodySchema, createExamBlueprint, updateExamBlueprint, getExamBlueprint } from "../exam-blueprints.js";

let container: StartedTestContainer;
let url: string;
let tP = "";
let uP = "";
let sscNode = "";
let bankNode = "";
let otherNode = "";

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

const body = (over: Record<string, unknown> = {}) =>
  BlueprintBodySchema.parse({
    edition: "style-1", name: "Styled exam", total_minutes: 30, verification_status: "unverified",
    sections: [{ name: "A", question_count: 5, marks_per_question: 1, negative_marks_per_question: 0.25 }],
    ...over,
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
    uP = (await c.query(`SELECT id FROM users WHERE tenant_id=$1 LIMIT 1`, [tP])).rows[0].id;
  });
  await loadFrameworkSeed(uP, "exam-style");
  await sup(async (c) => {
    const id = async (code: string) => (await c.query(
      `SELECT n.id FROM taxonomy_nodes n JOIN frameworks f ON f.id=n.framework_id WHERE f.slug='exam-style' AND n.code=$1`, [code])).rows[0].id as string;
    sscNode = await id("ssc");
    bankNode = await id("bank");
    const fw = (await c.query(`INSERT INTO frameworks (tenant_id, slug, name) VALUES (NULL,'not-style','NS') RETURNING id`)).rows[0].id;
    otherNode = (await c.query(
      `INSERT INTO taxonomy_nodes (tenant_id, framework_id, parent_id, kind, code, label) VALUES (NULL,$1,NULL,'subject','ns1','ns1') RETURNING id`, [fw])).rows[0].id;
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

describe("exam blueprint style_node_id (real Postgres)", () => {
  it("stores a valid exam-style node and returns it from create and get", async () => {
    const bp = await createExamBlueprint(tP, uP, body({ edition: "ok-1", style_node_id: sscNode }));
    expect(bp.style_node_id).toBe(sscNode);
    expect((await getExamBlueprint(tP, bp.id)).style_node_id).toBe(sscNode);
    expect(await sup(async (c) => (await c.query(`SELECT style_node_id FROM exam_blueprints WHERE id=$1`, [bp.id])).rows[0].style_node_id)).toBe(sscNode);
  });

  it("a blueprint without a style stores NULL", async () => {
    const bp = await createExamBlueprint(tP, uP, body({ edition: "none-1" }));
    expect(bp.style_node_id).toBeNull();
  });

  it("refuses a node that is not in framework exam-style (INVALID_PARAM style_node_id)", async () => {
    await expect(createExamBlueprint(tP, uP, body({ edition: "bad-1", style_node_id: otherNode })))
      .rejects.toMatchObject({ details: { code: "INVALID_PARAM", param: "style_node_id" } });
  });

  it("update keeps and changes the style", async () => {
    const bp = await createExamBlueprint(tP, uP, body({ edition: "upd-1", style_node_id: sscNode }));
    const same = await updateExamBlueprint(tP, uP, bp.id, body({ edition: "upd-1", name: "Renamed", style_node_id: sscNode }));
    expect(same).toMatchObject({ id: bp.id, name: "Renamed", style_node_id: sscNode });
    const changed = await updateExamBlueprint(tP, uP, bp.id, body({ edition: "upd-1", style_node_id: bankNode }));
    expect(changed.style_node_id).toBe(bankNode);
    await expect(updateExamBlueprint(tP, uP, bp.id, body({ edition: "upd-1", style_node_id: otherNode })))
      .rejects.toMatchObject({ details: { param: "style_node_id" } });
  });

  it("versioned create (verified edition, new label) stores the style on the new row", async () => {
    const v1 = await createExamBlueprint(tP, uP, body({ edition: "ver-1", verification_status: "verified", style_node_id: sscNode }));
    const v2 = await updateExamBlueprint(tP, uP, v1.id, body({ edition: "ver-2", verification_status: "verified", style_node_id: bankNode }));
    expect(v2.id).not.toBe(v1.id);
    expect(v2).toMatchObject({ supersedes_id: v1.id, style_node_id: bankNode });
    expect((await getExamBlueprint(tP, v1.id)).style_node_id).toBe(sscNode);
  });
});
