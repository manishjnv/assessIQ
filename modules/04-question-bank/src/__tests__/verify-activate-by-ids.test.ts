/**
 * T-62: verifyQuestionsByIds, activateQuestionsByIds, snapshot repair in activateAllQuestionsForPack and
 * backfillMissingSnapshots. Real Postgres (postgres:16 testcontainer). The bug: rows imported into an already
 * published pack have no question_versions snapshot, so the draw pool (module 06, INNER JOIN question_versions)
 * never returns them even when active.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID, createHash } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool, withTenant } from "@assessiq/tenancy";
import { listActiveQuestionPoolForPick } from "../../../06-attempt-engine/src/repository.js";
import * as repo from "../repository.js";
import { activateAllQuestionsForPack, activateQuestionsByIds, backfillMissingSnapshots } from "../service/packs.js";
import { verifyQuestionsByIds } from "../service/review.js";
import { updateQuestion } from "../service/questions.js";

let container: StartedTestContainer;
let url = "";
let tP = "";
let uP = "";
const [tA, uA] = [randomUUID(), randomUUID()];
const superP = () => ({ tenantId: tP, userId: uP, role: "super_admin" });
const adminA = () => ({ tenantId: tA, userId: uA, role: "admin" });

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

/** A published pack with one level in a tenant. */
async function mkPack(tenant: string, user: string, slug: string, packStatus = "published"): Promise<{ pack: string; level: string }> {
  return sup(async (c) => {
    const pack = randomUUID(); const level = randomUUID();
    await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, version, created_by, source) VALUES ($1,$2,$3,'P','aptitude',$5,1,$4,'import')`, [pack, tenant, slug, user, packStatus]);
    await c.query(`INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count) VALUES ($1,$2,1,'L1',30,10)`, [level, pack]);
    return { pack, level };
  });
}

/** Insert a question the way the CSV import does: repo.insertQuestion (draft), no snapshot, cleared source row. */
async function importRow(tenant: string, user: string, p: { pack: string; level: string }, opts: { reviewState?: "in_review" | "verified" | "needs_fix" | null; rights?: string } = {}): Promise<string> {
  const id = randomUUID();
  await withTenant(tenant, async (client) => {
    await repo.insertQuestion(client, {
      id, packId: p.pack, levelId: p.level, type: "mcq", topic: "t", points: 1,
      content: { question: `Q ${id}?`, options: [{ id: "a", text: "x" }, { id: "b", text: "y" }], correct: "a" },
      createdBy: user,
      rightsStatus: (opts.rights ?? "original") as never,
      ...(opts.reviewState !== undefined ? { reviewState: opts.reviewState } : {}),
    });
  });
  return id;
}

const row = (id: string) => sup(async (c) => (await c.query(`SELECT status, review_state, version FROM questions WHERE id=$1`, [id])).rows[0] as { status: string; review_state: string | null; version: number });
const snaps = (id: string) => sup(async (c) => (await c.query(`SELECT version FROM question_versions WHERE question_id=$1 ORDER BY version`, [id])).rows.map((r) => r.version as number));
const audits = (tenant: string, action: string, entityId?: string) => sup(async (c) =>
  (await c.query(`SELECT entity_id, before, after FROM audit_log WHERE tenant_id=$1 AND action=$2 AND ($3::text IS NULL OR entity_id::text=$3) ORDER BY id`, [tenant, action, entityId ?? null])).rows);
const pool = (tenant: string, p: { pack: string; level: string }) => withTenant(tenant, (client) => listActiveQuestionPoolForPick(client, p.pack, p.level));

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
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'ta-ids','Org A')`, [tA]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [tA]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a-ids@x.io','Admin','admin','active')`, [uA, tA]);
  });
}, 180_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

describe("T-62 by-ids verify + activate", () => {
  it("a: imported row in a published pack is not in the pool; verify + activate by ids fixes it, version rule holds, later edit works", async () => {
    const p = await mkPack(tP, uP, "t62-a");
    const q = await importRow(tP, uP, p);
    const v0 = (await row(q)).version;
    expect(await verifyQuestionsByIds(superP(), [q])).toEqual({ verified: 1, alreadyVerified: 0 });
    // active without snapshot: the bug state (older path flips status only)
    await sup((c) => c.query(`UPDATE questions SET status='active' WHERE id=$1`, [q]));
    expect(await pool(tP, p)).toHaveLength(0);
    await sup((c) => c.query(`UPDATE questions SET status='draft' WHERE id=$1`, [q]));

    expect(await activateQuestionsByIds(superP(), [q])).toMatchObject({ activated: 1, alreadyActive: 0, snapshotsWritten: 1 });
    expect(await pool(tP, p)).toEqual([{ id: q, version: v0 }]);
    expect(await snaps(q)).toEqual([v0]);
    expect((await row(q)).version).toBe(v0 + 1);
    expect((await row(q)).status).toBe("active");
    const upd = await updateQuestion(tP, q, { content: { question: "Edited?", options: ["3", "4", "5", "6"], correct: 1, rationale: "r" } } as never, uP);
    expect(upd.version).toBe(v0 + 2);
    expect(await snaps(q)).toEqual([v0, v0 + 1]);
  });

  it("b: activateAllQuestionsForPack snapshots the row and it is in the pool", async () => {
    const p = await mkPack(tP, uP, "t62-b");
    const q = await importRow(tP, uP, p, { reviewState: "verified" });
    const v0 = (await row(q)).version;
    const r = await activateAllQuestionsForPack(tP, p.pack, uP);
    expect(r.activated).toBe(1);
    expect(await pool(tP, p)).toEqual([{ id: q, version: v0 }]);
    expect((await row(q)).version).toBe(v0 + 1);
    const a = await audits(tP, "question.updated", p.pack);
    expect(a[a.length - 1].after).toMatchObject({ kind: "bulk_activate", activated: 1, snapshots_written: 1 });
  });

  it("b2: hold rule: Activate all leaves a needs_fix draft as draft and counts it; in_review still activates", async () => {
    const p = await mkPack(tP, uP, "t62-b2");
    const held = await importRow(tP, uP, p, { reviewState: "needs_fix" });
    const open = await importRow(tP, uP, p, { reviewState: "in_review" });
    const r = await activateAllQuestionsForPack(tP, p.pack, uP);
    expect(r).toMatchObject({ activated: 1, heldBack: 1 });
    expect((await row(held)).status).toBe("draft");
    expect((await row(open)).status).toBe("active");
    expect((await pool(tP, p)).map((x) => x.id)).toEqual([open]);
    const a = await audits(tP, "question.updated", p.pack);
    expect(a[a.length - 1].after).toMatchObject({ kind: "bulk_activate", activated: 1, held_back: 1 });
    // Only the held row is left: the call refuses and names it.
    await expect(activateAllQuestionsForPack(tP, p.pack, uP)).rejects.toMatchObject({ details: { heldBack: 1 } });
  });

  it("c: a second draft of the pack that is not in the list stays draft", async () => {
    const p = await mkPack(tP, uP, "t62-c");
    const q1 = await importRow(tP, uP, p, { reviewState: "verified" });
    const q2 = await importRow(tP, uP, p, { reviewState: "verified" });
    await activateQuestionsByIds(superP(), [q1]);
    expect((await row(q1)).status).toBe("active");
    expect((await row(q2)).status).toBe("draft");
    expect(await snaps(q2)).toEqual([]);
    const a = await audits(tP, "question.updated", p.pack);
    expect(a).toHaveLength(1);
    expect(a[0].after).toMatchObject({ kind: "bulk_activate_by_ids", from_status: "draft", to_status: "active", activated: 1, already_active: 0, snapshots_written: 1, first_ids: [q1], ids_sha256: createHash("sha256").update(q1).digest("hex") });
  });

  it("d: refuses and writes nothing (unverified draft, other tenant, archived, role admin)", async () => {
    const p = await mkPack(tP, uP, "t62-d");
    const good = await importRow(tP, uP, p, { reviewState: "verified" });
    const unverified = await importRow(tP, uP, p); // in_review
    const archived = await importRow(tP, uP, p, { reviewState: "verified" });
    await sup((c) => c.query(`UPDATE questions SET status='archived' WHERE id=$1`, [archived]));
    const pa = await mkPack(tA, uA, "t62-d-org");
    const foreign = await importRow(tA, uA, pa, { reviewState: "verified" });
    const before = (await audits(tP, "question.updated", p.pack)).length;

    const fail = async (ids: string[], reason: string) => {
      await expect(activateQuestionsByIds(superP(), ids)).rejects.toMatchObject({ details: { code: "BY_IDS_REFUSED", bad_count: 1, bad: [{ reason }] } });
      expect((await row(good)).status).toBe("draft");
      expect(await snaps(good)).toEqual([]);
    };
    await fail([good, unverified], "not_verified");
    await fail([good, foreign], "not_found");
    await fail([good, archived], "archived");
    await expect(activateQuestionsByIds(adminA(), [foreign])).rejects.toThrow(/super_admin/);
    await expect(activateQuestionsByIds(superP(), [])).rejects.toMatchObject({ details: { code: "INVALID_BULK_SIZE" } });
    expect((await row(foreign)).status).toBe("draft");
    expect((await audits(tP, "question.updated", p.pack)).length).toBe(before);
  });

  it("e: verify by ids: exact audit shape, alreadyVerified, needs_fix throws, tenant admin cannot verify platform", async () => {
    const p = await mkPack(tP, uP, "t62-e");
    const inRev = await importRow(tP, uP, p);
    const nul = await importRow(tP, uP, p, { reviewState: null });
    const ver = await importRow(tP, uP, p, { reviewState: "verified" });
    const nf = await importRow(tP, uP, p, { reviewState: "needs_fix" });

    await expect(verifyQuestionsByIds(superP(), [inRev, nf])).rejects.toMatchObject({ details: { code: "BY_IDS_REFUSED", bad: [{ id: nf, reason: "needs_fix" }] } });
    expect((await row(inRev)).review_state).toBe("in_review");
    expect(await audits(tP, "question.review_changed", inRev)).toHaveLength(0);

    expect(await verifyQuestionsByIds(superP(), [inRev, nul, ver])).toEqual({ verified: 2, alreadyVerified: 1 });
    expect((await audits(tP, "question.review_changed", inRev))[0]).toMatchObject({
      before: { review_state: "in_review" },
      after: { review_state: "verified", action: "verify", bulk: true, by_ids: true, pack_id: p.pack },
    });
    expect((await audits(tP, "question.review_changed", nul))[0].before).toEqual({ review_state: null });
    expect(await audits(tP, "question.review_changed", ver)).toHaveLength(0);

    await expect(verifyQuestionsByIds(adminA(), [inRev])).rejects.toThrow();
  });

  it("f: second activate and second verify change 0 and write no audit rows", async () => {
    const p = await mkPack(tP, uP, "t62-f");
    const q = await importRow(tP, uP, p);
    await verifyQuestionsByIds(superP(), [q]);
    await activateQuestionsByIds(superP(), [q]);
    const aAct = (await audits(tP, "question.updated", p.pack)).length;
    const aRev = (await audits(tP, "question.review_changed", q)).length;
    expect(await verifyQuestionsByIds(superP(), [q, q])).toEqual({ verified: 0, alreadyVerified: 1 });
    expect(await activateQuestionsByIds(superP(), [q])).toMatchObject({ activated: 0, alreadyActive: 1, snapshotsWritten: 0 });
    expect((await audits(tP, "question.updated", p.pack)).length).toBe(aAct);
    expect((await audits(tP, "question.review_changed", q)).length).toBe(aRev);
  });

  it("g: backfillMissingSnapshots counts, commits once, second run is empty", async () => {
    const p = await mkPack(tP, uP, "t62-g");
    const q = await importRow(tP, uP, p, { reviewState: "verified" });
    await sup((c) => c.query(`UPDATE questions SET status='active' WHERE id=$1`, [q]));
    const v0 = (await row(q)).version;

    const dry = await backfillMissingSnapshots(superP(), { commit: false, packSlugs: ["t62-g"] });
    expect(dry).toEqual({ packs: [{ packId: p.pack, slug: "t62-g", missing: 1 }], total: 1, written: 0 });
    expect(await snaps(q)).toEqual([]);
    expect(await audits(tP, "question.updated", p.pack)).toHaveLength(0);

    const done = await backfillMissingSnapshots(superP(), { commit: true, packSlugs: ["t62-g"] });
    expect(done).toMatchObject({ total: 1, written: 1 });
    expect(await snaps(q)).toEqual([v0]);
    expect((await row(q)).version).toBe(v0 + 1);
    const a = await audits(tP, "question.updated", p.pack);
    expect(a).toHaveLength(1);
    expect(a[0].after).toMatchObject({ kind: "snapshot_backfill", written: 1, first_ids: [q] });

    const again = await backfillMissingSnapshots(superP(), { commit: true, packSlugs: ["t62-g"] });
    expect(again).toEqual({ packs: [], total: 0, written: 0 });
    expect(await audits(tP, "question.updated", p.pack)).toHaveLength(1);
    await expect(backfillMissingSnapshots(adminA(), { commit: false })).rejects.toThrow(/super_admin/);
  });
});

const sha = (ids: string[]) => createHash("sha256").update([...ids].sort().join("\n")).digest("hex");
const nAudit = (tenant: string) => sup(async (c) => Number((await c.query(`SELECT count(*) FROM audit_log WHERE tenant_id=$1 AND action IN ('question.updated','question.review_changed')`, [tenant])).rows[0].count));
const snapCount = (ids: string[]) => sup(async (c) => Number((await c.query(`SELECT count(*) FROM question_versions WHERE question_id = ANY($1::uuid[])`, [ids])).rows[0].count));

describe("T-62 follow-up cases", () => {
  it("1: activate refusals (withdrawn, rights not cleared, no source row, pack not published, ai_draft) write nothing", async () => {
    const p = await mkPack(tP, uP, "t62-1");
    const wd = await importRow(tP, uP, p, { reviewState: "verified", rights: "withdrawn" });
    const rc = await importRow(tP, uP, p, { reviewState: "verified", rights: "scraped_raw" });
    const ns = await importRow(tP, uP, p, { reviewState: "verified" });
    await sup((c) => c.query(`DELETE FROM question_source WHERE question_id=$1`, [ns]));
    const ai = await importRow(tP, uP, p, { reviewState: "verified" });
    await sup((c) => c.query(`UPDATE questions SET status='ai_draft' WHERE id=$1`, [ai]));
    const dp = await mkPack(tP, uP, "t62-1-draftpack", "draft");
    const np = await importRow(tP, uP, dp, { reviewState: "verified" });
    const all = [wd, rc, ns, ai, np];
    const before = await nAudit(tP);
    const cases: Array<[string, string]> = [[wd, "withdrawn"], [rc, "rights_not_cleared"], [ns, "rights_not_cleared"], [ai, "ai_draft"], [np, "pack_not_published"]];
    for (const [id, reason] of cases) {
      await expect(activateQuestionsByIds(superP(), [id])).rejects.toMatchObject({ details: { code: "BY_IDS_REFUSED", bad_count: 1, bad: [{ id, reason }] } });
    }
    const states = await sup(async (c) => (await c.query(`SELECT id, status, version FROM questions WHERE id = ANY($1::uuid[])`, [all])).rows);
    expect(states.filter((r) => r.status === "active")).toHaveLength(0);
    expect(states.find((r) => r.id === ai).status).toBe("ai_draft");
    expect(await snapCount(all)).toBe(0);
    expect(await nAudit(tP)).toBe(before);
  });

  it("2: an active row that already has a snapshot is untouched by activate and by backfill", async () => {
    const p = await mkPack(tP, uP, "t62-2");
    const q1 = await importRow(tP, uP, p, { reviewState: "verified" });
    const q2 = await importRow(tP, uP, p, { reviewState: "verified" });
    await activateQuestionsByIds(superP(), [q1]);
    const s1 = await snaps(q1); const v1 = (await row(q1)).version;
    const r = await activateQuestionsByIds(superP(), [q1, q2]);
    expect(r).toMatchObject({ activated: 1, alreadyActive: 1, snapshotsWritten: 1 });
    expect(await snaps(q1)).toEqual(s1);
    expect((await row(q1)).version).toBe(v1);
    const again = await activateQuestionsByIds(superP(), [q1]);
    expect(again).toMatchObject({ activated: 0, alreadyActive: 1, snapshotsWritten: 0, packs: [] });
    const bf = await backfillMissingSnapshots(superP(), { commit: true, packSlugs: ["t62-2"] });
    expect(bf).toEqual({ packs: [], total: 0, written: 0 });
    expect(await snaps(q1)).toEqual(s1);
    expect((await row(q1)).version).toBe(v1);
  });

  it("3: two packs in one call give one audit row each, with matching ids hashes", async () => {
    const p1 = await mkPack(tP, uP, "t62-3a");
    const p2 = await mkPack(tP, uP, "t62-3b");
    const a1 = await importRow(tP, uP, p1, { reviewState: "verified" });
    const a2 = await importRow(tP, uP, p1, { reviewState: "verified" });
    const b1 = await importRow(tP, uP, p2, { reviewState: "verified" });
    const r = await activateQuestionsByIds(superP(), [b1, a2, a1]);
    expect(r.packs).toHaveLength(2);
    for (const [pk, ids] of [[p1.pack, [a1, a2]], [p2.pack, [b1]]] as const) {
      const entry = r.packs.find((x) => x.packId === pk)!;
      const au = await audits(tP, "question.updated", pk);
      expect(au).toHaveLength(1);
      expect(entry.idsSha256).toBe(au[0].after.ids_sha256);
      expect(entry.idsSha256).toBe(sha([...ids]));
      expect(entry.count).toBe(ids.length);
    }
  });

  it("4: verify as platform super_admin with an id of another tenant: not_found, nothing written", async () => {
    const p = await mkPack(tP, uP, "t62-4");
    const good = await importRow(tP, uP, p);
    const pa = await mkPack(tA, uA, "t62-4-org");
    const foreign = await importRow(tA, uA, pa);
    const before = await nAudit(tP);
    await expect(verifyQuestionsByIds(superP(), [good, foreign])).rejects.toMatchObject({ details: { code: "BY_IDS_REFUSED", bad: [{ id: foreign, reason: "not_found" }] } });
    expect((await row(good)).review_state).toBe("in_review");
    expect((await row(foreign)).review_state).toBe("in_review");
    expect(await nAudit(tP)).toBe(before);
    expect(await nAudit(tA)).toBe(0);
  });

  it("5: org admin verifies own pack; platform id is not_found for them; admin role on the platform tenant is refused", async () => {
    const pa = await mkPack(tA, uA, "t62-5-org");
    const own = await importRow(tA, uA, pa);
    const pp = await mkPack(tP, uP, "t62-5-plat");
    const plat = await importRow(tP, uP, pp);
    await expect(verifyQuestionsByIds(adminA(), [plat])).rejects.toMatchObject({ details: { code: "BY_IDS_REFUSED", bad: [{ id: plat, reason: "not_found" }] } });
    expect((await row(plat)).review_state).toBe("in_review");
    expect(await verifyQuestionsByIds(adminA(), [own])).toEqual({ verified: 1, alreadyVerified: 0 });
    expect((await row(own)).review_state).toBe("verified");
    const au = await audits(tA, "question.review_changed", own);
    expect(au).toHaveLength(1);
    expect(au[0].after).toMatchObject({ review_state: "verified", by_ids: true, bulk: true, pack_id: pa.pack });
    await expect(verifyQuestionsByIds({ tenantId: tP, userId: uP, role: "admin" }, [plat])).rejects.toMatchObject({ name: "AuthzError" });
    expect((await row(plat)).review_state).toBe("in_review");
  });

  it("6: a super_admin whose tenant is not the platform tenant is refused by activate and backfill", async () => {
    const pa = await mkPack(tA, uA, "t62-6-org");
    const q = await importRow(tA, uA, pa, { reviewState: "verified" });
    const bad = { tenantId: tA, userId: uA, role: "super_admin" };
    await expect(activateQuestionsByIds(bad, [q])).rejects.toMatchObject({ name: "AuthzError" });
    await expect(backfillMissingSnapshots(bad, { commit: true })).rejects.toMatchObject({ name: "AuthzError" });
    expect((await row(q)).status).toBe("draft");
    expect(await snaps(q)).toEqual([]);
  });

  it("7: upper-case uuid works; a non-uuid is a ValidationError and writes nothing", async () => {
    const p = await mkPack(tP, uP, "t62-7");
    const q = await importRow(tP, uP, p);
    const q2 = await importRow(tP, uP, p);
    await expect(verifyQuestionsByIds(superP(), [q2, "not-a-uuid"])).rejects.toMatchObject({ name: "ValidationError" });
    expect((await row(q2)).review_state).toBe("in_review");
    expect(await verifyQuestionsByIds(superP(), [q.toUpperCase()])).toEqual({ verified: 1, alreadyVerified: 0 });
    expect((await row(q)).review_state).toBe("verified");
  });

  it("8: backfill expect, unknown slug, and a repaired row stays editable and drawable", async () => {
    const p = await mkPack(tP, uP, "t62-8");
    const q = await importRow(tP, uP, p, { reviewState: "verified" });
    await sup((c) => c.query(`UPDATE questions SET status='active' WHERE id=$1`, [q]));
    const v0 = (await row(q)).version;
    const before = await nAudit(tP);
    await expect(backfillMissingSnapshots(superP(), { commit: true, packSlugs: ["t62-8"], expect: 5 })).rejects.toMatchObject({ details: { code: "REVIEW_COUNT_CHANGED" } });
    expect(await snaps(q)).toEqual([]);
    expect((await row(q)).version).toBe(v0);
    expect(await nAudit(tP)).toBe(before);
    await expect(backfillMissingSnapshots(superP(), { commit: false, packSlugs: ["t62-8", "no-such-slug"] })).rejects.toMatchObject({ name: "ValidationError", details: { code: "PACK_NOT_FOUND", slugs: ["no-such-slug"] } });
    const ok = await backfillMissingSnapshots(superP(), { commit: true, packSlugs: ["t62-8"], expect: 1 });
    expect(ok).toMatchObject({ total: 1, written: 1 });
    expect(await pool(tP, p)).toEqual([{ id: q, version: v0 }]);
    const upd = await updateQuestion(tP, q, { content: { question: "Edited?", options: ["3", "4", "5", "6"], correct: 1, rationale: "r" } } as never, uP);
    expect(upd.version).toBe(v0 + 2);
    expect(await snaps(q)).toEqual([v0, v0 + 1]);
  });

  it("9: snapshotMissingVersions twice in one tx, and two concurrent txs, write one snapshot per id", async () => {
    const p = await mkPack(tP, uP, "t62-9");
    const ids = [await importRow(tP, uP, p), await importRow(tP, uP, p)];
    const [first, second] = await withTenant(tP, async (client) => [
      await repo.snapshotMissingVersions(client, ids, uP),
      await repo.snapshotMissingVersions(client, ids, uP),
    ]);
    expect(first).toEqual([...ids].sort());
    expect(second).toEqual([]);
    expect(await snapCount(ids)).toBe(2);

    // Two pool clients: two concurrent transactions on fresh rows. Exactly one writes each id.
    const ids2 = [await importRow(tP, uP, p), await importRow(tP, uP, p), await importRow(tP, uP, p)];
    const [r1, r2] = await Promise.all([
      withTenant(tP, (client) => repo.snapshotMissingVersions(client, ids2, uP)),
      withTenant(tP, (client) => repo.snapshotMissingVersions(client, ids2, uP)),
    ]);
    expect([...r1, ...r2].sort()).toEqual([...ids2].sort());
    expect(await snapCount(ids2)).toBe(3);
    const vers = await sup(async (c) => (await c.query(`SELECT version FROM questions WHERE id = ANY($1::uuid[])`, [ids2])).rows.map((r) => r.version as number));
    expect(new Set(vers).size).toBe(1);
    expect(vers[0]).toBe(2);
  });
});
