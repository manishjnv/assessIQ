/**
 * EXP-22: template_generated seed_ref format, duplicate handling, prefix withdraw. Real Postgres. Fake questions only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { csvCell, sha256Hex } from "@assessiq/core";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { parseImportFile } from "../import/parse.js";
import { stageImport } from "../import/staging.js";
import { commitImport } from "../import/commit.js";
import { withdrawBySeedRefPrefix } from "../import/seed-withdraw.js";
import { seedRefError, seedRefPrefixError } from "../import/v2.js";

let container: StartedTestContainer;
let url: string;
let tP = "";
const tB = randomUUID();
const uP = randomUUID();
const uB = randomUUID();

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

const COLS = ["type", "topic", "points", "level", "question", "options", "correct", "rationale", "rights_status", "origin", "seed_ref"];
type Cells = Partial<Record<(typeof COLS)[number], string>>;
const csv = (rows: Cells[]): Buffer =>
  Buffer.from([COLS, ...rows.map((r) => COLS.map((c) => r[c] ?? ""))].map((r) => r.map(csvCell).join(",")).join("\r\n"), "utf8");
let seq = 5000;
const gen = (seedRef: string, extra: Cells = {}): Cells => {
  const n = seq++;
  return {
    type: "mcq", topic: "Speed", points: "1", level: "1", question: `Seed question ${n} about trains?`,
    options: JSON.stringify([`${n}`, `${n + 1}`]), correct: "1", rationale: "r", rights_status: "original",
    origin: "template_generated", seed_ref: seedRef, ...extra,
  };
};
const stage = async (tenant: string, user: string, rows: Cells[]) => {
  const data = csv(rows);
  return stageImport(tenant, user, { fileName: "g.csv", fileSha256: sha256Hex(data), format: "csv", domain: "soc", packName: "Gen" }, await parseImportFile("csv", data));
};
const commit = async (tenant: string, user: string, rows: Cells[]) => {
  const r = await stage(tenant, user, rows);
  await commitImport(tenant, user, r.importId, { mode: "skip-errors" });
  return r;
};

describe("EXP-22 pure format checks", () => {
  it("accepts the fixed format and rejects the rest", () => {
    for (const ok of ["speed.trains@1:seed=0:gen=1.0", "t-1@2.3:seed=42:gen=v1_a", "a@1.0-rc1:seed=7:gen=x"]) expect(seedRefError(ok)).toBeNull();
    for (const bad of ["", "nope", "T@1:seed=0:gen=1", "t@x:seed=0:gen=1", "t@1:seed=-1:gen=1", "t@1:seed=01:gen=1", "t@1:seed=0", "t@1:seed=0:gen=", "t@1:seed=0:gen=1 "]) {
      expect(seedRefError(bad), bad).not.toBeNull();
    }
  });
  it("prefix rule", () => {
    expect(seedRefPrefixError("a")).not.toBeNull();
    expect(seedRefPrefixError("abc")).not.toBeNull(); // no '@'
    expect(seedRefPrefixError("@ab")).not.toBeNull();
    expect(seedRefPrefixError("t@1")).toBeNull();
  });
});

describe("EXP-22 import and withdraw", () => {
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
      await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'tb','tb')`, [tB]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [tB]);
      await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'b@x.io','Admin','admin','active')`, [uB, tB]);
      await c.query(`INSERT INTO domains (tenant_id, slug, name) VALUES ($1,'soc','SOC')`, [tB]);
      tP = (await c.query<{ id: string }>(`SELECT id FROM tenants WHERE slug = 'platform'`)).rows[0]!.id;
      await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'p@x.io','Admin','super_admin','active')`, [uP, tP]);
      await c.query(`INSERT INTO domains (tenant_id, slug, name) VALUES ($1,'soc','SOC') ON CONFLICT DO NOTHING`, [tP]);
    });
  }, 120_000);

  afterAll(async () => {
    await closePool();
    if (container !== undefined) await container.stop();
  }, 30_000);

  it("a bad or missing seed_ref on template_generated is a row error; other origins are not checked", async () => {
    const r = await stage(tP, uP, [
      gen("bad"), gen(""), gen("ok.t@1:seed=1:gen=1"),
      gen("anything", { origin: "ai_seeded" }), gen("", { origin: "ai_seeded" }),
    ]);
    expect(r.rows.map((x) => x.decision)).toEqual(["error", "error", "ok", "ok", "ok"]);
    expect(r.rows[0]!.errors[0]).toMatchObject({ column: "seed_ref" });
    expect(r.rows[0]!.errors[0]!.message).toContain("<template_id>@<version>");
  });

  it("duplicate seed_ref: within the file and against an existing row is a duplicate decision, not a 500", async () => {
    const dup = await stage(tP, uP, [gen("dup.t@1:seed=1:gen=1"), gen("dup.t@1:seed=1:gen=1")]);
    expect(dup.rows.map((x) => x.decision)).toEqual(["ok", "duplicate"]);
    await commit(tP, uP, [gen("exist.t@1:seed=5:gen=1")]);
    const again = await stage(tP, uP, [gen("exist.t@1:seed=5:gen=1"), gen("exist.t@1:seed=6:gen=1")]);
    expect(again.rows.map((x) => x.decision)).toEqual(["duplicate", "ok"]);
    // The same seed_ref in another tenant is fine.
    expect((await stage(tB, uB, [gen("exist.t@1:seed=5:gen=1")])).rows[0]!.decision).toBe("ok");
  });

  it("migration 0246 indexes exist", async () => {
    await sup(async (c) => {
      const r = await c.query(`SELECT indexname FROM pg_indexes WHERE indexname IN ('question_source_seed_ref_prefix_idx','question_source_template_seed_uniq')`);
      expect(r.rowCount).toBe(2);
    });
  });

  it("prefix withdraw: dry run counts, bad prefix refused, happy path withdraws only matches, other tenant untouched, idempotent", async () => {
    await commit(tP, uP, [gen("wd.alpha@1:seed=1:gen=1"), gen("wd.alpha@1:seed=2:gen=1"), gen("wd.beta@1:seed=1:gen=1"), gen("wdxalpha@1:seed=1:gen=1")]);
    await commit(tB, uB, [gen("wd.alpha@1:seed=1:gen=1")]);

    await expect(withdrawBySeedRefPrefix(tP, uP, "super_admin", "w", false)).rejects.toThrow(/3 to 200/);
    await expect(withdrawBySeedRefPrefix(tP, uP, "super_admin", "wd.alpha", false)).rejects.toThrow(/@/);
    await expect(withdrawBySeedRefPrefix(tP, uP, "admin", "wd.alpha@", false)).rejects.toThrow();

    const dry = await withdrawBySeedRefPrefix(tP, uP, "super_admin", "wd.alpha@", true);
    expect(dry).toMatchObject({ matched: 2, withdrawn: 0, dry_run: true });
    const before = await sup((c) => c.query(`SELECT count(*)::int AS n FROM question_source WHERE rights_status = 'withdrawn' AND seed_ref LIKE 'wd%'`));
    expect(before.rows[0].n).toBe(0);

    // '.' is not a wildcard in LIKE, but '_' is: an escaped '_' must not match 'x'.
    expect((await withdrawBySeedRefPrefix(tP, uP, "super_admin", "wd_alpha@", true)).matched).toBe(0);

    const done = await withdrawBySeedRefPrefix(tP, uP, "super_admin", "wd.alpha@", false);
    expect(done).toMatchObject({ matched: 2, withdrawn: 2, dry_run: false });
    await sup(async (c) => {
      const rows = (await c.query<{ tenant_id: string; seed_ref: string; rights_status: string; status: string }>(
        `SELECT s.tenant_id, s.seed_ref, s.rights_status, q.status FROM question_source s JOIN questions q ON q.id = s.question_id WHERE s.seed_ref LIKE 'wd%'`)).rows;
      expect(rows).toHaveLength(5);
      for (const r of rows) {
        const hit = r.tenant_id === tP && r.seed_ref.startsWith("wd.alpha@");
        expect(r.rights_status).toBe(hit ? "withdrawn" : "original");
        if (hit) expect(r.status).toBe("archived"); else expect(r.status).not.toBe("archived");
      }
      expect((await c.query(`SELECT 1 FROM audit_log WHERE action = 'question.withdrawn' AND tenant_id = $1`, [tP])).rowCount).toBeGreaterThanOrEqual(2);
    });
    expect(await withdrawBySeedRefPrefix(tP, uP, "super_admin", "wd.alpha@", false)).toMatchObject({ matched: 0, withdrawn: 0 });
  });
});
