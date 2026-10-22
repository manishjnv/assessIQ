/**
 * RW-58: question import staging, commit, RLS and routes against a real Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { randomUUID } from "node:crypto";
import { AppError, sha256Hex } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { registerQuestionBankRoutes } from "../routes.js";
import { parseImportFile } from "../import/parse.js";
import { stageImport, getImportReport } from "../import/staging.js";
import { commitImport } from "../import/commit.js";

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

const HEAD = "type,topic,points,level,question,options,correct,rationale";
// EXP-4: rights_status is required in v2, so every v1-shaped fixture line gets ",original" appended.
const csv = (...lines: string[]): Buffer =>
  Buffer.from([`${HEAD},rights_status`, ...lines.map((l) => `${l},original`)].join("\r\n"), "utf8");
const GOOD = 'mcq,Net,1,1,Which port is HTTPS?,"[""80"",""443""]",1,HTTPS uses 443';
const BAD = 'mcq,Net,1,1,Broken question?,"[""a"",""b""]",7,out of range';
const meta = (data: Buffer, domain = "soc") => ({
  fileName: "q.csv", fileSha256: sha256Hex(data), format: "csv" as const, domain, packName: "Imported set",
});
async function stage(tenant: string, user: string, data: Buffer) {
  return stageImport(tenant, user, meta(data), await parseImportFile("csv", data));
}

async function buildApp(tenantId: string, userId: string) {
  const app = Fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: 4 * 1024 * 1024, files: 1, fields: 10 } });
  app.addHook("preHandler", async (req) => {
    (req as unknown as { session: unknown }).session = { tenantId, userId, role: req.headers["x-role"] };
  });
  app.setErrorHandler((err: Error, _req, reply) => {
    const status = err instanceof AppError ? err.status : 500;
    void reply.code(status).send({ error: err.message });
  });
  const superAdminOnly = async (req: { session?: { role?: unknown } }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (req.session?.role !== "super_admin") return reply.code(403).send({ error: "forbidden" });
  };
  await registerQuestionBankRoutes(app, { adminOnly: [], superAdminOnly: superAdminOnly as never });
  await app.ready();
  return app;
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
    for (const [id, slug, uid, email] of [[tA, "ta", uA, "a@x.io"], [tB, "tb", uB, "b@x.io"]] as const) {
      await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$2)`, [id, slug]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
      await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Admin','admin','active')`, [uid, id, email]);
    }
    await c.query(`INSERT INTO domains (tenant_id, slug, name) VALUES ($1,'soc','SOC')`, [tA]);
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

describe("staging", () => {
  it("1 valid + 1 invalid + 1 duplicate row gives the right decisions", async () => {
    const report = await stage(tA, uA, csv(GOOD, BAD, GOOD));
    expect(report.counts).toEqual({ total: 3, ok: 1, error: 1, duplicate: 1, skip: 0 });
    expect(report.rows.map((r) => [r.row, r.decision])).toEqual([[2, "ok"], [3, "error"], [4, "duplicate"]]);
    expect(report.rows[1]!.errors[0]).toMatchObject({ row: 3, column: "correct" });
  });

  it("staging the same file twice does not create a second import", async () => {
    const data = csv(GOOD, 'subjective,Policy,5,1,Explain least privilege.,,,');
    const first = await stage(tA, uA, data);
    const second = await stage(tA, uA, data);
    expect(second.importId).toBe(first.importId);
    const n = await sup(async (c) => (await c.query(`SELECT count(*)::int AS n FROM question_imports WHERE id=$1`, [first.importId])).rows[0].n);
    expect(n).toBe(1);
  });

  it("RLS hides one tenant's imports from another", async () => {
    const report = await stage(tA, uA, csv(GOOD, 'subjective,Policy,5,1,RLS probe question.,,,'));
    const seenByB = await withTenant(tB, async (c) => ({
      imports: (await c.query(`SELECT id FROM question_imports WHERE id=$1`, [report.importId])).rowCount,
      rows: (await c.query(`SELECT id FROM question_import_rows WHERE import_id=$1`, [report.importId])).rowCount,
    }));
    expect(seenByB).toEqual({ imports: 0, rows: 0 });
    await expect(getImportReport(tB, report.importId)).rejects.toThrow(/not found/);
  });
});

describe("commit", () => {
  it("creates one draft pack (source import) with only the ok rows; twice is a 409", async () => {
    const data = csv('subjective,Policy,5,1,Commit probe question one.,,,', BAD, 'subjective,Policy,5,2,Commit probe question two.,,,');
    const report = await stage(tA, uA, data);
    expect(report.counts.ok).toBe(2);
    const res = await commitImport(tA, uA, report.importId, { mode: "skip-errors" });
    expect(res.committed).toBe(2);
    const db = await sup(async (c) => ({
      pack: (await c.query(`SELECT source, status, import_file_sha256, domain FROM question_packs WHERE id=$1`, [res.packId])).rows[0],
      qs: (await c.query(`SELECT status FROM questions WHERE pack_id=$1`, [res.packId])).rows,
      imp: (await c.query(`SELECT status, committed_pack_id FROM question_imports WHERE id=$1`, [report.importId])).rows[0],
      audit: (await c.query(`SELECT count(*)::int AS n FROM audit_log WHERE action='question_import.committed' AND entity_id=$1`, [report.importId])).rows[0].n,
    }));
    expect(db.pack).toMatchObject({ source: "import", status: "draft", import_file_sha256: sha256Hex(data), domain: "soc" });
    expect(db.qs).toEqual([{ status: "draft" }, { status: "draft" }]);
    expect(db.imp).toMatchObject({ status: "committed", committed_pack_id: res.packId });
    expect(db.audit).toBe(1);
    await expect(commitImport(tA, uA, report.importId, { mode: "skip-errors" })).rejects.toMatchObject({ status: 409 });

    // Committed questions now count as existing duplicates for later files in the domain.
    const again = await stage(tA, uA, csv('subjective,Policy,5,1,Commit probe question one.,,,', 'subjective,Policy,5,1,Brand new question.,,,'));
    expect(again.rows.map((r) => r.decision)).toEqual(["duplicate", "ok"]);
  });
});

describe("EXP-23 append to an existing pack", () => {
  const stageTo = async (tenant: string, user: string, data: Buffer, targetPackId: string, targetLevelPosition?: number) =>
    stageImport(tenant, user, { ...meta(data), packName: "Appended", targetPackId, ...(targetLevelPosition !== undefined ? { targetLevelPosition } : {}) }, await parseImportFile("csv", data));

  it("questions land in the target pack (no new pack), levels map by the row level, a missing level fails", async () => {
    const first = await stage(tA, uA, csv('subjective,Policy,5,1,Append base question.,,,'));
    const base = await commitImport(tA, uA, first.importId, { mode: "skip-errors" });
    const second = await stageTo(tA, uA, csv('subjective,Policy,5,1,Append added question.,,,'), base.packId);
    const res = await commitImport(tA, uA, second.importId, { mode: "skip-errors" });
    expect(res.packId).toBe(base.packId);
    const st = await sup(async (c) => ({
      packs: (await c.query(`SELECT count(*)::int AS n FROM question_packs WHERE tenant_id=$1 AND name='Appended'`, [tA])).rows[0].n,
      qs: (await c.query(`SELECT count(*)::int AS n FROM questions WHERE pack_id=$1`, [base.packId])).rows[0].n,
      imp: (await c.query(`SELECT target_pack_id, committed_pack_id FROM question_imports WHERE id=$1`, [second.importId])).rows[0],
    }));
    expect(st.packs).toBe(0);
    expect(st.qs).toBe(2);
    expect(st.imp).toEqual({ target_pack_id: base.packId, committed_pack_id: base.packId });
    // a forced level position the pack does not have is refused at commit
    const third = await stageTo(tA, uA, csv('subjective,Policy,5,1,Append third question.,,,'), base.packId, 9);
    await expect(commitImport(tA, uA, third.importId, { mode: "skip-errors" })).rejects.toMatchObject({ details: { code: "IMPORT_TARGET_LEVEL_NOT_FOUND" } });
  });

  it("a pack of another tenant, an unknown pack, and an archived pack are refused at staging", async () => {
    await sup((c) => c.query(`INSERT INTO domains (tenant_id, slug, name) VALUES ($1,'soc','SOC')`, [tB]));
    const foreign = await sup(async (c) => {
      const id = randomUUID();
      await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,'foreign-p','F','soc','draft',$3)`, [id, tB, uB]);
      return id;
    });
    const data = csv('subjective,Policy,5,1,Append refused question.,,,');
    await expect(stageTo(tA, uA, data, foreign)).rejects.toMatchObject({ details: { code: "PACK_NOT_FOUND" } });
    await expect(stageTo(tA, uA, data, randomUUID())).rejects.toMatchObject({ details: { code: "PACK_NOT_FOUND" } });
    const archived = await sup(async (c) => {
      const id = randomUUID();
      await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,'arch-p','A','soc','archived',$3)`, [id, tA, uA]);
      return id;
    });
    await expect(stageTo(tA, uA, data, archived)).rejects.toMatchObject({ details: { code: "QUESTION_PACK_ARCHIVED" } });
  });
});

describe("routes", () => {
  it("403 for a tenant admin on every route", async () => {
    const app = await buildApp(tA, uA);
    const id = randomUUID();
    const calls = [
      app.inject({ method: "POST", url: "/api/admin/super/question-imports", headers: { "x-role": "admin" }, payload: {} }),
      app.inject({ method: "GET", url: `/api/admin/super/question-imports/${id}`, headers: { "x-role": "admin" } }),
      app.inject({ method: "PATCH", url: `/api/admin/super/question-imports/${id}/rows/2`, headers: { "x-role": "admin" }, payload: {} }),
      app.inject({ method: "POST", url: `/api/admin/super/question-imports/${id}/commit`, headers: { "x-role": "admin" } }),
      app.inject({ method: "POST", url: `/api/admin/super/question-imports/${id}/discard`, headers: { "x-role": "admin" } }),
      app.inject({ method: "GET", url: "/api/admin/super/question-imports/templates/mcq", headers: { "x-role": "admin" } }),
    ];
    for (const r of await Promise.all(calls)) expect(r.statusCode).toBe(403);
    await app.close();
  });

  const mp = (fields: Record<string, string>, file?: { name: string; data: Buffer }) => {
    const B = "----aiqtest";
    const L = "\r\n";
    const parts: Buffer[] = Object.entries(fields).map(([k, v]) => Buffer.from(`--${B}${L}Content-Disposition: form-data; name="${k}"${L}${L}${v}${L}`));
    if (file) parts.push(Buffer.from(`--${B}${L}Content-Disposition: form-data; name="file"; filename="${file.name}"${L}Content-Type: text/csv${L}${L}`), file.data, Buffer.from(L));
    parts.push(Buffer.from(`--${B}--${L}`));
    return { payload: Buffer.concat(parts), headers: { "x-role": "super_admin", "content-type": `multipart/form-data; boundary=${B}` } };
  };

  it("super admin: multipart upload stages the same report as the base64 upload", async () => {
    const app = await buildApp(tA, uA);
    const data = csv(GOOD.replace("Which port", "Multipart: which port"), BAD.replace("Broken", "Multipart broken"));
    const j = await app.inject({
      method: "POST", url: "/api/admin/super/question-imports", headers: { "x-role": "super_admin" },
      payload: { file_name: "flow.csv", format: "csv", content_base64: data.toString("base64"), domain: "soc" },
    });
    const m = await app.inject({ method: "POST", url: "/api/admin/super/question-imports", ...mp({ format: "csv", domain: "soc" }, { name: "flow.csv", data }) });
    expect(j.statusCode).toBe(201);
    expect(m.statusCode).toBe(201);
    expect(m.json().rows.map((r: { decision: string }) => r.decision)).toEqual(j.json().rows.map((r: { decision: string }) => r.decision));
    expect(m.json().rows).toHaveLength(j.json().rows.length);
    await app.close();
  });

  it("multipart without a file part is 400", async () => {
    const app = await buildApp(tA, uA);
    const r = await app.inject({ method: "POST", url: "/api/admin/super/question-imports", ...mp({ format: "csv", domain: "soc" }) });
    expect(r.statusCode).toBe(400);
    await app.close();
  });

  it("a 5 MB multipart file is 413 FILE_TOO_LARGE", async () => {
    const app = await buildApp(tA, uA);
    const r = await app.inject({
      method: "POST", url: "/api/admin/super/question-imports",
      ...mp({ format: "csv", domain: "soc" }, { name: "big.csv", data: Buffer.alloc(5 * 1024 * 1024, "a") }),
    });
    expect(r.statusCode).toBe(413);
    await app.close();
  });

  it("super admin: upload, fix a row, template, commit, commit again 409, discard", async () => {
    const app = await buildApp(tA, uA);
    const h = { "x-role": "super_admin" };
    const data = csv(GOOD.replace("Which port", "Route flow: which port"), BAD.replace("Broken", "Route flow broken"));
    const up = await app.inject({
      method: "POST", url: "/api/admin/super/question-imports", headers: h,
      payload: { file_name: "flow.csv", format: "csv", content_base64: data.toString("base64"), domain: "soc" },
    });
    expect(up.statusCode).toBe(201);
    const { importId, counts } = up.json();
    expect(counts).toMatchObject({ ok: 1, error: 1 });

    const fix = await app.inject({
      method: "PATCH", url: `/api/admin/super/question-imports/${importId}/rows/3`, headers: h, payload: { values: { correct: "0" } },
    });
    expect(fix.statusCode).toBe(200);
    expect(fix.json().counts).toMatchObject({ ok: 2, error: 0 });

    const get = await app.inject({ method: "GET", url: `/api/admin/super/question-imports/${importId}`, headers: h });
    expect(get.json().counts.ok).toBe(2);

    const tpl = await app.inject({ method: "GET", url: "/api/admin/super/question-imports/templates/mcq?format=xlsx", headers: h });
    expect(tpl.statusCode).toBe(200);
    expect(tpl.headers["content-type"]).toContain("spreadsheetml");

    const c1 = await app.inject({ method: "POST", url: `/api/admin/super/question-imports/${importId}/commit`, headers: h });
    expect(c1.statusCode).toBe(200);
    const c2 = await app.inject({ method: "POST", url: `/api/admin/super/question-imports/${importId}/commit`, headers: h });
    expect(c2.statusCode).toBe(409);

    const d = await stage(tA, uA, csv('subjective,P,1,1,Discard probe question.,,,'));
    const disc = await app.inject({ method: "POST", url: `/api/admin/super/question-imports/${d.importId}/discard`, headers: h });
    expect(disc.json().status).toBe("discarded");
    const bad = await app.inject({ method: "GET", url: "/api/admin/super/question-imports/not-a-uuid", headers: h });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});
