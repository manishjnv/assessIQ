/**
 * EXP-9 A6: has_hindi list filter and facet. Real Postgres (testcontainer), same set-up as
 * question-search-facets.test.ts. Fake text only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { parseQuestionFilters } from "../routes.js";
import { listQuestions, questionFacets } from "../service/questions.js";

let container: StartedTestContainer;
let url: string;
const tA = randomUUID();
const uA = randomUUID();
let pack = "";
const ids: Record<string, string> = {};

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
  await sup((c) => applyAllMigrations(c));
  await setPoolForTesting(url);
  await sup(async (c) => {
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'ta','ta')`, [tA]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [tA]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@x.io','Admin','admin','active')`, [uA, tA]);
    pack = randomUUID();
    const level = randomUUID();
    await c.query(
      `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, version, created_by, source)
       VALUES ($1,$2,$3,'P','soc','draft',1,$4,'authored')`,
      [pack, tA, `s-${pack}`, uA],
    );
    await c.query(`INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count) VALUES ($1,$2,1,'L1',30,10)`, [level, pack]);
    const rows: Array<[string, Record<string, unknown>]> = [
      ["hi1", { question: "Sample one", options: ["a", "b"], correct: 0, i18n: { hi: { question: "नमूना प्रश्न", options: ["क", "ख"] } } }],
      ["hi2", { question: "Sample two", options: ["a", "b"], correct: 1, i18n: { hi: { question: "दूसरा प्रश्न", options: ["क", "ख"] } } }],
      ["blank", { question: "Sample three", options: ["a", "b"], correct: 0, i18n: { hi: { question: "  ", options: ["क", "ख"] } } }],
      ["en", { question: "Sample four", options: ["a", "b"], correct: 0 }],
    ];
    for (const [key, content] of rows) {
      const id = randomUUID();
      ids[key] = id;
      await c.query(
        `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, created_by)
         VALUES ($1,$2,$3,'mcq',$4,1,'active',$5::jsonb,$6)`,
        [id, pack, level, key, JSON.stringify(content), uA],
      );
      await c.query(`INSERT INTO question_source (tenant_id, question_id, origin, rights_status) VALUES ($1,$2,'original_human','original')`, [tA, id]);
    }
  });
}, 180_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

const sorted = (r: { items: { id: string }[] }) => r.items.map((i) => i.id).sort();
const want = (...k: string[]) => k.map((x) => ids[x]!).sort();

describe("EXP-9 A6 has_hindi", () => {
  it("true, false and absent", async () => {
    expect(sorted(await listQuestions(tA, { pack_id: pack, has_hindi: true }))).toEqual(want("hi1", "hi2"));
    expect(sorted(await listQuestions(tA, { pack_id: pack, has_hindi: false }))).toEqual(want("blank", "en"));
    expect(sorted(await listQuestions(tA, { pack_id: pack }))).toEqual(want("hi1", "hi2", "blank", "en"));
  });

  it("facet counts ignore the facet's own filter", async () => {
    const fc = await questionFacets(tA, { pack_id: pack, has_hindi: true });
    const counts = Object.fromEntries(fc.has_hindi.map((b) => [b.value, b.count]));
    expect(counts).toEqual({ true: 2, false: 2 });
    expect(fc.total).toBe(2);
  });

  it("route parser accepts true and false only", () => {
    expect(parseQuestionFilters({ has_hindi: "true" }).has_hindi).toBe(true);
    expect(parseQuestionFilters({ has_hindi: "false" }).has_hindi).toBe(false);
    expect(() => parseQuestionFilters({ has_hindi: "yes" })).toThrow();
  });
});
