/**
 * EXP-5: question list filters, full-text + typo-tolerant search, facet counts.
 * Real Postgres (postgres:16-alpine testcontainer) with every migration applied, including
 * 0196 (pg_trgm, search_text trigger, GIN indexes). Covers: the SQL normaliser matching the JS
 * normalisedText(), a 5,000-row search under 300 ms, typo tolerance, filter combinations,
 * facet counts on a small fixture, and cross-tenant isolation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { AppError } from "@assessiq/core";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { registerQuestionBankRoutes } from "../routes.js";
import { listQuestions, questionFacets } from "../service/questions.js";
import { normalisedText } from "../import/v2.js";

let container: StartedTestContainer;
let url: string;
const tA = randomUUID();
const tB = randomUUID();
const uA = randomUUID();
const uB = randomUUID();

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function mkPack(c: Client, tenant: string, user: string): Promise<{ pack: string; level: string }> {
  const pack = randomUUID();
  const level = randomUUID();
  await c.query(
    `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, version, created_by, source)
     VALUES ($1,$2,$3,'P','soc','draft',1,$4,'authored')`,
    [pack, tenant, `s-${pack}`, user],
  );
  await c.query(
    `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count) VALUES ($1,$2,1,'L1',30,10)`,
    [level, pack],
  );
  return { pack, level };
}

interface Row {
  topic: string;
  question: string;
  rationale?: string;
  difficulty?: number | null;
  review?: string | null;
  lang?: string;
  origin?: string;
  rights?: string;
  status?: string;
}
async function addQ(c: Client, tenant: string, user: string, p: { pack: string; level: string }, r: Row): Promise<string> {
  const id = randomUUID();
  const content: Record<string, unknown> = { question: r.question, options: ["10", "20", "30", "40"], correct: 1 };
  if (r.rationale !== undefined) content["rationale"] = r.rationale;
  await c.query(
    `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, created_by,
                            difficulty_est, review_state, language_primary)
     VALUES ($1,$2,$3,'mcq',$4,1,$5,$6::jsonb,$7,$8,$9,$10)`,
    [id, p.pack, p.level, r.topic, r.status ?? "active", JSON.stringify(content), user,
     r.difficulty ?? null, r.review ?? null, r.lang ?? "en"],
  );
  await c.query(
    `INSERT INTO question_source (tenant_id, question_id, origin, rights_status) VALUES ($1,$2,$3,$4)`,
    [tenant, id, r.origin ?? "original_human", r.rights ?? "original"],
  );
  return id;
}

async function buildApp(tenantId: string) {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (req) => {
    (req as unknown as { session: unknown }).session = { tenantId, userId: uA, role: "admin" };
  });
  app.setErrorHandler((err: Error, _req, reply) => {
    const status = err instanceof AppError ? err.status : 500;
    void reply.code(status).send({ error: err.message, code: (err as AppError).details?.["code"] });
  });
  await registerQuestionBankRoutes(app, { adminOnly: [], superAdminOnly: [] as never });
  await app.ready();
  return app;
}

// Fixture ids shared by the tests below.
let big: { pack: string; level: string };
let small: { pack: string; level: string };
let packB: { pack: string; level: string };
let stage: string, subject: string, unit: string, outcomeA: string, outcomeB: string, outcomeC: string;
const smallIds: Record<string, string> = {};

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
    for (const [id, slug, uid, email] of [[tA, "ta", uA, "a@x.io"], [tB, "tb", uB, "b@x.io"]] as const) {
      await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$2)`, [id, slug]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
      await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Admin','admin','active')`, [uid, id, email]);
    }
    big = await mkPack(c, tA, uA);
    small = await mkPack(c, tA, uA);
    packB = await mkPack(c, tB, uB);

    // 5,000 rows in one statement; the trigger fills search_text. Row g has one word from the
    // vocabulary (625 rows each) and one unique word (quokka, row 4321).
    await c.query(
      `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, created_by, difficulty_est)
       SELECT gen_random_uuid(), $1, $2, 'mcq', 't' || g, 1, 'active',
              jsonb_build_object('question', format('Item %s: how is the %s computed for %s?', g,
                  (ARRAY['percentage','ratio','profit','interest','speed','average','algebra','geometry'])[1 + g % 8], CASE WHEN g = 4321 THEN 'quokka' ELSE 'cases' END),
                'options', jsonb_build_array('a1','b1','c1','d1'), 'correct', 1, 'rationale', 'because ' || g),
              $3, 1 + g % 5
         FROM generate_series(1, 5000) g`,
      [big.pack, big.level, uA],
    );
    await c.query(
      `INSERT INTO question_source (tenant_id, question_id, origin, rights_status)
       SELECT $2, q.id, 'original_human', 'original' FROM questions q WHERE q.pack_id = $1`,
      [big.pack, tA],
    );

    // Tenant B: the same unique word as one of A's rows has to stay invisible to A.
    await addQ(c, tB, uB, packB, { topic: "b1", question: "xylophone tuning for tenant B only" });
    await addQ(c, tB, uB, packB, { topic: "b2", question: "xylophone again", difficulty: 3 });

    // Small fixture: 8 rows with known attributes.
    smallIds["a"] = await addQ(c, tA, uA, small, { topic: "a", question: "Find the percentage of 40", rationale: "40 x p", difficulty: 1, review: "verified", origin: "original_human", rights: "original" });
    smallIds["b"] = await addQ(c, tA, uA, small, { topic: "b", question: "Find the percentage of 60", rationale: "  ", difficulty: 2, review: "verified", origin: "ai_original", rights: "original" });
    smallIds["c"] = await addQ(c, tA, uA, small, { topic: "c", question: "Solve for x in 2x = 8", difficulty: 2, review: "in_review", origin: "ai_original", rights: "licensed" });
    smallIds["d"] = await addQ(c, tA, uA, small, { topic: "d", question: "Simple interest on 500", rationale: "I = PRT/100", difficulty: 3, review: null, origin: "licensed", rights: "licensed" });
    smallIds["e"] = await addQ(c, tA, uA, small, { topic: "e", question: "Average of 4 numbers", difficulty: null, review: null, origin: "original_human", rights: "original", lang: "hi" });
    smallIds["f"] = await addQ(c, tA, uA, small, { topic: "f", question: "Speed of a train", rationale: "d/t", difficulty: 5, review: "disputed", origin: "scraped_raw", rights: "scraped_raw", status: "draft" });

    // Taxonomy (platform-owned, NULL tenant): stage; subject > unit > outcomes.
    const fw = (await c.query(`INSERT INTO frameworks (tenant_id, slug, name) VALUES (NULL, 'exp5-fw', 'EXP5') RETURNING id`)).rows[0].id as string;
    const node = async (parent: string | null, kind: string, code: string): Promise<string> =>
      (await c.query(
        `INSERT INTO taxonomy_nodes (tenant_id, framework_id, parent_id, kind, code, label) VALUES (NULL,$1,$2,$3,$4,$4) RETURNING id`,
        [fw, parent, kind, code],
      )).rows[0].id as string;
    stage = await node(null, "stage", "exp5-stage");
    subject = await node(null, "subject", "exp5-quant");
    unit = await node(subject, "unit", "exp5-arith");
    outcomeA = await node(unit, "outcome", "exp5-percent");
    outcomeB = await node(unit, "outcome", "exp5-interest");
    outcomeC = await node(subject, "outcome", "exp5-direct-under-subject");
    const link = (q: string, n: string) => c.query(`INSERT INTO question_taxonomy (question_id, node_id) VALUES ($1,$2)`, [q, n]);
    await link(smallIds["a"]!, outcomeA); await link(smallIds["a"]!, stage);
    await link(smallIds["b"]!, outcomeA);
    await link(smallIds["d"]!, outcomeB); await link(smallIds["d"]!, stage);
    await link(smallIds["e"]!, outcomeC);
    await c.query(`ANALYZE questions`);
  });
}, 180_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

const ids = (r: { items: { id: string }[] }) => r.items.map((i) => i.id).sort();
const want = (...keys: string[]) => keys.map((k) => smallIds[k]!).sort();

describe("migration 0196", () => {
  it("loads pg_trgm and the SQL normaliser equals the JS normalisedText()", async () => {
    await sup(async (c) => {
      expect((await c.query(`SELECT 1 FROM pg_extension WHERE extname='pg_trgm'`)).rowCount).toBe(1);
      const samples: unknown[] = [
        { question: "A) What is   PERCENT?", options: ["(b) 20%", "10%", "1. x"], correct: 0, rationale: "NOT INDEXED" },
        { question: "ＦＵＬＬ width ｗｏｒｄ", options: ["हिंदी प्रश्न", "b. two"], rationale: "r" },
        { stem: "nested", parts: [{ q: "one", rationale: "skip" }, { q: "Two" }] },
      ];
      for (const content of samples) {
        const r = await c.query<{ s: string | null }>(`SELECT aiq_json_leaves($1::jsonb) AS s`, [JSON.stringify(content)]);
        expect(r.rows[0]!.s).toBe(normalisedText(content));
      }
      // rationale is never indexed
      expect((await c.query(`SELECT 1 FROM questions WHERE search_text ILIKE '%not indexed%'`)).rowCount).toBe(0);
    });
  });

  it("keeps search_text in sync on UPDATE OF content, and re-running the migration is a no-op", async () => {
    await sup(async (c) => {
      await c.query(`UPDATE questions SET content = jsonb_set(content, '{question}', '"Brand NEW wording"') WHERE id = $1`, [smallIds["e"]]);
      expect((await c.query(`SELECT search_text FROM questions WHERE id=$1`, [smallIds["e"]])).rows[0].search_text).toContain("brand new wording");
      await c.query(`UPDATE questions SET content = jsonb_set(content, '{question}', '"Average of 4 numbers"') WHERE id = $1`, [smallIds["e"]]);
      const { readFile } = await import("node:fs/promises");
      const { join, dirname } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const sql = await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations", "0196_exp5_question_search.sql"), "utf8");
      await c.query(sql);
      await c.query(sql);
      expect((await c.query(`SELECT count(*)::int n FROM questions WHERE search_text IS NULL`)).rows[0].n).toBe(0);
    });
  });
});

describe("search (5,000 rows)", () => {
  it("finds a unique token in under 300 ms", async () => {
    await listQuestions(tA, { pack_id: big.pack, q: "cases", pageSize: 20 }); // warm-up
    const t0 = performance.now();
    const r = await listQuestions(tA, { pack_id: big.pack, q: "quokka", pageSize: 20 });
    const ms = performance.now() - t0;
    expect(r.total).toBe(1);
    expect(r.items[0]!.topic).toBe("t4321");
    expect(ms).toBeLessThan(300);
  });

  it("a common word searched across all 5,000 rows is also under 300 ms and counts match", async () => {
    const t0 = performance.now();
    const r = await listQuestions(tA, { q: "ratio", pageSize: 20 });
    const ms = performance.now() - t0;
    expect(r.total).toBe(625);
    expect(ms).toBeLessThan(300);
  });

  it("tolerates a typo and ranks the closest match first", async () => {
    const r = await listQuestions(tA, { pack_id: small.pack, q: "percentge", pageSize: 20 });
    expect(ids(r)).toEqual(want("a", "b"));
    const exact = await listQuestions(tA, { pack_id: small.pack, q: "percentage 40", pageSize: 20 });
    expect(exact.items[0]!.id).toBe(smallIds["a"]);
  });

  it("is case-insensitive and does not match rationale text", async () => {
    expect((await listQuestions(tA, { pack_id: small.pack, q: "SIMPLE INTEREST" })).total).toBe(1);
    expect((await listQuestions(tA, { pack_id: small.pack, q: "PRT/100" })).total).toBe(0);
  });
});

describe("filter combinations", () => {
  const f = (extra: object) => listQuestions(tA, { pack_id: small.pack, pageSize: 50, ...extra });

  it("origin, rights_status, review_state (incl. none), language, status", async () => {
    expect(ids(await f({ origin: ["ai_original"] }))).toEqual(want("b", "c"));
    expect(ids(await f({ origin: ["ai_original", "licensed"] }))).toEqual(want("b", "c", "d"));
    expect(ids(await f({ rights_status: ["licensed"] }))).toEqual(want("c", "d"));
    expect(ids(await f({ review_state: ["none"] }))).toEqual(want("d", "e"));
    expect(ids(await f({ review_state: ["verified", "in_review"] }))).toEqual(want("a", "b", "c"));
    expect(ids(await f({ language: ["hi"] }))).toEqual(want("e"));
    expect(ids(await f({ status: "draft" }))).toEqual(want("f"));
  });

  it("difficulty range is inclusive and ignores null difficulty", async () => {
    expect(ids(await f({ difficulty_min: 2, difficulty_max: 3 }))).toEqual(want("b", "c", "d"));
    expect(ids(await f({ difficulty_min: 5 }))).toEqual(want("f"));
    expect(ids(await f({ difficulty_max: 1 }))).toEqual(want("a"));
  });

  it("has_solution is true only for a non-blank rationale", async () => {
    expect(ids(await f({ has_solution: true }))).toEqual(want("a", "d", "f"));
    expect(ids(await f({ has_solution: false }))).toEqual(want("b", "c", "e"));
  });

  it("has_passage splits questions by passage_id (EXP-6 tail, migration 0211)", async () => {
    await sup(async (c) => {
      const pid = randomUUID();
      await c.query(`INSERT INTO passages (id, tenant_id, title, body) VALUES ($1,$2,'P','Read the text')`, [pid, tA]);
      await c.query(`UPDATE questions SET passage_id = $1 WHERE id = $2`, [pid, smallIds["b"]]);
      try {
        expect(ids(await f({ has_passage: true }))).toEqual(want("b"));
        expect(ids(await f({ has_passage: false }))).toEqual(want("a", "c", "d", "e", "f"));
        expect(ids(await f({ has_passage: true, has_solution: false }))).toEqual(want("b"));
      } finally {
        await c.query(`UPDATE questions SET passage_id = NULL WHERE id = $1`, [smallIds["b"]]);
        await c.query(`DELETE FROM passages WHERE id = $1`, [pid]);
      }
    });
  });

  it("taxonomy node filters match the node and its descendants, and respect the node kind", async () => {
    expect(ids(await f({ outcome_id: outcomeA }))).toEqual(want("a", "b"));
    expect(ids(await f({ unit_id: unit }))).toEqual(want("a", "b", "d"));
    expect(ids(await f({ subject_id: subject }))).toEqual(want("a", "b", "d", "e"));
    expect(ids(await f({ stage_id: stage }))).toEqual(want("a", "d"));
    expect(ids(await f({ unit_id: subject }))).toEqual([]); // wrong kind
    expect(ids(await f({ outcome_id: randomUUID() }))).toEqual([]);
  });

  it("combines every filter with AND, with search and with the existing filters", async () => {
    expect(ids(await f({ origin: ["ai_original"], difficulty_min: 2, has_solution: false, review_state: ["verified"] }))).toEqual(want("b"));
    expect(ids(await f({ subject_id: subject, q: "percentage", has_solution: true }))).toEqual(want("a"));
    expect(ids(await f({ type: "mcq", status: "active", search: "a" }))).toEqual(want("a"));
    const r = await f({ origin: ["ai_original"], pageSize: 1, page: 2 });
    expect(r.total).toBe(2);
    expect(r.items).toHaveLength(1);
  });
});

describe("facet counts", () => {
  const counts = (rows: { value: string; count: number }[]) => Object.fromEntries(rows.map((r) => [r.value, r.count]));

  it("counts every facet for the whole pack", async () => {
    const fc = await questionFacets(tA, { pack_id: small.pack });
    expect(fc.total).toBe(6);
    expect(counts(fc.origin)).toEqual({ original_human: 2, ai_original: 2, licensed: 1, scraped_raw: 1 });
    expect(counts(fc.rights_status)).toEqual({ original: 3, licensed: 2, scraped_raw: 1 });
    expect(counts(fc.review_state)).toEqual({ verified: 2, in_review: 1, disputed: 1, none: 2 });
    expect(counts(fc.language)).toEqual({ en: 5, hi: 1 });
    expect(counts(fc.difficulty)).toEqual({ "1": 1, "2": 2, "3": 1, "5": 1, none: 1 });
    expect(counts(fc.has_solution)).toEqual({ true: 3, false: 3 });
    expect(counts(fc.type)).toEqual({ mcq: 6 });
    expect(counts(fc.status)).toEqual({ active: 5, draft: 1 });
  });

  it("rolls node counts up to ancestors, one count per question", async () => {
    const fc = await questionFacets(tA, { pack_id: small.pack });
    const n = (rows: { node_id: string; count: number }[], id: string) => rows.find((r) => r.node_id === id)?.count;
    expect(n(fc.outcome, outcomeA)).toBe(2);
    expect(n(fc.outcome, outcomeB)).toBe(1);
    expect(n(fc.outcome, outcomeC)).toBe(1);
    expect(n(fc.unit, unit)).toBe(3);
    expect(n(fc.subject, subject)).toBe(4); // a, b, d via unit + e direct, each counted once
    expect(n(fc.stage, stage)).toBe(2);
  });

  it("a facet ignores its own filter and obeys the others", async () => {
    const fc = await questionFacets(tA, { pack_id: small.pack, origin: ["ai_original"], has_solution: false });
    expect(fc.total).toBe(2); // b, c
    expect(counts(fc.origin)).toEqual({ original_human: 1, ai_original: 2 }); // origin ignored, has_solution=false kept: b, c, e
    expect(counts(fc.has_solution)).toEqual({ false: 2 }); // has_solution ignored, origin kept: b, c
    expect(counts(fc.review_state)).toEqual({ verified: 1, in_review: 1 });
  });

  it("counts follow the search text", async () => {
    const fc = await questionFacets(tA, { pack_id: small.pack, q: "percentage" });
    expect(fc.total).toBe(2);
    expect(counts(fc.origin)).toEqual({ original_human: 1, ai_original: 1 });
  });
});

describe("tenant isolation", () => {
  it("tenant A never sees tenant B's questions in a list, a search or the facets", async () => {
    const a = await listQuestions(tA, { q: "xylophone" });
    expect(a.total).toBe(0);
    const b = await listQuestions(tB, { q: "xylophone" });
    expect(b.total).toBe(2);
    expect((await questionFacets(tA, { q: "xylophone" })).total).toBe(0);
    const fb = await questionFacets(tB, {});
    expect(fb.total).toBe(2);
    expect(fb.difficulty.reduce((s, r) => s + r.count, 0)).toBe(2);
    // Pointing tenant A at tenant B's pack returns nothing.
    expect((await listQuestions(tA, { pack_id: packB.pack })).total).toBe(0);
  });
});

describe("routes", () => {
  it("GET /api/admin/questions accepts the new filters and /facets returns the buckets", async () => {
    const app = await buildApp(tA);
    const list = await app.inject({ method: "GET", url: `/api/admin/questions?pack_id=${small.pack}&origin=ai_original,licensed&difficulty_min=2&has_solution=false&q=solve` });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([smallIds["c"]]);
    const fac = await app.inject({ method: "GET", url: `/api/admin/questions/facets?pack_id=${small.pack}` });
    expect(fac.statusCode).toBe(200);
    expect((fac.json() as { total: number }).total).toBe(6);
    await app.close();
  });

  it("rejects bad filter values with 400", async () => {
    const app = await buildApp(tA);
    for (const qs of [
      "difficulty_min=9", "difficulty_min=3&difficulty_max=2", "origin=bogus", "rights_status=nope",
      "review_state=maybe", "has_solution=yes", "has_passage=1", "outcome_id=not-a-uuid", `q=${"x".repeat(201)}`,
    ]) {
      for (const path of ["/api/admin/questions", "/api/admin/questions/facets"]) {
        const r = await app.inject({ method: "GET", url: `${path}?${qs}` });
        expect(r.statusCode, `${path}?${qs}`).toBe(400);
      }
    }
    await app.close();
  });
});
