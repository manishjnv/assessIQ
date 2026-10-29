/**
 * FUT-2 against a real Postgres: a tenant admin never sees the answer key, rubric or source reference of
 * licensed (platform-owned) content; own uploads stay visible; a super admin sees everything; another
 * tenant cannot read the row at all. Fake data only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { createPack, addLevel } from "../service/packs.js";
import { createQuestion, listQuestions, getQuestion, listVersions } from "../service/questions.js";
import { getPackReview } from "../service/review.js";

let container: StartedTestContainer;
let url: string;
let tP = "";
let uP = "";
const tA = randomUUID();
const tB = randomUUID();
const uA = randomUUID();
const uB = randomUUID();
let licensedQ = "";
let ownQ = "";
let clonePack = "";
let ownPack = "";

const KEY = "SECRET-KEY-TEXT";

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

const content = (label: string) => ({ question: `${label} ${randomUUID()}?`, options: ["a", "b"], correct: 1, rationale: KEY });

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
      await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Admin','admin','active')`, [uid, id, email]);
      await c.query(`INSERT INTO domains (tenant_id, slug, name) VALUES ($1,'soc','SOC') ON CONFLICT DO NOTHING`, [id]);
    }
  });

  // Platform master question.
  const mp = await createPack(tP, { name: `Master ${randomUUID().slice(0, 8)}`, domain: "soc" }, uP);
  const ml = await addLevel(tP, mp.id, { label: "L1" }, uP);
  const master = await createQuestion(tP, { pack_id: mp.id, level_id: ml.id, type: "mcq", topic: "m", points: 1, content: content("Master") }, uP);

  // Licensed copy inside tenant A (clone mode: source_question_id set) with rubric, version and source ref.
  const cp = await createPack(tA, { name: `Clone ${randomUUID().slice(0, 8)}`, domain: "soc" }, uA);
  clonePack = cp.id;
  const cl = await addLevel(tA, cp.id, { label: "L1" }, uA);
  const lq = await createQuestion(tA, { pack_id: cp.id, level_id: cl.id, type: "mcq", topic: "c", points: 1, content: content("Clone") }, uA);
  licensedQ = lq.id;

  // Own upload in tenant A (no source_question_id).
  const op = await createPack(tA, { name: `Own ${randomUUID().slice(0, 8)}`, domain: "soc" }, uA);
  ownPack = op.id;
  const ol = await addLevel(tA, op.id, { label: "L1" }, uA);
  const oq = await createQuestion(tA, { pack_id: op.id, level_id: ol.id, type: "mcq", topic: "o", points: 1, content: content("Own") }, uA);
  ownQ = oq.id;

  await sup(async (c) => {
    await c.query(`UPDATE questions SET source_question_id=$2, rubric=$3::jsonb WHERE id=$1`, [licensedQ, master.id, JSON.stringify({ secret: KEY })]);
    await c.query(`UPDATE questions SET rubric=$2::jsonb WHERE id=$1`, [ownQ, JSON.stringify({ secret: KEY })]);
    for (const q of [licensedQ, ownQ]) {
      await c.query(
        `INSERT INTO question_versions (question_id, version, content, rubric, saved_by) VALUES ($1, 77, $2::jsonb, $3::jsonb, $4)`,
        [q, JSON.stringify(content("Version")), JSON.stringify({ secret: KEY }), uA],
      );
      await c.query(
        `UPDATE question_source SET source_ref='REF-SECRET', source_url='https://x.example/secret' WHERE question_id=$1`,
        [q],
      );
    }
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

const json = (v: unknown): string => JSON.stringify(v);

describe("FUT-2 key hiding", () => {
  it("tenant admin: licensed question has no key, rubric or translations (single read)", async () => {
    const q = await getQuestion(tA, licensedQ, "admin");
    expect(json(q)).not.toContain(KEY);
    expect(q.rubric).toBeNull();
    expect(q.licensed).toBe(true);
    const c = q.content as Record<string, unknown>;
    expect(c["question"]).toBeTruthy();
    expect([...(c["options"] as string[])].sort()).toEqual(["a", "b"]);
    expect(c).not.toHaveProperty("correct");
    expect(c).not.toHaveProperty("rationale");
  });

  it("tenant admin: list and versions are redacted too", async () => {
    const list = await listQuestions(tA, { pack_id: clonePack, page: 1, pageSize: 20 }, "admin");
    expect(list.items.length).toBeGreaterThan(0);
    expect(json(list)).not.toContain(KEY);
    const vers = await listVersions(tA, licensedQ, "admin");
    expect(vers.length).toBeGreaterThan(0);
    expect(json(vers)).not.toContain(KEY);
    expect(vers.every((v) => v.rubric === null)).toBe(true);
  });

  it("tenant admin: pack review hides key, rubric, source_ref and source_url of licensed items", async () => {
    const r = await getPackReview({ tenantId: tA, userId: uA, role: "admin" }, clonePack, "all", 1, 50);
    expect(r.items.length).toBeGreaterThan(0);
    const raw = json(r);
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain("REF-SECRET");
    expect(raw).not.toContain("x.example/secret");
  });

  it("tenant admin: an own upload stays fully visible", async () => {
    const q = await getQuestion(tA, ownQ, "admin");
    expect(q.licensed).toBe(false);
    expect(json(q)).toContain(KEY);
    expect(q.rubric).not.toBeNull();
    const vers = await listVersions(tA, ownQ, "admin");
    expect(json(vers)).toContain(KEY);
    const r = await getPackReview({ tenantId: tA, userId: uA, role: "admin" }, ownPack, "all", 1, 50);
    expect(json(r)).toContain(KEY);
    expect(json(r)).toContain("REF-SECRET");
  });

  it("super admin sees the licensed copy in full; internal callers (no role) get the raw row", async () => {
    expect(json(await getQuestion(tA, licensedQ, "super_admin"))).toContain(KEY);
    expect(json(await getQuestion(tA, licensedQ))).toContain(KEY);
    expect(json(await listVersions(tA, licensedQ, "super_admin"))).toContain(KEY);
  });

  it("another tenant cannot read the question at all", async () => {
    await expect(getQuestion(tB, licensedQ, "admin")).rejects.toThrow(/not found/i);
    await expect(getQuestion(tB, ownQ, "admin")).rejects.toThrow(/not found/i);
  });
});
