/**
 * EXP-8: passages (migration 0211) against a real Postgres: RLS isolation, immutability,
 * import with passage_ref / passage_text, clone copies the passage once per target tenant.
 * Fake data only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { csvCell, sha256Hex } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { parseImportFile } from "../import/parse.js";
import { stageImport, fixImportRow } from "../import/staging.js";
import { commitImport } from "../import/commit.js";
import { createPack, addLevel, publishPack } from "../service/packs.js";
import { createQuestion } from "../service/questions.js";
import { materializeSetForTenant } from "../clone.js";

let container: StartedTestContainer;
let url: string;
let tP = "";
let uP = "";
const tA = randomUUID();
const tB = randomUUID();
const uA = randomUUID();
const uB = randomUUID();

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

const COLS = ["type", "topic", "points", "level", "question", "options", "correct", "rationale", "rights_status", "passage_ref", "passage_text"];
type Cells = Partial<Record<(typeof COLS)[number], string>>;
const buildCsv = (rows: Cells[]): Buffer =>
  Buffer.from([COLS, ...rows.map((r) => COLS.map((c) => r[c] ?? ""))].map((r) => r.map(csvCell).join(",")).join("\r\n"), "utf8");
const mcq = (n: number, extra: Cells = {}): Cells => ({
  type: "mcq", topic: "Reading", points: "1", level: "1", question: `Passage test question number ${n} ${randomUUID()}?`,
  options: JSON.stringify([`${n}`, `${n + 1}`]), correct: "1", rationale: "r", rights_status: "original", ...extra,
});
const meta = (data: Buffer) => ({ fileName: "p.csv", fileSha256: sha256Hex(data), format: "csv" as const, domain: "soc", packName: "Passage set" });
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
  await setPoolForTesting(url);
  await sup(async (c) => {
    tP = (await c.query(`SELECT id FROM tenants WHERE slug='platform'`)).rows[0].id;
    uP = (await c.query(`SELECT id FROM users WHERE tenant_id=$1 LIMIT 1`, [tP])).rows[0].id;
    for (const [id, slug, uid, email] of [[tA, "ta", uA, "a@x.io"], [tB, "tb", uB, "b@x.io"]] as const) {
      await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$2)`, [id, slug]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
      await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Admin','super_admin','active')`, [uid, id, email]);
    }
    for (const t of [tP, tA, tB]) await c.query(`INSERT INTO domains (tenant_id, slug, name) VALUES ($1,'soc','SOC') ON CONFLICT DO NOTHING`, [t]);
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

describe("passages table", () => {
  it("is tenant isolated and immutable", async () => {
    const id = randomUUID();
    await withTenant(tA, (c) => c.query(`INSERT INTO passages (id, tenant_id, body) VALUES ($1,$2,'Read the text.')`, [id, tA]));
    expect((await withTenant(tB, (c) => c.query(`SELECT 1 FROM passages WHERE id=$1`, [id]))).rowCount).toBe(0);
    expect((await withTenant(tA, (c) => c.query(`SELECT 1 FROM passages WHERE id=$1`, [id]))).rowCount).toBe(1);
    await expect(withTenant(tB, (c) => c.query(`INSERT INTO passages (tenant_id, body) VALUES ($1,'x')`, [tA]))).rejects.toThrow();
    await expect(sup((c) => c.query(`UPDATE passages SET body='changed' WHERE id=$1`, [id]))).rejects.toThrow(/immutable/);
  });
});

describe("import passage_ref", () => {
  it("rows with the same passage_ref share one passage, in file order; a ref without text fails its rows", async () => {
    const data = buildCsv([
      mcq(1, { passage_ref: "P1", passage_text: "Read the text. 2+2?" }),
      mcq(3, { passage_ref: "P1" }),
      mcq(5), // standalone
      mcq(7, { passage_ref: "P2" }), // no text anywhere in group P2
    ]);
    const report = await stage(data);
    expect(report.rows.map((r) => r.errors.some((e) => e.column === "passage_text"))).toEqual([false, false, false, true]);
    const res = await commitImport(tA, uA, report.importId, { mode: "skip-errors" });
    expect(res.committed).toBe(3);
    const rows = await sup(async (c) => (await c.query(
      `SELECT q.passage_id, q.passage_position, p.body, p.tenant_id FROM questions q LEFT JOIN passages p ON p.id=q.passage_id
        WHERE q.pack_id=$1 ORDER BY q.passage_position NULLS LAST`, [res.packId])).rows);
    const withP = rows.filter((r) => r.passage_id !== null);
    expect(withP).toHaveLength(2);
    expect(withP[0]!.passage_id).toBe(withP[1]!.passage_id);
    expect(withP.map((r) => r.passage_position)).toEqual([1, 2]);
    expect(withP[0]).toMatchObject({ body: "Read the text. 2+2?", tenant_id: tA });
    expect(rows.filter((r) => r.passage_id === null)).toHaveLength(1);
  });

  it("editing a row of a passage group keeps the shared passage text on every row (gate finding)", async () => {
    const data = buildCsv([
      mcq(11, { passage_ref: "P3" }), // text lives on the second row
      mcq(13, { passage_ref: "P3", passage_text: "Shared text for P3." }),
    ]);
    const report = await stage(data);
    expect(report.rows.every((r) => r.errors.length === 0)).toBe(true);
    const fixed = await fixImportRow(tA, uA, report.importId, report.rows[0]!.row, { values: { question: `Edited stem number 11 ${randomUUID()}?` } });
    expect(fixed.rows.every((r) => r.errors.length === 0)).toBe(true);
    const res = await commitImport(tA, uA, report.importId, { mode: "skip-errors" });
    expect(res.committed).toBe(2);
    const rows = await sup(async (c) => (await c.query(
      `SELECT p.body FROM questions q JOIN passages p ON p.id=q.passage_id WHERE q.pack_id=$1`, [res.packId])).rows);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.body === "Shared text for P3.")).toBe(true);
  });
});

describe("clone", () => {
  it("copies the passage once per target tenant and keeps the position", async () => {
    const pack = await createPack(tP, { name: `Pack ${randomUUID().slice(0, 8)}`, domain: "soc" }, uP);
    const level = await addLevel(tP, pack.id, { label: "L1" }, uP);
    const mk = (n: number) => createQuestion(tP, { pack_id: pack.id, level_id: level.id, type: "mcq", topic: `t${n}`, points: 1,
      content: { question: `Clone passage ${n} ${randomUUID()}?`, options: ["a", "b"], correct: 0, rationale: "r" } }, uP);
    const [q1, q2, q3] = [await mk(1), await mk(2), await mk(3)];
    const pid = randomUUID();
    await sup(async (c) => {
      await c.query(`INSERT INTO passages (id, tenant_id, title, body) VALUES ($1,$2,'T','Master passage text')`, [pid, tP]);
      await c.query(`UPDATE questions SET passage_id=$2, passage_position=2 WHERE id=$1`, [q1.id, pid]);
      await c.query(`UPDATE questions SET passage_id=$2, passage_position=1 WHERE id=$1`, [q2.id, pid]);
    });
    await publishPack(tP, pack.id, uP);
    for (const [tenant, user] of [[tA, uA], [tB, uB]] as const) {
      const clone = await materializeSetForTenant(pack.id, tenant, user);
      const rows = await sup(async (c) => (await c.query(
        `SELECT q.source_question_id, q.passage_id, q.passage_position, p.tenant_id, p.body, p.title, p.source_passage_id
           FROM questions q LEFT JOIN passages p ON p.id=q.passage_id WHERE q.pack_id=$1`, [clone.clonedPackId])).rows);
      const by = (id: string) => rows.find((r) => r.source_question_id === id)!;
      expect(by(q1.id)).toMatchObject({ tenant_id: tenant, body: "Master passage text", title: "T", source_passage_id: pid, passage_position: 2 });
      expect(by(q2.id).passage_id).toBe(by(q1.id).passage_id);
      expect(by(q2.id).passage_position).toBe(1);
      expect(by(q3.id).passage_id).toBeNull();
    }
    const copies = await sup(async (c) => (await c.query(`SELECT tenant_id FROM passages WHERE source_passage_id=$1`, [pid])).rows.map((r) => r.tenant_id).sort());
    expect(copies).toEqual([tA, tB].sort());
  });
});
