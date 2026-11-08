/**
 * EXAM-STYLE SQL against a real Postgres (the helpers were written without a database run):
 * listPoolWithCategory live (GROUP BY) and frozen paths, and the publish pre-flight assertSectionPoolsFillable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { createPack, addLevel } from "../../../04-question-bank/src/service/packs.js";
import { createQuestion } from "../../../04-question-bank/src/service/questions.js";
import { loadFrameworkSeed } from "../../../04-question-bank/src/framework-seeds.js";
import { listPoolWithCategory } from "../repository.js";
import { assertSectionPoolsFillable } from "../../../05-assessment-lifecycle/src/service/blueprint.js";

const MCQ = { question: "Which port is HTTPS?", options: ["80", "443", "22", "25"], correct: 1, rationale: "r" };

let container: StartedTestContainer;
let url: string;
let tP = "";
let uP = "";
let ssc = "";
let bank = "";
let neutral = "";
let subject = "";
let packId = "";
let levelId = "";
const q = { none: [] as string[], ssc: [] as string[], bank: [] as string[], neutral: [] as string[], sscBank: [] as string[] };

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function mk(n: number, nodes: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await createQuestion(tP, { pack_id: packId, level_id: levelId, type: "mcq", topic: "t", points: 1, content: { ...MCQ, question: `Q ${randomUUID()}?` } }, uP);
    ids.push(r.id);
    await sup(async (c) => {
      await c.query(`UPDATE questions SET status='active' WHERE id=$1`, [r.id]);
      // the live pool query joins question_versions; a published question has a v1 snapshot
      await c.query(`INSERT INTO question_versions (id, question_id, version, content, saved_by, type) SELECT gen_random_uuid(), q.id, 1, q.content, $2, q.type FROM questions q WHERE q.id = $1`, [r.id, uP]);
      for (const node of nodes) await c.query(`INSERT INTO question_taxonomy (question_id, node_id) VALUES ($1,$2)`, [r.id, node]);
    });
  }
  return ids;
}

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
    ssc = await id("ssc"); bank = await id("bank"); neutral = await id("neutral");
    const fw = (await c.query(`INSERT INTO frameworks (tenant_id, slug, name) VALUES (NULL,'ps-tax','PS') RETURNING id`)).rows[0].id;
    subject = (await c.query(
      `INSERT INTO taxonomy_nodes (tenant_id, framework_id, parent_id, kind, code, label) VALUES (NULL,$1,NULL,'subject','ps1','ps1') RETURNING id`, [fw])).rows[0].id;
  });
  const pack = await createPack(tP, { name: `Pack ${randomUUID().slice(0, 8)}`, domain: "soc" }, uP);
  packId = pack.id;
  levelId = (await addLevel(tP, pack.id, { label: "L1" }, uP)).id;
  q.none = await mk(2, [subject]);        // untagged for style (has an unrelated subject link)
  q.neutral = await mk(1, [neutral]);     // neutral node = no style
  q.ssc = await mk(3, [ssc, subject]);
  q.bank = await mk(4, [bank]);
  q.sscBank = await mk(1, [ssc, bank]);
}, 180_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

const sorted = (a: string[]) => [...a].sort();

describe("listPoolWithCategory LIVE path (GROUP BY + style subquery)", () => {
  it("returns style nodes per item; untagged and neutral items return an empty array", async () => {
    const rows = await sup((c) => listPoolWithCategory(c as never, { assessmentId: randomUUID(), packId, levelId, useFrozen: false }));
    const by = new Map(rows.map((r) => [r.id, r.style_node_ids]));
    expect(rows).toHaveLength(11);
    for (const id of q.none) expect(by.get(id)).toEqual([]);
    for (const id of q.neutral) expect(by.get(id)).toEqual([]);
    for (const id of q.ssc) expect(by.get(id)).toEqual([ssc]);
    for (const id of q.bank) expect(by.get(id)).toEqual([bank]);
    for (const id of q.sscBank) expect(sorted(by.get(id)!)).toEqual(sorted([ssc, bank]));
    expect(rows.every((r) => r.version === 1)).toBe(true);
  });
});

describe("listPoolWithCategory FROZEN path (fp.node_ids)", () => {
  it("returns style nodes from frozen node_ids; empty and neutral-only node_ids return an empty array", async () => {
    const assessmentId = randomUUID();
    const rows: Array<[string, string[] | null]> = [
      [q.none[0]!, []], [q.none[1]!, [subject]], [q.neutral[0]!, [neutral]], [q.ssc[0]!, [ssc, subject]], [q.bank[0]!, [bank]], [q.sscBank[0]!, [ssc, bank]],
    ];
    await sup(async (c) => {
      await c.query(`SET session_replication_role = replica`); // the assessment row is not needed for this SQL
      for (const [qid, nodes] of rows) {
        await c.query(
          `INSERT INTO assessment_frozen_pool (tenant_id, assessment_id, question_id, question_version, level_id, type, node_ids) VALUES ($1,$2,$3,1,$4,'mcq',$5::uuid[])`,
          [tP, assessmentId, qid, levelId, nodes]);
      }
    });
    const got = await sup((c) => listPoolWithCategory(c as never, { assessmentId, packId, levelId, useFrozen: true }));
    const by = new Map(got.map((r) => [r.id, r.style_node_ids]));
    expect(got).toHaveLength(6);
    expect(by.get(q.none[0]!)).toEqual([]);
    expect(by.get(q.none[1]!)).toEqual([]);
    expect(by.get(q.neutral[0]!)).toEqual([]);
    expect(by.get(q.ssc[0]!)).toEqual([ssc]);
    expect(by.get(q.bank[0]!)).toEqual([bank]);
    expect(sorted(by.get(q.sscBank[0]!)!)).toEqual(sorted([ssc, bank]));
  });
});

describe("assertSectionPoolsFillable counts by style", () => {
  // Live pool: 2 none + 1 neutral = 3 untagged; ssc 3 + sscBank 1 = 4 ssc-tagged; bank 4 + sscBank.
  const run = (extra: Record<string, unknown>, question_count: number) =>
    sup((c) => assertSectionPoolsFillable(c as never, packId, levelId, { sections: [{ name: "Part A", question_count, ...extra }] }));

  it("a styled section counts own style + untagged (ssc: 3 + 4 = 7 passes, 8 fails with 7 available)", async () => {
    await expect(run({ style_node_id: ssc }, 7)).resolves.toBeUndefined();
    await expect(run({ style_node_id: ssc }, 8)).rejects.toMatchObject({ details: { code: "POOL_TOO_SMALL", available: 7, required: 8 } });
  });

  it("a bank section counts 3 untagged + 5 bank-tagged = 8", async () => {
    await expect(run({ style_node_id: bank }, 8)).resolves.toBeUndefined();
    await expect(run({ style_node_id: bank }, 9)).rejects.toMatchObject({ details: { available: 8 } });
  });

  it("an unstyled section counts untagged only (3 pass, 4 fails with 3 available)", async () => {
    await expect(run({}, 3)).resolves.toBeUndefined();
    await expect(run({}, 4)).rejects.toMatchObject({ details: { code: "POOL_TOO_SMALL", available: 3, required: 4 } });
  });
});
