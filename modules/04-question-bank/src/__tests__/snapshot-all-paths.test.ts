/**
 * T-62 part 2: snapshot at every activation path (updateQuestion, bulkUpdateQuestionStatus), organisation mode of
 * backfillMissingSnapshots, activation bumps the master pack version and pushes new rows to organisation clones,
 * and syncClonesForPack (dry run = the real resync in a rolled-back tx; commit). Real Postgres.
 * Note: SYNC_CLONES_ON_ACTIVATION is a module constant; only its `true` value is tested (no setter is exported).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool, withTenant } from "@assessiq/tenancy";
import { listActiveQuestionPoolForPick } from "../../../06-attempt-engine/src/repository.js";
import * as repo from "../repository.js";
import { activateAllQuestionsForPack, activateQuestionsByIds, backfillMissingSnapshots, syncClonesForPack } from "../service/packs.js";
import { verifyQuestionsByIds } from "../service/review.js";
import { updateQuestion, bulkUpdateQuestionStatus } from "../service/questions.js";
import { materializeSetForTenant } from "../clone.js";

const MCQ = { question: "Edited?", options: ["3", "4", "5", "6"], correct: 1, rationale: "r" };

let container: StartedTestContainer;
let url = "";
let tP = "";
let uP = "";
const [tA, uA, tB, uB] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const superP = () => ({ tenantId: tP, userId: uP, role: "super_admin" });
const adminA = () => ({ tenantId: tA, userId: uA, role: "admin" });

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function mkPack(tenant: string, user: string, slug: string): Promise<{ pack: string; level: string }> {
  return sup(async (c) => {
    const pack = randomUUID(); const level = randomUUID();
    await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, version, created_by, source) VALUES ($1,$2,$3,'P','aptitude','published',1,$4,'import')`, [pack, tenant, slug, user]);
    await c.query(`INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count) VALUES ($1,$2,1,'L1',30,10)`, [level, pack]);
    return { pack, level };
  });
}

async function importRow(tenant: string, user: string, p: { pack: string; level: string }, reviewState: "in_review" | "verified" = "verified", negativeMarks?: number): Promise<string> {
  const id = randomUUID();
  await withTenant(tenant, async (client) => {
    await repo.insertQuestion(client, {
      id, packId: p.pack, levelId: p.level, type: "mcq", topic: "t", points: 1,
      content: { question: `Q ${id}?`, options: [{ id: "a", text: "x" }, { id: "b", text: "y" }], correct: "a" },
      createdBy: user, rightsStatus: "original" as never, reviewState,
      ...(negativeMarks !== undefined ? { negativeMarks } : {}),
    });
  });
  return id;
}

const row = (id: string) => sup(async (c) => (await c.query(`SELECT status, review_state, version FROM questions WHERE id=$1`, [id])).rows[0] as { status: string; review_state: string | null; version: number });
const snaps = (id: string) => sup(async (c) => (await c.query(`SELECT version FROM question_versions WHERE question_id=$1 ORDER BY version`, [id])).rows.map((r) => r.version as number));
const packRow = (id: string) => sup(async (c) => (await c.query(`SELECT version, source_version, status FROM question_packs WHERE id=$1`, [id])).rows[0] as { version: number; source_version: number | null; status: string });
const audits = (tenant: string, action: string, entityId?: string) => sup(async (c) =>
  (await c.query(`SELECT entity_id, before, after FROM audit_log WHERE tenant_id=$1 AND action=$2 AND ($3::text IS NULL OR entity_id::text=$3) ORDER BY id`, [tenant, action, entityId ?? null])).rows);
const pool = (tenant: string, p: { pack: string; level: string }) => withTenant(tenant, (client) => listActiveQuestionPoolForPick(client, p.pack, p.level));
const cloneOf = (tenant: string, src: string) => sup(async (c) => {
  const r = (await c.query(`SELECT p.id AS pack, l.id AS level FROM question_packs p JOIN levels l ON l.pack_id = p.id WHERE p.tenant_id=$1 AND p.source_pack_id=$2 LIMIT 1`, [tenant, src])).rows[0];
  return { pack: r.pack as string, level: r.level as string };
});
const cloneRows = (clonePack: string) => sup(async (c) => (await c.query(`SELECT id, source_question_id, status FROM questions WHERE pack_id=$1 ORDER BY id`, [clonePack])).rows as Array<{ id: string; source_question_id: string | null; status: string }>);
/** Whole-database fingerprint: any write to the tables a sync touches changes it. */
const fingerprint = () => sup(async (c) => {
  const q = await c.query(`SELECT
    (SELECT md5(coalesce(string_agg(id::text||status||version::text||content::text, ',' ORDER BY id), '')) FROM questions) AS q,
    (SELECT count(*)::int FROM question_versions) AS qv,
    (SELECT md5(coalesce(string_agg(id::text||version::text||coalesce(source_version,-1)::text||status, ',' ORDER BY id), '')) FROM question_packs) AS p,
    (SELECT count(*)::int FROM audit_log) AS a,
    (SELECT count(*)::int FROM levels) AS lv,
    (SELECT count(*)::int FROM question_assets) AS qa,
    (SELECT count(*)::int FROM tags) AS tg,
    (SELECT count(*)::int FROM question_tags) AS qt,
    (SELECT count(*)::int FROM question_source) AS qs`);
  return q.rows[0] as Record<string, unknown>;
});

/** Platform master pack with one active, snapshotted base row. */
async function mkMaster(slug: string) {
  const p = await mkPack(tP, uP, slug);
  const base = await importRow(tP, uP, p);
  await activateQuestionsByIds(superP(), [base]);
  return { p, base };
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
    for (const [id, slug, uid, email] of [[tA, "ta-all", uA, "a-all@x.io"], [tB, "tb-all", uB, "b-all@x.io"]] as const) {
      await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$2)`, [id, slug]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
      await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Admin','admin','active')`, [uid, id, email]);
    }
  });
}, 180_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

describe("A: snapshot at the remaining activation paths", () => {
  it("1: updateQuestion draft -> active snapshots the row; status + content in one call has no UNIQUE error", async () => {
    const p = await mkPack(tP, uP, "sap-1");
    const q = await importRow(tP, uP, p);
    const v0 = (await row(q)).version;
    await updateQuestion(tP, q, { status: "active" } as never, uP);
    expect(await snaps(q)).toEqual([v0]);
    expect((await row(q)).version).toBe(v0 + 1);
    expect(await pool(tP, p)).toEqual([{ id: q, version: v0 }]);
    expect((await audits(tP, "question.updated", q)).length).toBeGreaterThan(0);

    // combined, row with NO snapshot: one snapshot holding the NEW content (no old-content snapshot).
    const q2 = await importRow(tP, uP, p);
    const w0 = (await row(q2)).version;
    await updateQuestion(tP, q2, { status: "active", content: MCQ } as never, uP);
    expect(await snaps(q2)).toEqual([w0]);
    expect((await row(q2)).version).toBe(w0 + 1);
    expect((await pool(tP, p)).find((r) => r.id === q2)).toEqual({ id: q2, version: w0 });
    const only = await sup(async (c) => (await c.query(`SELECT content FROM question_versions WHERE question_id=$1`, [q2])).rows[0].content);
    expect(only.question).toBe("Edited?");
    // a later edit does not collide
    await updateQuestion(tP, q2, { content: { ...MCQ, question: "Edited again?" } } as never, uP);
    expect(await snaps(q2)).toEqual([w0, w0 + 1]);
  });

  it("1b: a row that already has a snapshot keeps the snapshot-before-update rule when status + content come together", async () => {
    const p = await mkPack(tP, uP, "sap-1b");
    const q = await importRow(tP, uP, p);
    await updateQuestion(tP, q, { status: "active" } as never, uP);
    const v1 = (await row(q)).version;
    const first = await snaps(q);
    await sup((c) => c.query(`UPDATE questions SET status='draft' WHERE id=$1`, [q]));
    await updateQuestion(tP, q, { status: "active", content: MCQ } as never, uP);
    // activation is the publish event: old content at v1, then the NEW content at v1+1, version v1+2
    expect(await snaps(q)).toEqual([...first, v1, v1 + 1]);
    expect((await row(q)).version).toBe(v1 + 2);
    const old = await sup(async (c) => (await c.query(`SELECT content FROM question_versions WHERE question_id=$1 AND version=$2`, [q, v1])).rows[0].content);
    expect(old.question).toBe(`Q ${q}?`);
  });

  it("2: bulkUpdateQuestionStatus ai_draft -> active snapshots the rows and audits snapshots_written", async () => {
    const p = await mkPack(tP, uP, "sap-2");
    const q = await importRow(tP, uP, p);
    await sup((c) => c.query(`UPDATE questions SET status='ai_draft' WHERE id=$1`, [q]));
    const v0 = (await row(q)).version;
    const r = await bulkUpdateQuestionStatus(tP, [q], "active", uP);
    expect(r.updated).toEqual([q]);
    expect(await snaps(q)).toEqual([v0]);
    expect((await row(q)).version).toBe(v0 + 1);
    expect(await pool(tP, p)).toEqual([{ id: q, version: v0 }]);
    const a = (await audits(tP, "question.updated")).filter((x) => x.after.kind === "bulk_status" && x.after.updated_ids.includes(q));
    expect(a).toHaveLength(1);
    expect(a[0].after.snapshots_written).toBe(1);
  });
});

describe("B: backfill in organisation mode", () => {
  it("3: org admin repairs its own tenant only; platform super_admin never touches org rows; wrong role/tenant pairs are refused", async () => {
    const pp = await mkPack(tP, uP, "sap-3-plat");
    const plat = await importRow(tP, uP, pp);
    const po = await mkPack(tA, uA, "sap-3-org");
    const org = await importRow(tA, uA, po);
    await sup((c) => c.query(`UPDATE questions SET status='active' WHERE id = ANY($1::uuid[])`, [[plat, org]]));

    const asAdmin = await backfillMissingSnapshots(adminA(), { commit: true });
    expect(asAdmin.packs).toEqual([{ packId: po.pack, slug: "sap-3-org", missing: 1 }]);
    expect(asAdmin).toMatchObject({ total: 1, written: 1 });
    expect(await snaps(org)).toHaveLength(1);
    expect(await snaps(plat)).toEqual([]); // platform row untouched
    expect(await audits(tP, "question.updated", pp.pack)).toHaveLength(0);
    expect(await audits(tA, "question.updated", po.pack)).toHaveLength(1);

    // platform super_admin with a slug filter: its own row only (an org row is not even reachable)
    const org2 = await importRow(tA, uA, po);
    await sup((c) => c.query(`UPDATE questions SET status='active' WHERE id=$1`, [org2]));
    const asSuper = await backfillMissingSnapshots(superP(), { commit: true, packSlugs: ["sap-3-plat"] });
    expect(asSuper).toMatchObject({ total: 1, written: 1 });
    expect(await snaps(plat)).toHaveLength(1);
    expect(await snaps(org2)).toEqual([]); // org row untouched
    await expect(backfillMissingSnapshots(superP(), { commit: false, packSlugs: ["sap-3-org"] })).rejects.toMatchObject({ details: { code: "PACK_NOT_FOUND" } });

    await expect(backfillMissingSnapshots({ tenantId: tA, userId: uA, role: "super_admin" }, { commit: true })).rejects.toMatchObject({ name: "AuthzError" });
    await expect(backfillMissingSnapshots({ tenantId: tP, userId: uP, role: "admin" }, { commit: true })).rejects.toMatchObject({ name: "AuthzError" });
    expect(await snaps(org2)).toEqual([]);
  });
});

describe("C1: activation bumps the master version and pushes new rows to organisation clones", () => {
  it("4a: activateQuestionsByIds", async () => {
    const { p } = await mkMaster("sap-4a");
    await materializeSetForTenant(p.pack, tA, uA);
    const cl = await cloneOf(tA, p.pack);
    const v = (await packRow(p.pack)).version;
    const n = await importRow(tP, uP, p);
    await activateQuestionsByIds(superP(), [n]);
    expect((await packRow(p.pack)).version).toBe(v + 1);
    const au = (await audits(tP, "question.updated", p.pack)).filter((x) => x.after.kind === "bulk_activate_by_ids");
    expect(au[au.length - 1].after.pack_version).toBe(v + 1);
    const rows = await cloneRows(cl.pack);
    const mine = rows.find((r) => r.source_question_id === n);
    expect(mine).toMatchObject({ status: "active" });
    expect(await snaps(mine!.id)).not.toEqual([]);
    expect((await pool(tA, cl)).map((r) => r.id)).toContain(mine!.id);

    // nothing activated: no bump, no pack_version
    const again = await activateQuestionsByIds(superP(), [n]);
    expect(again.activated).toBe(0);
    expect((await packRow(p.pack)).version).toBe(v + 1);
  });

  it("4b: activateAllQuestionsForPack", async () => {
    const { p } = await mkMaster("sap-4b");
    await materializeSetForTenant(p.pack, tA, uA);
    const cl = await cloneOf(tA, p.pack);
    const v = (await packRow(p.pack)).version;
    const n = await importRow(tP, uP, p, "in_review");
    await activateAllQuestionsForPack(tP, p.pack, uP);
    expect((await packRow(p.pack)).version).toBe(v + 1);
    const au = (await audits(tP, "question.updated", p.pack)).filter((x) => x.after.kind === "bulk_activate");
    expect(au[au.length - 1].after.pack_version).toBe(v + 1);
    const mine = (await cloneRows(cl.pack)).find((r) => r.source_question_id === n);
    expect(mine).toMatchObject({ status: "active" });
    expect(await snaps(mine!.id)).not.toEqual([]);
    expect((await pool(tA, cl)).map((r) => r.id)).toContain(mine!.id);

    await expect(activateAllQuestionsForPack(tP, p.pack, uP)).rejects.toMatchObject({ details: { code: "NO_DRAFT_QUESTIONS_TO_ACTIVATE" } });
    expect((await packRow(p.pack)).version).toBe(v + 1);
  });
});

describe("C2: syncClonesForPack", () => {
  it("5: dry run = real resync rolled back (no writes), commit returns the same counts, repeat is quiet; archived clone untouched", async () => {
    const { p, base } = await mkMaster("sap-5");
    await materializeSetForTenant(p.pack, tA, uA);
    await materializeSetForTenant(p.pack, tB, uB);
    const clA = await cloneOf(tA, p.pack);
    const clB = await cloneOf(tB, p.pack);
    await sup((c) => c.query(`UPDATE question_packs SET status='archived' WHERE id=$1`, [clB.pack]));
    const archivedBefore = await cloneRows(clB.pack);

    // two new master rows that are active + snapshotted but never pushed (the pre-fix state)
    const n1 = await importRow(tP, uP, p); const n2 = await importRow(tP, uP, p);
    await sup((c) => c.query(`UPDATE questions SET status='active' WHERE id = ANY($1::uuid[])`, [[n1, n2]]));
    await backfillMissingSnapshots(superP(), { commit: true, packSlugs: ["sap-5"] });
    const v = (await packRow(p.pack)).version;

    const fpBefore = await fingerprint();
    const dry = await syncClonesForPack(superP(), "sap-5", { commit: false });
    expect(await fingerprint()).toEqual(fpBefore); // questions, versions, packs (version, source_version), audit_log
    expect(dry.bumped).toBe(false);
    expect(dry.clones).toHaveLength(1); // the archived clone pack is not listed
    const d = dry.clones[0]!;
    expect(d).toMatchObject({ tenantId: tA, clonePackId: clA.pack, clonePackStatus: "published", activeMasterRows: 3, missingInClone: 2 });
    expect(d.result).toMatchObject({ updated: true, added: 2, archived: 0 });
    expect(d.unchanged).toBe(1 - d.result!.changed);
    expect((await cloneRows(clA.pack)).filter((r) => r.source_question_id === n1)).toHaveLength(0);

    const done = await syncClonesForPack(superP(), "sap-5", { commit: true });
    expect(done.bumped).toBe(true);
    expect(done.version).toBe(v + 1);
    expect((await audits(tP, "pack.updated", p.pack)).some((a) => a.after.kind === "version_bump_for_clone_sync" && a.after.version === v + 1)).toBe(true);
    const c = done.clones[0]!;
    expect(c.result).toEqual(d.result);
    expect(c.error).toBeUndefined();
    const rowsA = await cloneRows(clA.pack);
    for (const m of [n1, n2]) {
      const cr = rowsA.find((r) => r.source_question_id === m);
      expect(cr).toMatchObject({ status: "active" });
      expect(await snaps(cr!.id)).not.toEqual([]);
    }
    expect(rowsA.find((r) => r.source_question_id === base)).toMatchObject({ status: "active" });
    expect((await pool(tA, clA)).length).toBe(3);

    // the archived clone pack was not listed, not revived, not changed
    expect((await packRow(clB.pack)).status).toBe("archived");
    expect(await cloneRows(clB.pack)).toEqual(archivedBefore);

    const dry2 = await syncClonesForPack(superP(), "sap-5", { commit: false });
    expect(dry2.clones[0]).toMatchObject({ missingInClone: 0, result: { updated: false, added: 0 } });
    const again = await syncClonesForPack(superP(), "sap-5", { commit: true });
    expect(again.bumped).toBe(false);
    expect(again.clones[0]!.result).toMatchObject({ added: 0 });
  });

  it("5b: unknown slug and organisation actors are refused", async () => {
    await expect(syncClonesForPack(superP(), "no-such-pack", { commit: false })).rejects.toMatchObject({ name: "ValidationError", details: { code: "PACK_NOT_FOUND" } });
    await expect(syncClonesForPack(adminA(), "sap-5", { commit: false })).rejects.toMatchObject({ name: "AuthzError" });
    await expect(syncClonesForPack({ tenantId: tA, userId: uA, role: "super_admin" }, "sap-5", { commit: false })).rejects.toMatchObject({ name: "AuthzError" });
  });

  it("5c: a row verified then activated by ids is delivered without any CLI call (verify -> activate chain)", async () => {
    const { p } = await mkMaster("sap-5c");
    await materializeSetForTenant(p.pack, tA, uA);
    const cl = await cloneOf(tA, p.pack);
    const n = await importRow(tP, uP, p, "in_review");
    await verifyQuestionsByIds(superP(), [n]);
    await activateQuestionsByIds(superP(), [n]);
    expect((await cloneRows(cl.pack)).some((r) => r.source_question_id === n && r.status === "active")).toBe(true);
  });
});

const cloneNeg = (id: string) => sup(async (c) => (await c.query(`SELECT negative_marks FROM questions WHERE id=$1`, [id])).rows[0].negative_marks);
const unpushed = async (p: { pack: string; level: string }, n: number) => {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(await importRow(tP, uP, p));
  await sup((c) => c.query(`UPDATE questions SET status='active' WHERE id = ANY($1::uuid[])`, [ids]));
  const slug = await sup(async (c) => (await c.query(`SELECT slug FROM question_packs WHERE id=$1`, [p.pack])).rows[0].slug as string);
  await backfillMissingSnapshots(superP(), { commit: true, packSlugs: [slug] });
  return ids;
};

describe("amendment 2", () => {
  it("6: negative_marks is carried by clone-on-grant and by resync", async () => {
    const p = await mkPack(tP, uP, "sap-6");
    const base = await importRow(tP, uP, p, "verified", 0.5);
    await activateQuestionsByIds(superP(), [base]);
    await materializeSetForTenant(p.pack, tA, uA);
    const cl = await cloneOf(tA, p.pack);
    const cb = (await cloneRows(cl.pack)).find((r) => r.source_question_id === base)!;
    expect(Number(await cloneNeg(cb.id))).toBe(0.5);
    const n = await importRow(tP, uP, p, "verified", 0.25);
    await activateQuestionsByIds(superP(), [n]); // bump + push = resync
    const cn = (await cloneRows(cl.pack)).find((r) => r.source_question_id === n)!;
    expect(Number(await cloneNeg(cn.id))).toBe(0.25);
  });

  it("7: wouldRevive counts archived clone rows whose master is active; dry run writes nothing; commit revives", async () => {
    const { p, base } = await mkMaster("sap-7");
    await materializeSetForTenant(p.pack, tA, uA);
    const cl = await cloneOf(tA, p.pack);
    const cb = (await cloneRows(cl.pack)).find((r) => r.source_question_id === base)!;
    await sup((c) => c.query(`UPDATE questions SET status='archived' WHERE id=$1`, [cb.id]));
    await unpushed(p, 1);
    const fp = await fingerprint();
    const dry = await syncClonesForPack(superP(), "sap-7", { commit: false });
    expect(await fingerprint()).toEqual(fp);
    expect(dry.clones[0]).toMatchObject({ wouldRevive: 1, missingInClone: 1 });
    expect(dry.clones[0]!.result!.changed).toBeGreaterThanOrEqual(1);
    const done = await syncClonesForPack(superP(), "sap-7", { commit: true });
    expect(done.clones[0]).toMatchObject({ wouldRevive: 1, result: dry.clones[0]!.result });
    expect((await cloneRows(cl.pack)).find((r) => r.id === cb.id)!.status).toBe("active");
  });

  it("8: cloneSync in the by-ids result, with a forced failing clone tenant", async () => {
    const { p } = await mkMaster("sap-8");
    await materializeSetForTenant(p.pack, tA, uA);
    await materializeSetForTenant(p.pack, tB, uB);
    const clB = await cloneOf(tB, p.pack);
    const n1 = await importRow(tP, uP, p);
    const ok = await activateQuestionsByIds(superP(), [n1]);
    expect(ok.cloneSync).toEqual([{ packId: p.pack, tenants: 2, updated: 2, failed: 0, skipped: 0 }]);
    expect((await activateQuestionsByIds(superP(), [n1])).cloneSync).toEqual([]); // nothing activated

    // force tenant B's resync to throw: a trigger that rejects inserts into B's clone pack
    await sup(async (c) => {
      await c.query(`CREATE OR REPLACE FUNCTION t62_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.pack_id = '${clB.pack}'::uuid THEN RAISE EXCEPTION 't62 forced'; END IF; RETURN NEW; END $$`);
      await c.query(`CREATE TRIGGER t62_fail BEFORE INSERT ON questions FOR EACH ROW EXECUTE FUNCTION t62_fail()`);
    });
    try {
      const n2 = await importRow(tP, uP, p);
      const bad = await activateQuestionsByIds(superP(), [n2]);
      expect(bad.activated).toBe(1);
      expect(bad.cloneSync).toEqual([{ packId: p.pack, tenants: 2, updated: 1, failed: 1, skipped: 0 }]);
      expect((await cloneRows(clB.pack)).some((r) => r.source_question_id === n2)).toBe(false);
    } finally {
      await sup(async (c) => { await c.query(`DROP TRIGGER t62_fail ON questions`); await c.query(`DROP FUNCTION t62_fail()`); });
    }
  });

  it("9: expectAdded match and mismatch (mismatch writes nothing, no bump)", async () => {
    const { p } = await mkMaster("sap-9");
    await materializeSetForTenant(p.pack, tA, uA);
    await unpushed(p, 2);
    const v = (await packRow(p.pack)).version;
    const fp = await fingerprint();
    await expect(syncClonesForPack(superP(), "sap-9", { commit: true, expectAdded: 1 })).rejects.toMatchObject({ details: { code: "REVIEW_COUNT_CHANGED", expected: 1, actual: 2 } });
    expect(await fingerprint()).toEqual(fp);
    expect((await packRow(p.pack)).version).toBe(v);
    const ok = await syncClonesForPack(superP(), "sap-9", { commit: true, expectAdded: 2 });
    expect(ok.bumped).toBe(true);
    expect(ok.clones[0]!.result).toMatchObject({ added: 2 });
  });

  it("10: a preview with skipped rows refuses the commit and writes nothing", async () => {
    const { p } = await mkMaster("sap-10");
    await materializeSetForTenant(p.pack, tA, uA);
    const n = await unpushed(p, 1);
    // a platform domain + category the clone tenant cannot get: tenant A already owns a local domain with the same slug
    await sup(async (c) => {
      const dom = (await c.query(`INSERT INTO domains (tenant_id, slug, name) VALUES ($1,'skipdom','Skip') RETURNING id`, [tP])).rows[0].id;
      const cat = (await c.query(`INSERT INTO categories (tenant_id, domain_id, slug, name) VALUES ($1,$2,'skipcat','Skip') RETURNING id`, [tP, dom])).rows[0].id;
      await c.query(`INSERT INTO domains (tenant_id, slug, name, source) VALUES ($1,'skipdom','Skip','tenant')`, [tA]);
      await c.query(`UPDATE questions SET domain_id=$2, category_id=$3 WHERE id=$1`, [n[0], dom, cat]);
    });
    const dry = await syncClonesForPack(superP(), "sap-10", { commit: false });
    expect(dry.clones[0]!.result).toMatchObject({ skipped: 1, added: 0 });
    const fp = await fingerprint();
    await expect(syncClonesForPack(superP(), "sap-10", { commit: true })).rejects.toMatchObject({ details: { code: "REVIEW_COUNT_CHANGED" } });
    expect(await fingerprint()).toEqual(fp);
  });
});

const contentOf = (id: string, version: number) => sup(async (c) => (await c.query(`SELECT content FROM question_versions WHERE question_id=$1 AND version=$2`, [id, version])).rows[0].content as { question: string });
const NEW = { ...MCQ, question: "Fresh text?" };
/** A draft row (no snapshot) edited while still a draft: old content snapshotted at v0, version v0+1, row has NEW content. */
async function editedDraft(p: { pack: string; level: string }): Promise<{ id: string; v0: number }> {
  const id = await importRow(tP, uP, p);
  const v0 = (await row(id)).version;
  await updateQuestion(tP, id, { content: NEW } as never, uP);
  await verifyQuestionsByIds(superP(), [id]);
  expect(await snaps(id)).toEqual([v0]);
  expect((await row(id)).version).toBe(v0 + 1);
  return { id, v0 };
}
async function expectFresh(p: { pack: string; level: string }, id: string, v0: number) {
  expect(await snaps(id)).toEqual([v0, v0 + 1]);
  expect((await row(id)).version).toBe(v0 + 2);
  expect((await contentOf(id, v0 + 1)).question).toBe("Fresh text?");
  expect((await pool(tP, p)).find((r) => r.id === id)).toEqual({ id, version: v0 + 1 }); // pool serves the NEW content
  await updateQuestion(tP, id, { content: { ...MCQ, question: "Later?" } } as never, uP); // a later edit does not collide
  expect(await snaps(id)).toEqual([v0, v0 + 1, v0 + 2]);
}

describe("fix round", () => {
  it("11: a draft edited before activation serves the NEW content after each of the four activation paths", async () => {
    const p1 = await mkPack(tP, uP, "sap-11a");
    const a = await editedDraft(p1);
    await activateQuestionsByIds(superP(), [a.id]);
    await expectFresh(p1, a.id, a.v0);

    const p2 = await mkPack(tP, uP, "sap-11b");
    const b = await editedDraft(p2);
    await activateAllQuestionsForPack(tP, p2.pack, uP);
    await expectFresh(p2, b.id, b.v0);

    const p3 = await mkPack(tP, uP, "sap-11c");
    const c = await editedDraft(p3);
    const upd = await updateQuestion(tP, c.id, { status: "active" } as never, uP);
    expect(upd.version).toBe(c.v0 + 2); // point 3: the returned row carries the real version
    await expectFresh(p3, c.id, c.v0);

    const p4 = await mkPack(tP, uP, "sap-11d");
    const d = await editedDraft(p4);
    await sup((cl) => cl.query(`UPDATE questions SET status='ai_draft' WHERE id=$1`, [d.id]));
    await bulkUpdateQuestionStatus(tP, [d.id], "active", uP);
    await expectFresh(p4, d.id, d.v0);
  });

  it("11b: a row with a snapshot that is activated and edited in one PATCH: old at v, new at v+1, version v+2, pool serves new", async () => {
    const p = await mkPack(tP, uP, "sap-11e");
    const id = await importRow(tP, uP, p);
    const v0 = (await row(id)).version;
    await updateQuestion(tP, id, { status: "active" } as never, uP); // snapshot v0, version v0+1
    await sup((c) => c.query(`UPDATE questions SET status='draft' WHERE id=$1`, [id]));
    const v1 = (await row(id)).version;
    const upd = await updateQuestion(tP, id, { status: "active", content: NEW } as never, uP);
    expect(upd.version).toBe(v1 + 2);
    expect(await snaps(id)).toEqual([v0, v1, v1 + 1]);
    expect((await contentOf(id, v1)).question).toBe(`Q ${id}?`);
    expect((await contentOf(id, v1 + 1)).question).toBe("Fresh text?");
    expect((await pool(tP, p)).find((r) => r.id === id)).toEqual({ id, version: v1 + 1 });
  });

  it("12: an ACTIVE row edited after activation is untouched by every repair path (old rule kept)", async () => {
    const p = await mkPack(tP, uP, "sap-12");
    const a = await importRow(tP, uP, p);
    await activateQuestionsByIds(superP(), [a]);
    await updateQuestion(tP, a, { content: NEW } as never, uP); // old content snapshotted, row has new content (re-publish rule)
    const before = { s: await snaps(a), v: (await row(a)).version };
    const other = await importRow(tP, uP, p);
    await activateAllQuestionsForPack(tP, p.pack, uP);
    expect((await row(other)).status).toBe("active");
    await activateQuestionsByIds(superP(), [a]);
    await backfillMissingSnapshots(superP(), { commit: true, packSlugs: ["sap-12"] });
    await updateQuestion(tP, a, { status: "active" } as never, uP); // active -> active: not an activation
    expect({ s: await snaps(a), v: (await row(a)).version }).toEqual(before);
  });

  it("13: activating an unchanged draft that already has a snapshot writes nothing (NULL rubric and JSON null rubric count as equal)", async () => {
    const p = await mkPack(tP, uP, "sap-13");
    const x = await importRow(tP, uP, p); // rubric SQL NULL
    const y = await importRow(tP, uP, p);
    await activateQuestionsByIds(superP(), [x]);
    // y: a snapshot with a stored JSON null rubric (what publishPack's insertQuestionVersion writes for a null rubric)
    const yRow = await sup(async (c) => (await c.query(`SELECT content, version FROM questions WHERE id=$1`, [y])).rows[0]);
    await withTenant(tP, (client) => repo.insertQuestionVersion(client, { id: randomUUID(), questionId: y, version: yRow.version, content: yRow.content, rubric: null, savedBy: uP }));
    await sup((c) => c.query(`UPDATE questions SET version = version + 1 WHERE id=$1`, [y]));
    expect(await sup(async (c) => (await c.query(`SELECT rubric IS NOT NULL AS j FROM question_versions WHERE question_id=$1`, [y])).rows[0].j)).toBe(true);
    await sup((c) => c.query(`UPDATE questions SET status='draft' WHERE id=$1`, [x]));
    const before = [await snaps(x), (await row(x)).version, await snaps(y), (await row(y)).version];
    const r = await activateQuestionsByIds(superP(), [x, y]);
    expect(r).toMatchObject({ activated: 2, snapshotsWritten: 0 });
    expect([await snaps(x), (await row(x)).version, await snaps(y), (await row(y)).version]).toEqual(before);
  });

  it("14: awaitCloneSync false returns at once with 'background'; the clone gets the row; default says 'done'", async () => {
    const { p } = await mkMaster("sap-14");
    await materializeSetForTenant(p.pack, tA, uA);
    const cl = await cloneOf(tA, p.pack);
    const n = await importRow(tP, uP, p, "in_review");
    const r = await activateAllQuestionsForPack(tP, p.pack, uP, { awaitCloneSync: false });
    expect(r).toMatchObject({ activated: 1, cloneSync: "background" });
    const deadline = Date.now() + 5000;
    let got = false;
    while (Date.now() < deadline && !got) {
      got = (await cloneRows(cl.pack)).some((x) => x.source_question_id === n && x.status === "active");
      if (!got) await new Promise((res) => setTimeout(res, 100));
    }
    expect(got).toBe(true);
    const n2 = await importRow(tP, uP, p, "in_review");
    expect((await activateAllQuestionsForPack(tP, p.pack, uP)).cloneSync).toBe("done");
    expect((await cloneRows(cl.pack)).some((x) => x.source_question_id === n2)).toBe(true);
  });

  it("15: updateQuestion archived -> active on a row with a snapshot writes nothing new; edit audit carries the real version", async () => {
    const p = await mkPack(tP, uP, "sap-15");
    const a = await importRow(tP, uP, p);
    await activateQuestionsByIds(superP(), [a]);
    await sup((c) => c.query(`UPDATE questions SET status='archived' WHERE id=$1`, [a]));
    const before = { s: await snaps(a), v: (await row(a)).version };
    await updateQuestion(tP, a, { status: "active" } as never, uP);
    expect((await row(a)).status).toBe("active");
    expect({ s: await snaps(a), v: (await row(a)).version }).toEqual(before);

    const q = await importRow(tP, uP, p);
    const upd = await updateQuestion(tP, q, { status: "active", content: NEW } as never, uP);
    const au = (await audits(tP, "question.updated", q)).pop()!;
    expect(upd.version).toBe((await row(q)).version);
    expect(au.after.version).toBe(upd.version);
  });

  it("16: commit with one failing tenant writes the other, marks the failed one; a second run finishes it with no second bump", async () => {
    const { p } = await mkMaster("sap-16");
    await materializeSetForTenant(p.pack, tA, uA);
    await materializeSetForTenant(p.pack, tB, uB);
    const clA = await cloneOf(tA, p.pack); const clB = await cloneOf(tB, p.pack);
    await unpushed(p, 2);
    const v = (await packRow(p.pack)).version;
    // fails only at commit: the audit row of the real resync for tenant B (the rolled-back preview writes no audit row)
    await sup(async (c) => {
      await c.query(`CREATE OR REPLACE FUNCTION t62_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id = '${tB}'::uuid AND NEW.action = 'tenant.pack_resynced' THEN RAISE EXCEPTION 't62 audit forced'; END IF; RETURN NEW; END $$`);
      await c.query(`CREATE TRIGGER t62_fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION t62_fail_audit()`);
    });
    let first;
    try {
      first = await syncClonesForPack(superP(), "sap-16", { commit: true });
    } finally {
      await sup(async (c) => { await c.query(`DROP TRIGGER t62_fail_audit ON audit_log`); await c.query(`DROP FUNCTION t62_fail_audit()`); });
    }
    expect(first.bumped).toBe(true);
    const ea = first.clones.find((c) => c.tenantId === tA)!; const eb = first.clones.find((c) => c.tenantId === tB)!;
    expect(ea.error).toBeUndefined();
    expect(ea.result).toMatchObject({ added: 2 });
    expect(eb.error).toMatch(/t62 audit forced/);
    expect((await cloneRows(clA.pack)).filter((r) => r.source_question_id !== null)).toHaveLength(3);
    expect((await cloneRows(clB.pack)).filter((r) => r.source_question_id !== null)).toHaveLength(1); // rolled back

    const second = await syncClonesForPack(superP(), "sap-16", { commit: true });
    expect(second.bumped).toBe(false);
    expect(second.version).toBe(v + 1);
    expect(second.clones.find((c) => c.tenantId === tA)!.result).toMatchObject({ added: 0 });
    expect(second.clones.find((c) => c.tenantId === tB)!.result).toMatchObject({ added: 2 });
    expect((await cloneRows(clB.pack)).filter((r) => r.source_question_id !== null)).toHaveLength(3);
  });

  it("17: a failed preview refuses the commit: no bump, nothing written", async () => {
    const { p } = await mkMaster("sap-17");
    await materializeSetForTenant(p.pack, tA, uA);
    await materializeSetForTenant(p.pack, tB, uB);
    const clB = await cloneOf(tB, p.pack);
    await unpushed(p, 1);
    const v = (await packRow(p.pack)).version;
    await sup(async (c) => {
      await c.query(`CREATE OR REPLACE FUNCTION t62_fail17() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.pack_id = '${clB.pack}'::uuid THEN RAISE EXCEPTION 't62 preview forced'; END IF; RETURN NEW; END $$`);
      await c.query(`CREATE TRIGGER t62_fail17 BEFORE INSERT ON questions FOR EACH ROW EXECUTE FUNCTION t62_fail17()`);
    });
    try {
      const fp = await fingerprint();
      await expect(syncClonesForPack(superP(), "sap-17", { commit: true })).rejects.toMatchObject({ details: { code: "REVIEW_COUNT_CHANGED", preview_errors: [{ tenant: "tb-all" }] } });
      expect(await fingerprint()).toEqual(fp);
      expect((await packRow(p.pack)).version).toBe(v);
    } finally {
      await sup(async (c) => { await c.query(`DROP TRIGGER t62_fail17 ON questions`); await c.query(`DROP FUNCTION t62_fail17()`); });
    }
  });
});
