/**
 * Clone-on-grant and resync copy question_taxonomy links (subject, stage) onto the tenant copy,
 * linking the SAME platform node ids. Real Postgres. Without the copy a node-filtered draw on
 * the clone returned zero items (imported platform items have no category_id).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { createPack, addLevel, publishPack } from "../service/packs.js";
import { createQuestion } from "../service/questions.js";
import { materializeSetForTenant } from "../clone.js";
import { resyncSetForTenant } from "../clone/resync.js";

const MCQ = { question: "Which port is HTTPS?", options: ["80", "443", "22", "25"], correct: 1, rationale: "r" };

let container: StartedTestContainer;
let url: string;
let tP = "";
let uP = "";
let subject = "";
let stage = "";
const [tA, tB, uA, uB] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

/** Run as the app role for one tenant, always rolled back. */
async function asTenant<T>(tenant: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE assessiq_app");
    await c.query("SELECT set_config('app.current_tenant', $1, true)", [tenant]);
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await c.end();
  }
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
    for (const [id, slug, uid, email] of [[tA, "ta", uA, "a@x.io"], [tB, "tb", uB, "b@x.io"]] as const) {
      await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$2)`, [id, slug]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
      await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Admin','admin','active')`, [uid, id, email]);
    }
    const fw = (await c.query(`INSERT INTO frameworks (tenant_id, slug, name) VALUES (NULL,'cl-tax','CL') RETURNING id`)).rows[0].id;
    const node = async (kind: string, code: string) =>
      (await c.query(`INSERT INTO taxonomy_nodes (tenant_id, framework_id, parent_id, kind, code, label) VALUES (NULL,$1,NULL,$2,$3,$3) RETURNING id`, [fw, kind, code])).rows[0].id as string;
    subject = await node("subject", "cl-subject");
    stage = await node("stage", "cl-stage");
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

const links = (tenant: string, sourceIds: string[]) =>
  sup(async (c) => (await c.query(
    `SELECT q.source_question_id AS src, qt.node_id, qt.tenant_id
       FROM question_taxonomy qt JOIN questions q ON q.id=qt.question_id JOIN question_packs p ON p.id=q.pack_id
      WHERE p.tenant_id=$1 AND q.source_question_id = ANY($2::uuid[]) ORDER BY q.source_question_id, qt.node_id`,
    [tenant, sourceIds])).rows as { src: string; node_id: string; tenant_id: string }[]);

async function seed() {
  const pack = await createPack(tP, { name: `Pack ${randomUUID().slice(0, 8)}`, domain: "soc" }, uP);
  const level = await addLevel(tP, pack.id, { label: "L1" }, uP);
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const q = await createQuestion(tP, { pack_id: pack.id, level_id: level.id, type: "mcq", topic: `t${i}`, points: 1, content: { ...MCQ, question: `Q ${randomUUID()}?` } }, uP);
    ids.push(q.id);
  }
  // q0 has subject + stage; q1 has subject only. Imported items carry no category_id.
  await sup(async (c) => {
    await c.query(`INSERT INTO question_taxonomy (question_id, node_id) VALUES ($1,$2),($1,$3),($4,$2)`, [ids[0], subject, stage, ids[1]]);
  });
  await publishPack(tP, pack.id, uP);
  return { pack, level, ids };
}

describe("clone copies question_taxonomy", () => {
  it("clone-on-grant links the clone to the same platform node ids, owned by the tenant", async () => {
    const { pack, ids } = await seed();
    await materializeSetForTenant(pack.id, tA, uA);
    const rows = await links(tA, ids);
    expect(rows.map((r) => [r.src, r.node_id].join()).sort()).toEqual(
      [[ids[0], subject], [ids[0], stage], [ids[1], subject]].map((x) => x.join()).sort());
    expect(rows.every((r) => r.tenant_id === tA)).toBe(true);
  });

  it("a node-filtered draw on the cloned pack finds the items (subject node join)", async () => {
    const { pack, ids } = await seed();
    await materializeSetForTenant(pack.id, tA, uA);
    const n = await asTenant(tA, async (c) => (await c.query(
      `SELECT count(*)::int n FROM questions q JOIN question_packs p ON p.id=q.pack_id
         JOIN question_taxonomy qt ON qt.question_id=q.id
        WHERE qt.node_id=$1 AND q.status='active' AND q.source_question_id = ANY($2::uuid[])`, [subject, ids])).rows[0].n);
    expect(n).toBe(2);
  });

  it("resync twice leaves no duplicates and copies links of a newly added master item", async () => {
    const { pack, level, ids } = await seed();
    await materializeSetForTenant(pack.id, tA, uA);
    // platform adds a third item with a subject link, then bumps the pack version
    const q3 = await createQuestion(tP, { pack_id: pack.id, level_id: level.id, type: "mcq", topic: "t3", points: 1, content: { ...MCQ, question: `Q ${randomUUID()}?` } }, uP);
    await sup(async (c) => {
      await c.query(`INSERT INTO question_taxonomy (question_id, node_id) VALUES ($1,$2)`, [q3.id, subject]);
      await c.query(`UPDATE questions SET status='active' WHERE id=$1`, [q3.id]);
      await c.query(`UPDATE question_packs SET version = version + 1 WHERE id=$1`, [pack.id]);
    });
    await resyncSetForTenant(pack.id, tA, uA);
    const all = [...ids, q3.id];
    const first = await links(tA, all);
    expect(first).toHaveLength(4);
    expect(first.some((r) => r.src === q3.id && r.node_id === subject)).toBe(true);
    await sup((c) => c.query(`UPDATE question_packs SET version = version + 1 WHERE id=$1`, [pack.id]));
    await resyncSetForTenant(pack.id, tA, uA);
    expect(await links(tA, all)).toEqual(first);
  });

  it("RLS: tenant B cannot see tenant A's cloned links", async () => {
    const { pack, ids } = await seed();
    await materializeSetForTenant(pack.id, tA, uA);
    const count = (t: string) => asTenant(t, async (c) => (await c.query(
      `SELECT count(*)::int n FROM question_taxonomy qt JOIN questions q ON q.id=qt.question_id
        WHERE q.source_question_id = ANY($1::uuid[])`, [ids])).rows[0].n as number);
    expect(await count(tB)).toBe(0);
    expect(await count(tA)).toBe(3);
  });
});
