/**
 * S109-D6: retagBySeedPrefix. postgres:16 testcontainer, same scaffold as subject-map-load.test.ts.
 * Covers: dry run writes nothing, commit swaps only the from-node link (stage link stays), idempotent second run,
 * other prefix untouched, bad prefix / unknown node / non-outcome target rejected, skipped count, includeClones.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { loadFrameworkSeed } from "../framework-seeds.js";
import { retagBySeedPrefix } from "../service/retag.js";

let container: StartedTestContainer;
let url = "";
let tP = "";
const tA = randomUUID();
const userP = randomUUID();
const FROM = "quant/geometry/lines-and-angles";
const TO = "quant/geometry/coordinate-geometry";
const ctx = () => ({ tenantId: tP, userId: userP, role: "super_admin" });
const mv = (seedPrefix: string, fromNode = FROM, toNode = TO) => ({ seedPrefix, fromNode, toNode });

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
const node = (c: Client, path: string) => c.query(
  `SELECT n.id FROM taxonomy_nodes n JOIN taxonomy_nodes p ON p.id = n.parent_id WHERE n.code = $1 AND p.code = $2 AND n.tenant_id IS NULL`,
  [path.split("/")[2], path.split("/")[1]]).then((r) => r.rows[0].id as string);
const links = (q: string) => sup(async (c) => (await c.query(`SELECT node_id FROM question_taxonomy WHERE question_id = $1`, [q])).rows.map((r) => r.node_id as string));

let stageNode = "";
let fromId = "";
let toId = "";

/** A pack with one level and one template_generated question per seed_ref, each linked to the given nodes. */
async function mkRows(tenant: string, slug: string, refs: string[], nodeIds: string[], source: string | null = null): Promise<string[]> {
  return sup(async (c) => {
    const pack = randomUUID(); const level = randomUUID();
    await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, version, created_by, source) VALUES ($1,$2,$3,'P','aptitude','published',1,$4,'import')`, [pack, tenant, slug, userP]);
    await c.query(`INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count) VALUES ($1,$2,1,'L1',30,10)`, [level, pack]);
    const ids: string[] = [];
    for (const ref of refs) {
      const q = randomUUID(); ids.push(q);
      await c.query(`INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, created_by, source_question_id) VALUES ($1,$2,$3,'mcq','t',1,'active',$4::jsonb,$5,$6)`,
        [q, pack, level, JSON.stringify({ question: ref, options: [{ id: "a", text: "x" }, { id: "b", text: "y" }], correct: "a" }), userP, source]);
      await c.query(`INSERT INTO question_source (tenant_id, question_id, origin, rights_status, seed_ref) VALUES ($1,$2,'template_generated','original',$3)`, [tenant, q, ref]);
      for (const n of nodeIds) await c.query(`INSERT INTO question_taxonomy (question_id, node_id) VALUES ($1,$2)`, [q, n]);
    }
    return ids;
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
  await sup((c) => applyAllMigrations(c));
  await setPoolForTesting(url);
  await sup(async (c) => {
    tP = (await c.query(`SELECT id FROM tenants WHERE slug='platform'`)).rows[0].id;
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'p-retag@x.io','Admin','super_admin','active')`, [userP, tP]);
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'org-a','Org A')`, [tA]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [tA]);
  });
  await loadFrameworkSeed(userP, "subject-map");
  await loadFrameworkSeed(userP, "exam-structure");
  await sup(async (c) => {
    fromId = await node(c, FROM);
    toId = await node(c, TO);
    stageNode = (await c.query(`SELECT n.id FROM taxonomy_nodes n JOIN frameworks f ON f.id = n.framework_id WHERE f.slug = 'exam-structure' AND n.kind = 'stage' LIMIT 1`)).rows[0].id;
  });
}, 180_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

describe("retagBySeedPrefix", () => {
  it("dry run writes nothing, commit moves the 3, keeps the stage link, leaves geom.y, second commit changes 0", async () => {
    const [a, b, c3, g] = await mkRows(tP, "retag-main", ["coord.x@1", "coord.x@2", "coord.x@3", "geom.y@1"], [fromId, stageNode]);
    const dry = await retagBySeedPrefix(ctx(), { moves: [mv("coord.x@")] });
    expect(dry.dryRun).toBe(true);
    expect(dry.moves[0]).toMatchObject({ matched: 3, changed: 0, skippedNotInFromNode: 0, changedByPack: { "retag-main": 3 } });
    expect((await links(a!)).sort()).toEqual([fromId, stageNode].sort());

    const done = await retagBySeedPrefix(ctx(), { moves: [mv("coord.x@")], dryRun: false });
    expect(done.totals).toMatchObject({ matched: 3, changed: 3, skippedNotInFromNode: 0 });
    for (const q of [a!, b!, c3!]) expect((await links(q)).sort()).toEqual([toId, stageNode].sort());
    expect((await links(g!)).sort()).toEqual([fromId, stageNode].sort());

    const again = await retagBySeedPrefix(ctx(), { moves: [mv("coord.x@")], dryRun: false });
    expect(again.totals.changed).toBe(0);
    expect(again.totals.skippedNotInFromNode).toBe(3);
  });

  it("counts a prefix row without the from-node link as skipped and never changes it", async () => {
    const [q] = await mkRows(tP, "retag-skip", ["skip.z@1"], [stageNode]);
    const r = await retagBySeedPrefix(ctx(), { moves: [mv("skip.z@")], dryRun: false });
    expect(r.moves[0]).toMatchObject({ matched: 1, changed: 0, skippedNotInFromNode: 1 });
    expect(await links(q!)).toEqual([stageNode]);
  });

  it("rejects a prefix without @, an unknown node path and a non-outcome target", async () => {
    await expect(retagBySeedPrefix(ctx(), { moves: [mv("coord.x")] })).rejects.toThrow();
    await expect(retagBySeedPrefix(ctx(), { moves: [mv("coord.x@", FROM, "quant/geometry/nope")] })).rejects.toThrow(/not found/);
    await expect(retagBySeedPrefix(ctx(), { moves: [mv("coord.x@", FROM, "quant/geometry")] })).rejects.toThrow(/not an outcome/);
  });

  it("includeClones swaps the link on organisation clones of a re-tagged master", async () => {
    const [m] = await mkRows(tP, "retag-clone-src", ["cl.q@1"], [fromId]);
    const [cl] = await mkRows(tA, "retag-clone-dst", ["cl.q@1"], [fromId, stageNode], m!);
    const dry = await retagBySeedPrefix(ctx(), { moves: [mv("cl.q@")], includeClones: true });
    expect(dry.moves[0]!.clonesChanged).toBe(1);
    expect(await links(cl!)).toContain(fromId);
    const r = await retagBySeedPrefix(ctx(), { moves: [mv("cl.q@")], includeClones: true, dryRun: false });
    expect(r.totals).toMatchObject({ changed: 1, clonesChanged: 1 });
    expect((await links(cl!)).sort()).toEqual([toId, stageNode].sort());
    expect(await links(m!)).toEqual([toId]);
  });
});
