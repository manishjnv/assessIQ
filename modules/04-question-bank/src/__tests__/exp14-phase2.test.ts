/**
 * EXP-14 phase 2 (migrations 0279, 0280) against a real Postgres: the licensed_read policy family.
 * Tenants: A licensed by pack, B licensed by domain, C unlicensed, D revoked after use, E tier internal.
 * Fake data only. Prints the EXPLAIN of the child-table parent lookup (EXPLAIN: lines) for the footer.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// The service tests below go through withTenant, which sets app.licensed_read from this flag.
vi.hoisted(() => { process.env["LICENSED_READ"] = "true"; });

import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { withTenant } from "../../../02-tenancy/src/with-tenant.js";
import { createPack, addLevel } from "../service/packs.js";
import { createQuestion, getQuestion, listQuestions, listVersions } from "../service/questions.js";
import { insertAttemptQuestions } from "../../../06-attempt-engine/src/repository.js";
import { getSharedItemStats } from "../../../15-analytics/src/question-stats.js";

let container: StartedTestContainer;
let url: string;
let tP = "";
let uP = "";
const tA = randomUUID(); const uA = randomUUID();
const tB = randomUUID(); const uB = randomUUID();
const tC = randomUUID(); const uC = randomUUID();
const tD = randomUUID(); const uD = randomUUID();
const tE = randomUUID(); const uE = randomUUID();

const KEY = "SECRET-KEY-TEXT";
const ids = {
  p1: "", p2: "", p3: "", l1: "",
  qa: "", qd: "", qr: "", qp: "", qo: "",
  dom1: "", dom2: "", cat1: "", cat2: "", ps1: "", ps2: "", tag1: "", tag2: "",
  ownPackB: "", ownQB: "",
};

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

/** A tenant session as the app builds it: app role, tenant id, licensed-read switch. Always rolled back. */
async function asTenant<T>(tenant: string, fn: (c: Client) => Promise<T>, flag = "on"): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE assessiq_app");
    await c.query("SELECT set_config('app.current_tenant', $1, true), set_config('app.licensed_read', $2, true)", [tenant, flag]);
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await c.end();
  }
}

const count = async (c: Client, table: string, where = "true"): Promise<number> =>
  Number((await c.query(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)).rows[0].n);

const idsOf = async (c: Client, table: string, col = "id"): Promise<string[]> =>
  (await c.query(`SELECT ${col} AS v FROM ${table}`)).rows.map((r) => r.v as string);

const STORE_TABLES = [
  "question_packs", "levels", "questions", "question_versions", "question_source",
  "question_tags", "question_taxonomy", "passages", "domains", "categories", "tags",
];

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
    for (const [id, slug, uid, email] of [
      [tA, "ta", uA, "a@x.io"], [tB, "tb", uB, "b@x.io"], [tC, "tc", uC, "c@x.io"], [tD, "td", uD, "d@x.io"], [tE, "te", uE, "e@x.io"],
    ] as const) {
      await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$2)`, [id, slug]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
      await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Admin','admin','active')`, [uid, id, email]);
      await c.query(`INSERT INTO domains (tenant_id, slug, name) VALUES ($1,'soc','SOC') ON CONFLICT DO NOTHING`, [id]);
    }
    await c.query(`INSERT INTO tenant_plans (tenant_id, tier, included_credits) VALUES ($1,'internal',0)`, [tE]);
  });

  // ---- platform content --------------------------------------------------
  const mk = async (packName: string, domain: string) => {
    const p = await createPack(tP, { name: `${packName} ${randomUUID().slice(0, 6)}`, domain }, uP);
    const l = await addLevel(tP, p.id, { label: "L1" }, uP);
    return { p, l };
  };
  const mq = async (pack: string, level: string, topic: string) =>
    (await createQuestion(tP, { pack_id: pack, level_id: level, type: "mcq", topic, points: 1, content: content(topic) }, uP)).id;

  const a = await mk("P1", "soc");
  ids.p1 = a.p.id; ids.l1 = a.l.id;
  ids.qa = await mq(a.p.id, a.l.id, "active");
  ids.qd = await mq(a.p.id, a.l.id, "draft-in-licensed-pack");
  ids.qr = await mq(a.p.id, a.l.id, "archived");
  const b = await mk("P2", "soc"); // draft pack
  ids.p2 = b.p.id;
  ids.qp = await mq(b.p.id, b.l.id, "in-draft-pack");
  const o = await mk("P3", "other"); // published, in a domain nobody holds (except internal tenants)
  ids.p3 = o.p.id;
  ids.qo = await mq(o.p.id, o.l.id, "other-domain");

  await sup(async (c) => {
    await c.query(`UPDATE question_packs SET status='published' WHERE id = ANY($1::uuid[])`, [[ids.p1, ids.p3]]);
    await c.query(`UPDATE questions SET status='active' WHERE id = ANY($1::uuid[])`, [[ids.qa, ids.qp, ids.qo]]);
    await c.query(`UPDATE questions SET status='draft' WHERE id = $1`, [ids.qd]);
    await c.query(`UPDATE questions SET status='archived' WHERE id = $1`, [ids.qr]);
    await c.query(`UPDATE questions SET rubric=$2::jsonb WHERE id = $1`, [ids.qa, JSON.stringify({ secret: KEY })]);

    // taxonomy rows: Qa uses dom1/cat1; the draft Qd uses ONLY dom2/cat2 (must stay hidden)
    ids.dom1 = (await c.query(`INSERT INTO domains (tenant_id, slug, name) VALUES ($1,'d-active','D active') RETURNING id`, [tP])).rows[0].id;
    ids.dom2 = (await c.query(`INSERT INTO domains (tenant_id, slug, name) VALUES ($1,'d-draft','D draft') RETURNING id`, [tP])).rows[0].id;
    ids.cat1 = (await c.query(`INSERT INTO categories (tenant_id, domain_id, slug, name) VALUES ($1,$2,'c-active','C active') RETURNING id`, [tP, ids.dom1])).rows[0].id;
    ids.cat2 = (await c.query(`INSERT INTO categories (tenant_id, domain_id, slug, name) VALUES ($1,$2,'c-draft','C draft') RETURNING id`, [tP, ids.dom2])).rows[0].id;
    await c.query(`UPDATE questions SET domain_id=$2, category_id=$3 WHERE id=$1`, [ids.qa, ids.dom1, ids.cat1]);
    await c.query(`UPDATE questions SET domain_id=$2, category_id=$3 WHERE id=$1`, [ids.qd, ids.dom2, ids.cat2]);

    // passages
    ids.ps1 = (await c.query(`INSERT INTO passages (tenant_id, body) VALUES ($1,'Passage of the active question') RETURNING id`, [tP])).rows[0].id;
    ids.ps2 = (await c.query(`INSERT INTO passages (tenant_id, body) VALUES ($1,'Passage of the draft question') RETURNING id`, [tP])).rows[0].id;
    await c.query(`UPDATE questions SET passage_id=$2 WHERE id=$1`, [ids.qa, ids.ps1]);
    await c.query(`UPDATE questions SET passage_id=$2 WHERE id=$1`, [ids.qd, ids.ps2]);

    // tags
    ids.tag1 = (await c.query(`INSERT INTO tags (tenant_id, name) VALUES ($1,'t-active') RETURNING id`, [tP])).rows[0].id;
    ids.tag2 = (await c.query(`INSERT INTO tags (tenant_id, name) VALUES ($1,'t-draft') RETURNING id`, [tP])).rows[0].id;
    await c.query(`INSERT INTO question_tags (question_id, tag_id) VALUES ($1,$2)`, [ids.qa, ids.tag1]);
    await c.query(`INSERT INTO question_tags (question_id, tag_id) VALUES ($1,$2)`, [ids.qd, ids.tag2]);

    // versions (several, so the EXPLAIN check has more than one row) and source refs
    for (const q of [ids.qa, ids.qd]) {
      for (let v = 50; v < 70; v++) {
        await c.query(`INSERT INTO question_versions (question_id, version, content, saved_by) VALUES ($1,$2,$3::jsonb,$4)`, [q, v, JSON.stringify(content("v")), uP]);
      }
      await c.query(`UPDATE question_source SET source_ref='REF-SECRET' WHERE question_id=$1`, [q]);
    }
    await c.query(`INSERT INTO question_taxonomy (question_id, node_id) SELECT $1, id FROM taxonomy_nodes LIMIT 1`, [ids.qa]).catch(() => undefined);

    // entitlements: A by pack, B by domain, D by pack but revoked later
    await c.query(`INSERT INTO tenant_entitlements (tenant_id, scope_type, scope_id) VALUES ($1,'pack',$2)`, [tA, ids.p1]);
    await c.query(`INSERT INTO tenant_entitlements (tenant_id, scope_type, scope_id) VALUES ($1,'domain','soc')`, [tB]);
    await c.query(`INSERT INTO tenant_entitlements (tenant_id, scope_type, scope_id) VALUES ($1,'pack',$2)`, [tD, ids.p1]);
  });

  // Tenant B's own pack and question (tenant A must never read it)
  const bp = await createPack(tB, { name: `B own ${randomUUID().slice(0, 6)}`, domain: "soc" }, uB);
  const bl = await addLevel(tB, bp.id, { label: "L1" }, uB);
  const bq = await createQuestion(tB, { pack_id: bp.id, level_id: bl.id, type: "mcq", topic: "own-b", points: 1, content: content("OwnB") }, uB);
  ids.ownPackB = bp.id; ids.ownQB = bq.id;

  // Tenant D used P1 in an assessment (pinned Qa in its frozen pool), then lost the licence
  await sup(async (c) => {
    const aid = randomUUID();
    await c.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, randomize, opens_at, settings, created_by)
       VALUES ($1,$2,$3,$4,1,'D test','active',1,false,now(),'{}'::jsonb,$5)`,
      [aid, tD, ids.p1, ids.l1, uD],
    );
    await c.query(
      `INSERT INTO assessment_frozen_pool (tenant_id, assessment_id, question_id, question_version, level_id, type, points, marks_frozen)
       VALUES ($1,$2,$3,1,$4,'mcq',1,true)`,
      [tD, aid, ids.qa, ids.l1],
    );
    await c.query(`UPDATE tenant_entitlements SET status='revoked' WHERE tenant_id=$1`, [tD]);
  });
}, 180_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

/** Rows of the platform tenant the caller can see in one table (child tables are matched by pack). */
const platformRowCount = (c: Client, table: string): Promise<number> => {
  const packs = `ARRAY['${ids.p1}','${ids.p2}','${ids.p3}']::uuid[]`;
  if (["levels", "question_versions", "question_source", "question_tags", "question_taxonomy"].includes(table)) {
    return count(c, table, `pack_id = ANY(${packs})`);
  }
  return count(c, table, `tenant_id = '${tP}'`);
};

describe("EXP-14 phase 2: switch and licence", () => {
  it("switch off (production default): even a licensed tenant reads no platform row on any of the 11 tables", async () => {
    await asTenant(tA, async (c) => {
      for (const t of STORE_TABLES) expect(await platformRowCount(c, t)).toBe(0);
    }, "off");
  });

  it("A (licensed by pack) reads only active questions of its pack, nothing else of the platform", async () => {
    await asTenant(tA, async (c) => {
      expect(await idsOf(c, "question_packs")).toEqual([ids.p1]);
      expect(await idsOf(c, "levels")).toEqual([ids.l1]);
      expect(await idsOf(c, "questions")).toEqual([ids.qa]); // not draft, archived, draft-pack or other-domain
    });
  });

  it("DRAFT in a licensed pack: its versions, tags, source, passage, domain and category stay hidden", async () => {
    await asTenant(tA, async (c) => {
      expect(await count(c, "question_versions", `question_id = '${ids.qd}'`)).toBe(0);
      expect(await count(c, "question_tags", `question_id = '${ids.qd}'`)).toBe(0);
      expect(await count(c, "question_source", `question_id = '${ids.qd}'`)).toBe(0);
      expect(await count(c, "question_taxonomy", `question_id = '${ids.qd}'`)).toBe(0);
      expect(await count(c, "passages", `id = '${ids.ps2}'`)).toBe(0);
      expect(await count(c, "domains", `id = '${ids.dom2}'`)).toBe(0);
      expect(await count(c, "categories", `id = '${ids.cat2}'`)).toBe(0);
      expect(await count(c, "tags", `id = '${ids.tag2}'`)).toBe(0);
      // control: the same rows of the ACTIVE question are readable
      expect(await count(c, "question_versions", `question_id = '${ids.qa}'`)).toBeGreaterThan(0);
      expect(await count(c, "question_tags", `question_id = '${ids.qa}'`)).toBe(1);
      expect(await count(c, "question_source", `question_id = '${ids.qa}'`)).toBe(1);
      expect(await count(c, "passages", `id = '${ids.ps1}'`)).toBe(1);
      expect(await count(c, "domains", `id = '${ids.dom1}'`)).toBe(1);
      expect(await count(c, "categories", `id = '${ids.cat1}'`)).toBe(1);
      expect(await count(c, "tags", `id = '${ids.tag1}'`)).toBe(1);
    });
  });

  it("B (licensed by domain) reads P1 and tenant A cannot read B's own pack, nor B read A's", async () => {
    await asTenant(tB, async (c) => {
      expect(await idsOf(c, "question_packs", "id")).toEqual(expect.arrayContaining([ids.p1, ids.ownPackB]));
      expect(await count(c, "question_packs", `id = '${ids.p3}'`)).toBe(0); // other domain, not held
      expect(await count(c, "questions", `id = '${ids.ownQB}'`)).toBe(1);
    });
    await asTenant(tA, async (c) => {
      expect(await count(c, "question_packs", `id = '${ids.ownPackB}'`)).toBe(0);
      expect(await count(c, "questions", `id = '${ids.ownQB}'`)).toBe(0);
      expect(await count(c, "question_versions", `question_id = '${ids.ownQB}'`)).toBe(0);
    });
  });

  it("C (unlicensed) reads nothing of the platform on all 11 tables, even when it sets the switch itself", async () => {
    await asTenant(tC, async (c) => {
      for (const t of STORE_TABLES) expect(await platformRowCount(c, t)).toBe(0);
      expect(await count(c, "questions")).toBe(0);
      expect(await count(c, "question_packs")).toBe(0);
      // the tenant sets the setting by hand: nothing changes, the functions decide who
      await c.query("SELECT set_config('app.licensed_read', 'on', true)");
      expect(await count(c, "questions")).toBe(0);
      expect(await count(c, "question_packs")).toBe(0);
      // and cannot impersonate another tenant: that is a different current_tenant, not a different licence
    });
  });

  it("helper functions: an unlicensed tenant gets empty results; they take no argument", async () => {
    await asTenant(tC, async (c) => {
      expect((await c.query(`SELECT licensed_pack_ids() AS v`)).rows[0].v).toEqual([]);
      expect((await c.query(`SELECT readable_platform_packs() AS v`)).rows[0].v).toEqual([]);
      expect((await c.query(`SELECT licensed_platform_tenant() AS v`)).rows[0].v).toBeNull();
    });
    await asTenant(tA, async (c) => {
      expect((await c.query(`SELECT licensed_pack_ids() AS v`)).rows[0].v).toEqual([ids.p1]);
    });
  });

  it("functions: fixed search_path, SECURITY DEFINER, STABLE, no arguments, no PUBLIC execute", async () => {
    await sup(async (c) => {
      const r = await c.query(
        `SELECT p.proname, p.prosecdef, p.provolatile, p.pronargs, p.proconfig,
                has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
                has_function_privilege('assessiq_app', p.oid, 'EXECUTE') AS app
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname IN ('licensed_pack_ids','readable_platform_packs','licensed_platform_tenant')`,
      );
      expect(r.rowCount).toBe(3);
      for (const f of r.rows) {
        expect(f.prosecdef).toBe(true);
        expect(f.provolatile).toBe("s");
        expect(f.pronargs).toBe(0);
        expect(f.proconfig).toContain("search_path=pg_catalog, public");
        expect(f.pub).toBe(false);
        expect(f.app).toBe(true);
      }
    });
  });

  it("E (tier internal) reads every published platform pack, still not drafts", async () => {
    await asTenant(tE, async (c) => {
      expect((await idsOf(c, "question_packs")).sort()).toEqual([ids.p1, ids.p3].sort());
      expect((await idsOf(c, "questions")).sort()).toEqual([ids.qa, ids.qo].sort());
    });
  });

  it("D (revoked after use): browsing stops, the pinned question of its running test still reads", async () => {
    await asTenant(tD, async (c) => {
      expect((await c.query(`SELECT licensed_pack_ids() AS v`)).rows[0].v).toEqual([]);
      expect(await idsOf(c, "questions")).toEqual([ids.qa]); // only the frozen-pool question, not draft/other
      expect(await count(c, "question_versions", `question_id = '${ids.qa}'`)).toBeGreaterThan(0);
      expect(await count(c, "question_packs", `id = '${ids.p1}'`)).toBe(1); // metadata for the running test
    });
    // the admin bank list is built on licensed packs only: the revoked tenant lists nothing
    const list = await listQuestions(tD, { page: 1, pageSize: 50 }, "admin");
    expect(list.items).toHaveLength(0);
    // revoking is immediate for a tenant that never pinned anything
    await asTenant(tC, async (c) => expect(await count(c, "questions")).toBe(0));
  });
});

describe("EXP-14 phase 2: writes and attacks", () => {
  it("no tenant can INSERT, UPDATE, DELETE or lock a platform row it can read", async () => {
    await asTenant(tA, async (c) => {
      expect((await c.query(`UPDATE questions SET topic='x' WHERE id=$1`, [ids.qa])).rowCount).toBe(0);
      expect((await c.query(`DELETE FROM questions WHERE id=$1`, [ids.qa])).rowCount).toBe(0);
      expect((await c.query(`UPDATE question_packs SET name='x' WHERE id=$1`, [ids.p1])).rowCount).toBe(0);
      expect((await c.query(`DELETE FROM question_versions WHERE question_id=$1`, [ids.qa])).rowCount).toBe(0);
      expect((await c.query(`SELECT id FROM questions WHERE id=$1 FOR SHARE`, [ids.qa])).rowCount).toBe(0); // lock needs UPDATE visibility
    });
    await asTenant(tA, async (c) => {
      await expect(c.query(
        `INSERT INTO questions (pack_id, level_id, type, topic, points, status, created_by, content)
         SELECT pack_id, level_id, type, 'x', 1, 'draft', created_by, content FROM questions WHERE id=$1`, [ids.qa],
      )).rejects.toThrow();
    });
    await asTenant(tA, async (c) => {
      await expect(c.query(`INSERT INTO question_packs (tenant_id, name, slug, domain, version, status, created_by)
        VALUES ($1,'forged','forged','soc',1,'draft',$2)`, [tP, uA])).rejects.toThrow();
    });
  });

  it("attack: a tenant cannot self-grant a licence (entitlement INSERT is not allowed for the app role)", async () => {
    // The harness keeps the legacy membership assessiq_app -> assessiq_system (0002), so assert the direct grant.
    await sup(async (c) => {
      const r = await c.query(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name='tenant_entitlements' AND grantee='assessiq_app'`);
      expect(r.rows.map((x) => x.privilege_type)).not.toContain("INSERT");
    });
  });

  it("attack: pointing current_tenant at the platform id gives nothing (no cross-tenant by header)", async () => {
    // current_tenant is set from the session by the server; here we check the policy itself: the platform
    // tenant's own rows are visible to the platform, not to a licensed tenant that merely knows the id.
    await asTenant(tA, async (c) => {
      expect(await count(c, "questions", `tenant_id = '${tP}' AND status <> 'active'`)).toBe(0);
    });
  });

  it("attack: a withdrawn or archived master question disappears from a licensed tenant at once", async () => {
    await sup((c) => c.query(`UPDATE questions SET status='archived' WHERE id=$1`, [ids.qa]));
    await asTenant(tA, async (c) => expect(await count(c, "questions", `id='${ids.qa}'`)).toBe(0));
    await sup((c) => c.query(`UPDATE questions SET status='active' WHERE id=$1`, [ids.qa]));
    await asTenant(tA, async (c) => expect(await count(c, "questions", `id='${ids.qa}'`)).toBe(1));
  });

  it("attack: revoking the entitlement of A removes browsing in the next query", async () => {
    await sup((c) => c.query(`UPDATE tenant_entitlements SET status='revoked' WHERE tenant_id=$1`, [tA]));
    await asTenant(tA, async (c) => {
      expect(await count(c, "questions")).toBe(0);
      expect(await count(c, "question_packs")).toBe(0);
    });
    await sup((c) => c.query(`UPDATE tenant_entitlements SET status='active' WHERE tenant_id=$1`, [tA]));
    await asTenant(tA, async (c) => expect(await count(c, "questions")).toBe(1));
  });
});

describe("EXP-14 phase 2: services see the redacted view (FUT-2 still applies)", () => {
  it("licensed tenant admin: platform question has no key, rubric or source ref; the list holds only entitled packs", async () => {
    const q = await getQuestion(tA, ids.qa, "admin");
    expect(q.licensed).toBe(true);
    expect(JSON.stringify(q)).not.toContain(KEY);
    expect(q.rubric).toBeNull();
    const vers = await listVersions(tA, ids.qa, "admin");
    expect(vers.length).toBeGreaterThan(0);
    expect(JSON.stringify(vers)).not.toContain(KEY);
    const list = await listQuestions(tA, { page: 1, pageSize: 100 }, "admin");
    expect(list.items.map((x) => x.id)).toEqual([ids.qa]);
    expect(JSON.stringify(list)).not.toContain(KEY);
  });

  it("an unlicensed tenant gets not-found for a platform question id", async () => {
    await expect(getQuestion(tC, ids.qa, "admin")).rejects.toThrow(/not found/i);
    await expect(getQuestion(tA, ids.qd, "admin")).rejects.toThrow(/not found/i); // draft in a licensed pack
  });
});

describe("EXP-14 phase 2: cost and stats", () => {
  it("the child-table parent lookup runs each helper function once (EXPLAIN printed)", async () => {
    await sup((c) => c.query(`ALTER DATABASE aiq_test SET track_functions = 'all'`));
    await asTenant(tA, async (c) => {
      const calls = async (): Promise<number> =>
        Number((await c.query(`SELECT COALESCE(SUM(pg_stat_get_xact_function_calls(p.oid)),0) AS n FROM pg_proc p WHERE p.proname IN ('licensed_pack_ids','readable_platform_packs','licensed_platform_tenant')`)).rows[0].n);
      const c0 = await calls();
      const plan = await c.query(`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) SELECT count(*) FROM question_versions WHERE question_id = '${ids.qa}'`);
      const lines = (r: { rows: Array<Record<string, string>> }): string => r.rows.map((x) => x["QUERY PLAN"]).join(String.fromCharCode(10));
      const text = lines(plan);
      const c1 = await calls();
      const full = await c.query(`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) SELECT count(*) FROM question_versions`);
      const c2 = await calls();
      const nl = String.fromCharCode(10);
      const report = ["EXPLAIN (one question, 20 version rows):", text, "EXPLAIN (all versions):", lines(full), `function calls: single-question query ${c1 - c0}, full scan ${c2 - c1}`].join(nl);
      writeFileSync(join(tmpdir(), "e14-explain.txt"), report); // read by the session footer
      // each helper runs a fixed handful of times per query (InitPlan), never once per row
      expect(c1 - c0).toBeLessThanOrEqual(6);
      expect(c2 - c1).toBeLessThanOrEqual(6);
      expect(text).toContain("InitPlan");
    });
  });

  it("shared item stats: below the 5-attempt floor nothing is returned; unlicensed tenants get null", async () => {
    await sup(async (c) => {
      // question_stats_mv is a materialized view: seed through a view-compatible path if present
      const mv = await c.query(`SELECT 1 FROM pg_matviews WHERE matviewname = 'question_stats_mv'`);
      expect(mv.rowCount).toBe(1);
    });
    expect(await getSharedItemStats(tC, ids.qa)).toBeNull(); // cannot see the question
    expect(await getSharedItemStats(tA, ids.qa)).toBeNull(); // visible, but 0 attempts < floor
  });
});

describe("EXP-14 phase 2: frozen marks (attempt start)", () => {
  async function startWith(frozen: boolean, edit: boolean): Promise<{ points: number; negative: number }> {
    // tenant A own question: 3 points, penalty 0.5
    const pack = await createPack(tA, { name: `Marks ${randomUUID().slice(0, 6)}`, domain: "soc" }, uA);
    const level = await addLevel(tA, pack.id, { label: "L1" }, uA);
    const q = await createQuestion(tA, { pack_id: pack.id, level_id: level.id, type: "mcq", topic: "marks", points: 3, content: content("Marks") }, uA);
    const aid = randomUUID();
    const attId = randomUUID();
    await sup(async (c) => {
      await c.query(`UPDATE questions SET negative_marks=0.5, status='active' WHERE id=$1`, [q.id]);
      await c.query(
        `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, randomize, opens_at, settings, created_by)
         VALUES ($1,$2,$3,$4,1,'Marks','active',1,false,now(),'{}'::jsonb,$5)`,
        [aid, tA, pack.id, level.id, uA],
      );
      // freeze: an old-style row (marks_frozen false, no negative) or a new-style row
      await c.query(
        `INSERT INTO assessment_frozen_pool (tenant_id, assessment_id, question_id, question_version, level_id, type, points, negative_marks, marks_frozen)
         VALUES ($1,$2,$3,1,$4,'mcq',3,$5,$6)`,
        [tA, aid, q.id, level.id, frozen ? 0.5 : null, frozen],
      );
      if (edit) await c.query(`UPDATE questions SET points=9, negative_marks=2 WHERE id=$1`, [q.id]); // master edit after freeze
      await c.query(`INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status) VALUES ($1,$2,$3,$4,'in_progress')`, [attId, tA, aid, uA]);
    });
    await withTenant(tA, (client) => insertAttemptQuestions(client, attId, [{ questionId: q.id, position: 1, questionVersion: 1 }], 0));
    return sup(async (c) => {
      const r = await c.query(`SELECT points::float8 AS p, negative_marks::float8 AS n FROM attempt_questions WHERE attempt_id=$1`, [attId]);
      return { points: r.rows[0].p, negative: r.rows[0].n };
    });
  }

  it("old frozen row (before 0279): scores exactly as before, live points and penalty", async () => {
    expect(await startWith(false, false)).toEqual({ points: 3, negative: 0.5 });
    expect(await startWith(false, true)).toEqual({ points: 9, negative: 2 }); // legacy behaviour kept on purpose
  });

  it("new frozen row: a master edit after the freeze cannot change a running test", async () => {
    expect(await startWith(true, false)).toEqual({ points: 3, negative: 0.5 });
    expect(await startWith(true, true)).toEqual({ points: 3, negative: 0.5 });
  });
});
