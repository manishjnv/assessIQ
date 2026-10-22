/**
 * EXP-4: import v2 against a real Postgres. 50-row file with 5 exact duplicates, 5 normalised-text
 * duplicates and 3 bad rows; stage, then commit; question_source / taxonomy / difficulty are written.
 * The trigram class is skipped while pg_trgm is absent and runs once the extension exists.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { csvCell, sha256Hex } from "@assessiq/core";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { parseImportFile } from "../import/parse.js";
import { stageImport, fixImportRow, previewImport, getImportReport } from "../import/staging.js";
import { commitImport } from "../import/commit.js";

let container: StartedTestContainer;
let url: string;
const tA = randomUUID();
const uA = randomUUID();

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

const COLS = ["type", "topic", "points", "level", "question", "options", "correct", "rationale",
  "exam_stage", "subject_path", "difficulty", "difficulty_scale", "rights_status", "language", "source_ref", "origin", "source_url"];
type Cells = Partial<Record<(typeof COLS)[number], string>>;
const buildCsv = (rows: Cells[]): Buffer =>
  Buffer.from([COLS, ...rows.map((r) => COLS.map((c) => r[c] ?? ""))].map((r) => r.map(csvCell).join(",")).join("\r\n"), "utf8");

const mcq = (n: number, extra: Cells = {}): Cells => ({
  type: "mcq", topic: "Percentage", points: "1", level: "1", question: `Unique exam question number ${n} about percentages?`,
  options: JSON.stringify([`${n}`, `${n + 1}`]), correct: "1", rationale: "r",
  exam_stage: "SSC CGL Tier 1", subject_path: "Quant/Arithmetic/Percentage", rights_status: "original", ...extra,
});
const meta = (data: Buffer) => ({ fileName: "exam.csv", fileSha256: sha256Hex(data), format: "csv" as const, domain: "soc", packName: "Exam set" });
const stage = async (data: Buffer) => stageImport(tA, uA, meta(data), await parseImportFile("csv", data));

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_test" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_test`;
  await sup((c) => applyAllMigrations(c));
  // Migration 0196 (EXP-5) installs pg_trgm. These tests start from the extension-absent state, so drop it
  // (CASCADE removes only the 0196 trigram index); the last test installs it again.
  await sup((c) => c.query(`DROP EXTENSION IF EXISTS pg_trgm CASCADE`));
  await setPoolForTesting(url);
  await sup(async (c) => {
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'ta','ta')`, [tA]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [tA]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@x.io','Admin','super_admin','active')`, [uA, tA]);
    await c.query(`INSERT INTO domains (tenant_id, slug, name) VALUES ($1,'soc','SOC')`, [tA]);
    // Platform-owned frameworks (tenant NULL), as the bundled EXP-1 seeds load them.
    const ex = (await c.query(`INSERT INTO frameworks (tenant_id, slug, name) VALUES (NULL,'exam-structure','Exam structure') RETURNING id`)).rows[0].id;
    const sm = (await c.query(`INSERT INTO frameworks (tenant_id, slug, name) VALUES (NULL,'subject-map','Subject map') RETURNING id`)).rows[0].id;
    const node = async (fw: string, parent: string | null, kind: string, code: string, label: string): Promise<string> =>
      (await c.query(`INSERT INTO taxonomy_nodes (tenant_id, framework_id, parent_id, kind, code, label) VALUES (NULL,$1,$2,$3,$4,$5) RETURNING id`,
        [fw, parent, kind, code, label])).rows[0].id;
    const ssc = await node(ex, null, "board", "ssc", "SSC");
    await node(ex, ssc, "stage", "ssc-cgl-tier-1", "SSC CGL Tier 1");
    const quant = await node(sm, null, "subject", "quant", "Quant");
    const arith = await node(sm, quant, "unit", "arithmetic", "Arithmetic");
    await node(sm, arith, "outcome", "percentage", "Percentage");
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

describe("EXP-4 import v2", () => {
  let importId = "";
  let data: Buffer;

  it("stages 50 rows: 5 exact + 5 normalised duplicates, 3 bad rows; trigram skipped without pg_trgm", async () => {
    const rows: Cells[] = [];
    for (let n = 1; n <= 37; n++) {
      const extra: Cells = {};
      if (n === 1) Object.assign(extra, { difficulty: "Hard", difficulty_scale: "words", language: "hi", source_ref: "Book A p.4" });
      if (n === 2) Object.assign(extra, { difficulty: "2", difficulty_scale: "1-3" });
      if (n === 3) Object.assign(extra, { rights_status: "scraped_raw", source_url: "https://example.org/q3" });
      rows.push(mcq(n, extra));
    }
    for (let n = 1; n <= 5; n++) rows.push(mcq(n)); // exact repeats of 1..5
    for (let n = 6; n <= 10; n++) {
      // same text, different case / spacing / option labels
      rows.push(mcq(n, {
        question: `  UNIQUE exam   question number ${n} about percentages? `,
        options: JSON.stringify([`A) ${n}`, `B) ${n + 1}`]),
      }));
    }
    rows.push(mcq(100, { rights_status: "" })); // missing rights_status
    rows.push(mcq(101, { difficulty: "tough" })); // unknown difficulty label
    rows.push(mcq(102, { subject_path: "Quant/Geometry" })); // unknown subject node
    expect(rows).toHaveLength(50);

    data = buildCsv(rows);
    const report = await stage(data);
    importId = report.importId;
    expect(report.counts).toEqual({ total: 50, ok: 37, error: 3, duplicate: 10, skip: 0 });
    expect(report.duplicateClasses).toEqual({ exact: 5, normalised: 5, similar: 0 });
    expect(report.checksRun).toEqual(["exact", "normalised"]); // pg_trgm absent: the class is skipped, not failed
    const errs = report.rows.filter((r) => r.decision === "error").map((r) => r.errors[0]!.column);
    expect(errs).toEqual(["rights_status", "difficulty", "subject_path"]);
    expect(report.rows.find((r) => r.row === 39)).toMatchObject({ decision: "duplicate", dupClass: "exact" });
    expect(report.rows.find((r) => r.row === 44)).toMatchObject({ decision: "duplicate", dupClass: "normalised" });
  });

  it("commit writes question_source, difficulty, language and taxonomy links for every ok row", async () => {
    const res = await commitImport(tA, uA, importId, { mode: "skip-errors" });
    expect(res.committed).toBe(37);
    const db = await sup(async (c) => {
      const one = async (needle: string) => (await c.query(
        `SELECT q.difficulty_est, q.language_primary, s.origin, s.rights_status, s.source_ref, s.source_url, s.source_difficulty_raw,
                s.import_id, s.uploaded_by, s.content_hash, s.normalised_text_hash,
                (SELECT count(*)::int FROM question_taxonomy t WHERE t.question_id = q.id) AS links
           FROM questions q JOIN question_source s ON s.question_id = q.id
          WHERE q.pack_id = $1 AND q.content->>'question' = $2`, [res.packId, needle])).rows[0];
      return {
        sources: (await c.query(`SELECT count(*)::int AS n FROM question_source WHERE import_id = $1`, [importId])).rows[0].n,
        q1: await one("Unique exam question number 1 about percentages?"),
        q2: await one("Unique exam question number 2 about percentages?"),
        q3: await one("Unique exam question number 3 about percentages?"),
        q4: await one("Unique exam question number 4 about percentages?"),
        linkedNodes: (await c.query(
          `SELECT n.code FROM question_taxonomy t JOIN taxonomy_nodes n ON n.id = t.node_id
             JOIN questions q ON q.id = t.question_id WHERE q.pack_id = $1 AND q.content->>'question' LIKE '%number 4 %' ORDER BY n.code`, [res.packId])).rows.map((r) => r.code),
      };
    });
    expect(db.sources).toBe(37);
    expect(db.q1).toMatchObject({
      difficulty_est: 4, language_primary: "hi", origin: "original_human", rights_status: "original", source_ref: "Book A p.4",
      source_difficulty_raw: "Hard", import_id: importId, uploaded_by: uA, links: 2,
    });
    expect(db.q1.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(db.q1.normalised_text_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(db.q2).toMatchObject({ difficulty_est: 3, source_difficulty_raw: "2" });
    // scraped_raw rows still import (the EXP-2 publish gate, not the importer, blocks them).
    expect(db.q3).toMatchObject({ origin: "scraped_raw", rights_status: "scraped_raw", source_url: "https://example.org/q3" });
    expect(db.q4).toMatchObject({ difficulty_est: null, language_primary: "en", source_difficulty_raw: null, links: 2 });
    expect(db.linkedNodes).toEqual(["percentage", "ssc-cgl-tier-1"]);
  });

  it("committed rows are existing duplicates for the next file, by exact and by normalised text", async () => {
    const next = buildCsv([
      mcq(1), // exact repeat of a committed row
      mcq(2, { question: "UNIQUE exam question number 2 about PERCENTAGES?", options: JSON.stringify(["(a) 2", "(b) 3"]) }),
      mcq(200),
    ]);
    const r = await stage(next);
    expect(r.rows.map((x) => [x.decision, x.dupClass])).toEqual([["duplicate", "exact"], ["duplicate", "normalised"], ["ok", null]]);
  });

  it("EXP-15 previewImport reports file and existing duplicates and writes nothing", async () => {
    const countImports = () => sup(async (c) => Number((await c.query(`SELECT count(*) FROM question_imports`)).rows[0].count));
    const before = await countImports();
    const data = buildCsv([mcq(1), mcq(400), mcq(400)]); // 1 = existing (committed above), 400 twice = repeat inside the file
    const prev = await previewImport(tA, meta(data), await parseImportFile("csv", data));
    expect(prev.rows.map((x) => [x.decision, x.dupScope])).toEqual([["duplicate", "existing"], ["ok", null], ["duplicate", "file"]]);
    expect(await countImports()).toBe(before);
  });

  it("an old-style file without rights_status gives a row error per row, not a file error", async () => {
    const old = Buffer.from("type,topic,question,options,correct,rationale\r\nmcq,T,Old file question?,\"[\"\"a\"\",\"\"b\"\"]\",0,why\r\n", "utf8");
    const r = await stage(old);
    expect(r.counts).toMatchObject({ total: 1, error: 1, ok: 0 });
    expect(r.rows[0]!.errors[0]).toMatchObject({ column: "rights_status" });
  });

  it("fixing the rights_status cell turns the error row into a ready row", async () => {
    const f = buildCsv([mcq(300, { rights_status: "" })]);
    const r = await stage(f);
    expect(r.counts.error).toBe(1);
    const fixed = await fixImportRow(tA, uA, r.importId, 2, { values: { rights_status: "licensed" } });
    expect(fixed.counts).toMatchObject({ ok: 1, error: 0 });
    expect(fixed.rows[0]!.normalized!.meta).toMatchObject({ rightsStatus: "licensed", origin: "licensed" });
  });

  it("with pg_trgm installed the similar class runs: flagged, still ok", async () => {
    await sup((c) => c.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`));
    const near = buildCsv([mcq(1, { question: "Unique exam question number 1 about percentage?", options: JSON.stringify(["x", "y"]) })]);
    const r = await stage(near);
    expect(r.checksRun).toEqual(["exact", "normalised", "similar"]);
    expect(r.rows[0]).toMatchObject({ decision: "ok", dupClass: "similar" });
    expect(r.duplicateClasses.similar).toBe(1);
  });

  it("EXP-21: skipTrigram runs no similar class; default still does", async () => {
    const near = buildCsv([mcq(1, { question: "Unique exam question number 1 about percentage?", options: JSON.stringify(["p", "q"]) })]);
    const m = { ...meta(near), fileSha256: sha256Hex(Buffer.concat([near, Buffer.from("skip")])) };
    const skipped = await stageImport(tA, uA, { ...m, skipTrigram: true }, await parseImportFile("csv", near));
    expect(skipped.checksRun).toEqual(["exact", "normalised"]);
    expect(skipped.rows[0]).toMatchObject({ decision: "ok", dupClass: null });
    expect((await getImportReport(tA, skipped.importId)).checksRun).toEqual(["exact", "normalised"]); // flag is stored
    const dflt = await stage(near);
    expect(dflt.checksRun).toEqual(["exact", "normalised", "similar"]);
    expect(dflt.rows[0]).toMatchObject({ dupClass: "similar" });
  });

  it("EXP-21: template_generated origin imports; old rows with null hashes are still exact duplicates", async () => {
    const gen = buildCsv([mcq(300, { origin: "template_generated" })]);
    const r = await stage(gen);
    expect(r.rows[0]).toMatchObject({ decision: "ok" });
    const res = await commitImport(tA, uA, r.importId, { mode: "skip-errors" });
    const o = await sup(async (c) => {
      const row = (await c.query(`SELECT s.origin FROM question_source s JOIN questions q ON q.id = s.question_id
         WHERE q.pack_id = $1`, [res.packId])).rows[0];
      await c.query(`UPDATE question_source SET content_hash = NULL, normalised_text_hash = NULL`); // simulate pre-0194 rows
      return row.origin;
    });
    expect(o).toBe("template_generated");
    const again = await stage(buildCsv([mcq(300), mcq(1)]));
    expect(again.rows.map((x) => [x.decision, x.dupClass])).toEqual([["duplicate", "exact"], ["duplicate", "exact"]]);
  });
});
