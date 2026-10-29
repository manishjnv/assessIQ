/**
 * EXP-10 part 1 (migration 0284) against a real Postgres - attack list, database and route part.
 * Test names carry the attack number from the S79 plan (A01 .. A22). The pure part is question-assets-unit.test.ts;
 * the attempt-scoped candidate route is module 06 attempt-assets.test.ts; licensed read (A13) is in exp14-phase2.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool, withSystemRole } from "@assessiq/tenancy";
import { registerQuestionBankRoutes } from "../routes.js";
import { createPack, addLevel } from "../service/packs.js";
import { createQuestion, updateQuestion, restoreVersion, getQuestion } from "../service/questions.js";
import { uploadQuestionAsset } from "../assets/assets.js";
import { clonePackToTenant } from "../clone/clone-on-grant.js";
import { resyncClonedPack } from "../clone/resync.js";
import { png, jpeg, GIF, SVG, multipart as mp } from "./image-fixtures.js";

let container: StartedTestContainer;
let url = "";
let tP = ""; let uP = "";
const tA = randomUUID(); const uA = randomUUID();
const tB = randomUUID(); const uB = randomUUID();
const tC = randomUUID(); const uC = randomUUID();
const tD = randomUUID(); const uD = randomUUID();

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function buildApp(tenantId: string, userId: string, role: "admin" | "super_admin" = "admin") {
  const app = Fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: 4 * 1024 * 1024, files: 1, fields: 10 } });
  app.addHook("preHandler", async (req) => {
    (req as unknown as { session: unknown }).session = { tenantId, userId, role };
  });
  app.setErrorHandler((e, _req, reply) => {
    const x = e as { status?: number; statusCode?: number; code?: string; details?: { code?: string }; message: string };
    reply.code(x.status ?? x.statusCode ?? 500).send({ code: x.details?.code ?? x.code, message: x.message });
  });
  await registerQuestionBankRoutes(app, { adminOnly: [], superAdminOnly: [] });
  await app.ready();
  return app;
}

const packOf: Record<string, { pack: string; level: string }> = {};
async function mkPack(tenant: string, user: string, key: string): Promise<{ pack: string; level: string }> {
  const p = await createPack(tenant, { name: `Pack ${key} ${randomUUID().slice(0, 6)}`, domain: "soc" }, user);
  const l = await addLevel(tenant, p.id, { label: "L1" }, user);
  packOf[key] = { pack: p.id, level: l.id };
  return packOf[key]!;
}

const baseContent = (extra: Record<string, unknown> = {}) => ({
  question: `Look at the figure ${randomUUID().slice(0, 6)}?`, options: ["one", "two", "three"], correct: 1, rationale: "because", ...extra,
});

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_assets" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_assets`;
  await sup((c) => applyAllMigrations(c));
  await setPoolForTesting(url);
  await sup(async (c) => {
    tP = (await c.query(`SELECT id FROM tenants WHERE slug='platform'`)).rows[0].id;
    uP = (await c.query(`SELECT id FROM users WHERE tenant_id=$1 LIMIT 1`, [tP])).rows[0].id;
    for (const [id, slug, uid, email] of [[tA, "ta", uA, "a@x.io"], [tB, "tb", uB, "b@x.io"], [tC, "tc", uC, "c@x.io"], [tD, "td", uD, "d@x.io"]] as const) {
      await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$2)`, [id, slug]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
      await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Admin','admin','active')`, [uid, id, email]);
      await c.query(`INSERT INTO domains (tenant_id, slug, name) VALUES ($1,'soc','SOC') ON CONFLICT DO NOTHING`, [id]);
    }
    await c.query(`INSERT INTO domains (tenant_id, slug, name) VALUES ($1,'soc','SOC') ON CONFLICT DO NOTHING`, [tP]);
  });
  await mkPack(tA, uA, "A"); await mkPack(tB, uB, "B"); await mkPack(tC, uC, "C"); await mkPack(tD, uD, "D");
}, 180_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

const uploadJson = (app: Awaited<ReturnType<typeof buildApp>>, pack: string, data: Buffer, alt = "A test figure for the question", extra: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: "/api/admin/question-assets", payload: { pack_id: pack, alt_text: alt, content_base64: data.toString("base64"), ...extra } });

describe("upload route", () => {
  it("uploads a PNG: 201 with metadata only, the stored bytes are the cleaned bytes, the hash is of those bytes", async () => {
    const app = await buildApp(tA, uA);
    const res = await uploadJson(app, packOf["A"]!.pack, png({ seed: 1 }));
    expect(res.statusCode).toBe(201);
    const meta = res.json();
    expect(Object.keys(meta).sort()).toEqual(["alt_text", "byte_size", "created_at", "deduped", "height", "id", "mime", "pack_id", "sha256", "width"]);
    expect(JSON.stringify(meta)).not.toContain("data");
    const row = await sup(async (c) => (await c.query(`SELECT tenant_id, sha256, data, created_by FROM question_assets WHERE id=$1`, [meta.id])).rows[0]);
    expect(row.tenant_id).toBe(tA);
    expect(row.created_by).toBe(uA);
    expect(createHash("sha256").update(row.data).digest("hex")).toBe(row.sha256);
  });

  it("the same image uploaded again to the same pack is 200 and the same row (deduped)", async () => {
    const app = await buildApp(tA, uA);
    const a = await uploadJson(app, packOf["A"]!.pack, png({ seed: 2 }));
    const b = await uploadJson(app, packOf["A"]!.pack, png({ seed: 2 }), "A different alt text, ignored");
    expect([a.statusCode, b.statusCode]).toEqual([201, 200]);
    expect(b.json().id).toBe(a.json().id);
    expect(b.json().deduped).toBe(true);
  });

  it("A01 an SVG with a script is refused with 422, as multipart and as JSON", async () => {
    const app = await buildApp(tA, uA);
    const j = await uploadJson(app, packOf["A"]!.pack, SVG);
    expect(j.statusCode).toBe(422);
    expect(j.json().code).toBe("ASSET_BAD_FORMAT");
    const m = mp({ pack_id: packOf["A"]!.pack, alt_text: "A figure of a circuit" }, { name: "x.png", type: "image/png", data: SVG });
    const r = await app.inject({ method: "POST", url: "/api/admin/question-assets", payload: m.body, headers: { "content-type": m.contentType } });
    expect(r.statusCode).toBe(422);
  });

  it("A02 a PNG with a ZIP appended is refused with 422 ASSET_TRAILING_DATA", async () => {
    const app = await buildApp(tA, uA);
    const res = await uploadJson(app, packOf["A"]!.pack, Buffer.concat([png({ seed: 3 }), Buffer.from("PK\x03\x04payload", "latin1")]));
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("ASSET_TRAILING_DATA");
  });

  it("A03 a GIF behind an image name and type is refused; a real PNG named .exe is accepted and no file name is stored", async () => {
    const app = await buildApp(tA, uA);
    const gif = mp({ pack_id: packOf["A"]!.pack, alt_text: "A figure of a circuit" }, { name: "evil.svg.png", type: "image/png", data: GIF });
    const r1 = await app.inject({ method: "POST", url: "/api/admin/question-assets", payload: gif.body, headers: { "content-type": gif.contentType } });
    expect(r1.statusCode).toBe(422);
    const ok = mp({ pack_id: packOf["A"]!.pack, alt_text: "A figure of a circuit" }, { name: "../../etc/passwd.exe", type: "application/x-msdownload", data: png({ seed: 4 }) });
    const r2 = await app.inject({ method: "POST", url: "/api/admin/question-assets", payload: ok.body, headers: { "content-type": ok.contentType } });
    expect(r2.statusCode).toBe(201);
    const cols = await sup(async (c) => (await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name='question_assets'`)).rows.map((x) => x.column_name));
    expect(cols.some((n: string) => /name|file/i.test(n))).toBe(false);
  });

  it("A06 metadata never reaches the table: a JPEG with GPS EXIF is stored without it", async () => {
    const app = await buildApp(tA, uA);
    const exif = Buffer.from("Exif\0\0MM\0*GPSLatitude=12.97;Make=SecretCam", "latin1");
    const res = await uploadJson(app, packOf["A"]!.pack, jpeg({ app1: exif, seed: 5 }));
    expect(res.statusCode).toBe(201);
    const data: Buffer = await sup(async (c) => (await c.query(`SELECT data FROM question_assets WHERE id=$1`, [res.json().id])).rows[0].data);
    expect(data.includes(Buffer.from("GPSLatitude"))).toBe(false);
    expect(data.includes(Buffer.from("SecretCam"))).toBe(false);
  });

  it("A07 oversize: 500 KB as multipart is 413 ASSET_TOO_LARGE; as JSON base64 also 413; a 2 MB body is stopped before parsing", async () => {
    const app = await buildApp(tA, uA);
    const big = Buffer.concat([png({ seed: 6 }), Buffer.alloc(500 * 1024)]);
    const m = mp({ pack_id: packOf["A"]!.pack, alt_text: "A figure of a circuit" }, { name: "a.png", type: "image/png", data: big });
    const r = await app.inject({ method: "POST", url: "/api/admin/question-assets", payload: m.body, headers: { "content-type": m.contentType } });
    expect(r.statusCode).toBe(413);
    expect(r.json().code).toBe("ASSET_TOO_LARGE");
    const j = await uploadJson(app, packOf["A"]!.pack, big);
    expect(j.statusCode).toBe(413);
    const huge = await uploadJson(app, packOf["A"]!.pack, Buffer.alloc(2 * 1024 * 1024));
    expect(huge.statusCode).toBe(413);
  });

  it("A09 upload into another organisation's pack, or into a platform pack, is 404 and writes nothing", async () => {
    const app = await buildApp(tA, uA);
    const before = await sup(async (c) => Number((await c.query(`SELECT count(*) FROM question_assets`)).rows[0].count));
    const intoB = await uploadJson(app, packOf["B"]!.pack, png({ seed: 7 }));
    expect(intoB.statusCode).toBe(404);
    const platformPack = await createPack(tP, { name: `Plat ${randomUUID().slice(0, 6)}`, domain: "soc" }, uP);
    const intoP = await uploadJson(app, platformPack.id, png({ seed: 8 }));
    expect(intoP.statusCode).toBe(404);
    expect(await sup(async (c) => Number((await c.query(`SELECT count(*) FROM question_assets`)).rows[0].count))).toBe(before);
  });

  it("A16 mass assignment: JSON with tenant_id, sha256 or mime is refused; extra multipart fields never change the owner", async () => {
    const app = await buildApp(tA, uA);
    const j = await uploadJson(app, packOf["A"]!.pack, png({ seed: 9 }), "A figure of a circuit", { tenant_id: tB, sha256: "0".repeat(64), mime: "image/jpeg" });
    expect(j.statusCode).toBe(400);
    const m = mp({ pack_id: packOf["A"]!.pack, alt_text: "A figure of a circuit", tenant_id: tB, mime: "image/jpeg", sha256: "1".repeat(64) }, { name: "a.png", type: "image/png", data: png({ seed: 10 }) });
    const r = await app.inject({ method: "POST", url: "/api/admin/question-assets", payload: m.body, headers: { "content-type": m.contentType } });
    expect(r.statusCode).toBe(201);
    const row = await sup(async (c) => (await c.query(`SELECT tenant_id, mime, sha256 FROM question_assets WHERE id=$1`, [r.json().id])).rows[0]);
    expect(row.tenant_id).toBe(tA);
    expect(row.mime).toBe("image/png");
    expect(row.sha256).not.toBe("1".repeat(64));
  });

  it("A17 six parallel uploads of the same image leave exactly one row", async () => {
    const app = await buildApp(tB, uB);
    const img = png({ seed: 11 });
    const rs = await Promise.all(Array.from({ length: 6 }, () => uploadJson(app, packOf["B"]!.pack, img)));
    expect(rs.every((r) => r.statusCode === 200 || r.statusCode === 201)).toBe(true);
    expect(new Set(rs.map((r) => r.json().id)).size).toBe(1);
    const n = await sup(async (c) => Number((await c.query(`SELECT count(*) FROM question_assets WHERE tenant_id=$1 AND sha256=$2`, [tB, rs[0]!.json().sha256])).rows[0].count));
    expect(n).toBe(1);
  });

  it("A17 storage exhaustion: at 100 MB the organisation gets 409 ASSET_TENANT_CAP; at 500 images a pack gets 409 ASSET_PACK_CAP", async () => {
    // Tenant C: 256 rows of 400 KB = exactly the 100 MB cap.
    await sup((c) => c.query(
      `INSERT INTO question_assets (tenant_id, pack_id, sha256, mime, byte_size, width, height, alt_text, data)
       SELECT $1, $2, encode(sha256(i::text::bytea), 'hex'), 'image/png', 409600, 64, 64, 'Filler image for the cap test', decode(repeat('00', 409600), 'hex')
         FROM generate_series(1, 256) i`, [tC, packOf["C"]!.pack]));
    const appC = await buildApp(tC, uC);
    const capped = await uploadJson(appC, packOf["C"]!.pack, png({ seed: 12 }));
    expect(capped.statusCode).toBe(409);
    expect(capped.json().code).toBe("ASSET_TENANT_CAP");
    // Tenant D: 500 tiny rows in one pack.
    await sup((c) => c.query(
      `INSERT INTO question_assets (tenant_id, pack_id, sha256, mime, byte_size, width, height, alt_text, data)
       SELECT $1, $2, encode(sha256(('d' || i)::bytea), 'hex'), 'image/png', 4, 64, 64, 'Tiny filler image for the cap test', decode('89504e47', 'hex')
         FROM generate_series(1, 500) i`, [tD, packOf["D"]!.pack]));
    const appD = await buildApp(tD, uD);
    const packCapped = await uploadJson(appD, packOf["D"]!.pack, png({ seed: 13 }));
    expect(packCapped.statusCode).toBe(409);
    expect(packCapped.json().code).toBe("ASSET_PACK_CAP");
  });

  it("A22 the upload writes one audit row (ids, size and hash, never the bytes)", async () => {
    const app = await buildApp(tA, uA);
    const res = await uploadJson(app, packOf["A"]!.pack, png({ seed: 14 }));
    const rows = await sup(async (c) => (await c.query(`SELECT * FROM audit_log WHERE action='question.asset.uploaded' AND entity_id=$1`, [res.json().id])).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(tA);
    expect(JSON.stringify(rows[0])).not.toMatch(/"data"|iVBOR/);
  });
});

describe("reading", () => {
  it("A21 the bytes come with locked-down headers", async () => {
    const app = await buildApp(tA, uA);
    const up = await uploadJson(app, packOf["A"]!.pack, png({ seed: 20 }));
    const res = await app.inject({ method: "GET", url: `/api/admin/question-assets/${up.json().id}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(res.headers["content-disposition"]).toBe('inline; filename="image"');
    expect(res.headers["cache-control"]).toBe("private, max-age=3600");
    expect(res.headers["etag"]).toBe(`"${up.json().sha256}"`);
    expect(createHash("sha256").update(res.rawPayload).digest("hex")).toBe(up.json().sha256);
    const meta = await app.inject({ method: "GET", url: `/api/admin/question-assets/${up.json().id}/meta` });
    expect(meta.statusCode).toBe(200);
    expect(meta.json()).not.toHaveProperty("data");
  });

  it("A10 another organisation's admin gets 404 for the bytes and for the metadata", async () => {
    const appA = await buildApp(tA, uA);
    const up = await uploadJson(appA, packOf["A"]!.pack, png({ seed: 21 }));
    const appB = await buildApp(tB, uB);
    expect((await appB.inject({ method: "GET", url: `/api/admin/question-assets/${up.json().id}` })).statusCode).toBe(404);
    expect((await appB.inject({ method: "GET", url: `/api/admin/question-assets/${up.json().id}/meta` })).statusCode).toBe(404);
  });

  it("A12 a random id is 404, a hash or any non-id is 400, and there is no route that looks an image up by hash", async () => {
    const app = await buildApp(tA, uA);
    expect((await app.inject({ method: "GET", url: `/api/admin/question-assets/${randomUUID()}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/admin/question-assets/${"a".repeat(64)}` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api/admin/question-assets/by-hash/${"a".repeat(64)}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/admin/question-assets?sha256=${"a".repeat(64)}` })).statusCode).toBe(404);
  });
});

describe("content references and the database rule", () => {
  it("the trigger fills asset_ids from stem_assets and option_assets, and a GIN lookup finds the version", async () => {
    const a1 = (await uploadQuestionAsset(tA, uA, packOf["A"]!.pack, png({ seed: 30 }), "Figure one for the stem")).id;
    const a2 = (await uploadQuestionAsset(tA, uA, packOf["A"]!.pack, png({ seed: 31 }), "Figure two for option b")).id;
    const q = await createQuestion(tA, { pack_id: packOf["A"]!.pack, level_id: packOf["A"]!.level, type: "mcq", topic: "t", points: 1,
      content: baseContent({ math: true, stem_assets: [a1], option_assets: [null, a2, null] }) }, uA);
    // Version rows are written when a question changes or its pack is published: an edit snapshots the content that used the images.
    await updateQuestion(tA, q.id, { content: baseContent() }, uA);
    const ids = await sup(async (c) => (await c.query(`SELECT asset_ids FROM question_versions WHERE question_id=$1`, [q.id])).rows.flatMap((r) => r.asset_ids));
    expect([...ids].sort()).toEqual([a1, a2].sort());
    const hit = await sup(async (c) => Number((await c.query(`SELECT count(*) FROM question_versions WHERE asset_ids @> ARRAY[$1]::uuid[]`, [a2])).rows[0].count));
    expect(hit).toBe(1);
  });

  it("A15 a question that names another organisation's image is refused (422 from the service, 23503 from the database)", async () => {
    const foreign = (await uploadQuestionAsset(tA, uA, packOf["A"]!.pack, png({ seed: 32 }), "Organisation A figure")).id;
    await expect(createQuestion(tB, { pack_id: packOf["B"]!.pack, level_id: packOf["B"]!.level, type: "mcq", topic: "t", points: 1,
      content: baseContent({ stem_assets: [foreign] }) }, uB)).rejects.toMatchObject({ details: { code: "ASSET_NOT_IN_PACK" } });
    // Same pack rule inside ONE organisation: an image of pack A2 cannot sit in a question of pack A.
    const other = await mkPack(tA, uA, "A2");
    const inOther = (await uploadQuestionAsset(tA, uA, other.pack, png({ seed: 33 }), "Figure of the other pack")).id;
    await expect(createQuestion(tA, { pack_id: packOf["A"]!.pack, level_id: packOf["A"]!.level, type: "mcq", topic: "t", points: 1,
      content: baseContent({ stem_assets: [inOther] }) }, uA)).rejects.toMatchObject({ details: { code: "ASSET_NOT_IN_PACK" } });
    // Backstop: a raw insert that skips the service is stopped by the trigger.
    const qid = (await createQuestion(tB, { pack_id: packOf["B"]!.pack, level_id: packOf["B"]!.level, type: "mcq", topic: "t", points: 1, content: baseContent() }, uB)).id;
    await expect(sup((c) => c.query(`INSERT INTO question_versions (question_id, version, content, saved_by) VALUES ($1, 9, $2::jsonb, $3)`,
      [qid, JSON.stringify(baseContent({ stem_assets: [foreign] })), uB]))).rejects.toMatchObject({ code: "23503" });
  });

  it("content that is not an id, or names more than 6 images, is refused by the schema and by the database", async () => {
    await expect(createQuestion(tA, { pack_id: packOf["A"]!.pack, level_id: packOf["A"]!.level, type: "mcq", topic: "t", points: 1,
      content: baseContent({ stem_assets: ["../../etc/passwd"] }) }, uA)).rejects.toMatchObject({ details: { code: "INVALID_CONTENT" } });
    const ids = await Promise.all([40, 41, 42, 43].map(async (n) => (await uploadQuestionAsset(tA, uA, packOf["A"]!.pack, png({ seed: n }), `Figure number ${n}`)).id));
    await expect(createQuestion(tA, { pack_id: packOf["A"]!.pack, level_id: packOf["A"]!.level, type: "mcq", topic: "t", points: 1,
      content: baseContent({ stem_assets: ids.slice(0, 3), option_assets: [ids[3]!, ids[0]!, ids[1]!].concat([]) }) }, uA)).resolves.toBeDefined(); // 4 distinct ids
    const many = await Promise.all([50, 51, 52, 53, 54, 55, 56].map(async (n) => (await uploadQuestionAsset(tA, uA, packOf["A"]!.pack, png({ seed: n }), `Figure number ${n}`)).id));
    await expect(createQuestion(tA, { pack_id: packOf["A"]!.pack, level_id: packOf["A"]!.level, type: "mcq", topic: "t", points: 1,
      content: baseContent({ stem_assets: many.slice(0, 3), option_assets: many.slice(3, 6) }) }, uA)).resolves.toBeDefined(); // exactly 6 is fine
    await expect(createQuestion(tA, { pack_id: packOf["A"]!.pack, level_id: packOf["A"]!.level, type: "mcq", topic: "t", points: 1,
      content: baseContent({ stem_assets: many.slice(0, 3), option_assets: many.slice(3, 7) }) }, uA)).rejects.toMatchObject({ details: { code: "INVALID_CONTENT" } });
  });

  it("images are immutable: an UPDATE of a question_assets row fails", async () => {
    const id = (await uploadQuestionAsset(tA, uA, packOf["A"]!.pack, png({ seed: 60 }), "Figure sixty for the test")).id;
    await expect(sup((c) => c.query(`UPDATE question_assets SET alt_text = 'Changed after the fact' WHERE id = $1`, [id]))).rejects.toThrow(/immutable/);
  });

  it("restore version (gap a): an old version that used an image comes back with its image and asset_ids", async () => {
    const img = (await uploadQuestionAsset(tA, uA, packOf["A"]!.pack, png({ seed: 61 }), "Figure sixty one for restore")).id;
    const q = await createQuestion(tA, { pack_id: packOf["A"]!.pack, level_id: packOf["A"]!.level, type: "mcq", topic: "t", points: 1,
      content: baseContent({ stem_assets: [img] }) }, uA);
    await updateQuestion(tA, q.id, { content: baseContent() }, uA);
    const restored = await restoreVersion(tA, q.id, 1, uA);
    expect((restored.content as { stem_assets?: string[] }).stem_assets).toEqual([img]);
    const v1 = await sup(async (c) => (await c.query(`SELECT asset_ids FROM question_versions WHERE question_id=$1 AND version=1`, [q.id])).rows[0].asset_ids);
    expect(v1).toEqual([img]);
    expect((await getQuestion(tA, q.id)).id).toBe(q.id);
  });
});

describe("clone and re-sync copy the images (gap a)", () => {
  it("clone-on-grant copies each image into the target pack with the same bytes and rewrites the ids; re-sync with no content change bumps nothing", async () => {
    const plat = await createPack(tP, { name: `Plat img ${randomUUID().slice(0, 6)}`, domain: "soc" }, uP);
    const lvl = await addLevel(tP, plat.id, { label: "L1" }, uP);
    const pa = await uploadQuestionAsset(tP, uP, plat.id, png({ seed: 70 }), "Platform figure for the stem");
    const pb = await uploadQuestionAsset(tP, uP, plat.id, jpeg({ seed: 71 }), "Platform figure for option two");
    const q = await createQuestion(tP, { pack_id: plat.id, level_id: lvl.id, type: "mcq", topic: "t", points: 1,
      content: baseContent({ stem_assets: [pa.id], option_assets: [null, pb.id, null] }) }, uP);
    await sup(async (c) => {
      await c.query(`UPDATE question_packs SET status='published' WHERE id=$1`, [plat.id]);
      await c.query(`UPDATE questions SET status='active' WHERE id=$1`, [q.id]);
    });
    const cloned = await withSystemRole("test clone", async (c) => clonePackToTenant(c, plat.id, tA, uA));
    const clonePackId = cloned.clonedPackId;
    const rows = await sup(async (c) => ({
      q: (await c.query(`SELECT id, content FROM questions WHERE pack_id=$1`, [clonePackId])).rows[0],
      assets: (await c.query(`SELECT id, sha256, tenant_id, pack_id, encode(data,'hex') AS hex FROM question_assets WHERE pack_id=$1 ORDER BY sha256`, [clonePackId])).rows,
    }));
    const srcHex = await sup(async (c) => (await c.query(`SELECT sha256, encode(data,'hex') AS hex FROM question_assets WHERE id = ANY($1::uuid[]) ORDER BY sha256`, [[pa.id, pb.id]])).rows);
    expect(rows.assets).toHaveLength(2);
    expect(rows.assets.map((r) => r.sha256)).toEqual(srcHex.map((r) => r.sha256));
    expect(rows.assets.map((r) => r.hex)).toEqual(srcHex.map((r) => r.hex));
    expect(rows.assets.every((r) => r.tenant_id === tA && r.pack_id === clonePackId)).toBe(true);
    const content = rows.q.content as { stem_assets: string[]; option_assets: (string | null)[] };
    expect(content.stem_assets[0]).not.toBe(pa.id);
    expect(rows.assets.map((r) => r.id)).toEqual(expect.arrayContaining([content.stem_assets[0], content.option_assets[1]]));
    const versions = await sup(async (c) => (await c.query(`SELECT asset_ids FROM question_versions WHERE question_id=$1`, [rows.q.id])).rows);
    expect(versions[0]!.asset_ids.sort()).toEqual([content.stem_assets[0], content.option_assets[1]].sort());

    // Re-sync after the master pack version moves but no content changes: the question must not get a new version.
    await sup((c) => c.query(`UPDATE question_packs SET version = version + 1 WHERE id=$1`, [plat.id]));
    const rs = await withSystemRole("test resync", async (c) => resyncClonedPack(c, plat.id, tA, uA));
    expect(rs.changed).toBe(0);
    expect(rs.added).toBe(0);
    const nv = await sup(async (c) => Number((await c.query(`SELECT count(*) FROM question_versions WHERE question_id=$1`, [rows.q.id])).rows[0].count));
    expect(nv).toBe(1);
    const nAssets = await sup(async (c) => Number((await c.query(`SELECT count(*) FROM question_assets WHERE pack_id=$1`, [clonePackId])).rows[0].count));
    expect(nAssets).toBe(2); // copies reused, not doubled
  });
});

describe("import carries no images (part 1)", () => {
  it("a JSON bulk import row with stem_assets or option_assets is refused with IMPORT_IMAGES_NOT_SUPPORTED", async () => {
    const { bulkImport } = await import("../service/questions.js");
    const id = (await uploadQuestionAsset(tA, uA, packOf["A"]!.pack, png({ seed: 80 }), "Figure eighty for import")).id;
    const body = {
      pack: { slug: `imp-${randomUUID().slice(0, 8)}`, name: "Imp pack", domain: "soc" },
      levels: [{ position: 1, label: "L1", duration_minutes: 10, default_question_count: 1, passing_score_pct: 50 }],
      questions: [{ level_position: 1, type: "mcq", topic: "t", points: 1, content: baseContent({ stem_assets: [id] }) }],
    };
    await expect(bulkImport(tA, Buffer.from(JSON.stringify(body)), "json", uA)).rejects.toMatchObject({ details: { code: "IMPORT_IMAGES_NOT_SUPPORTED" } });
    // math: true alone is plain text and is allowed to travel with an import.
    const okBody = { ...body, pack: { ...body.pack, slug: `imp-${randomUUID().slice(0, 8)}` }, questions: [{ ...body.questions[0]!, content: baseContent({ math: true, question: "Find \\(x^2\\) now?" }) }] };
    await expect(bulkImport(tA, Buffer.from(JSON.stringify(okBody)), "json", uA)).resolves.toBeDefined();
  });
});

describe("list queries never read the image bytes", () => {
  it("only the three named functions select the data column of question_assets", () => {
    const roots = [join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."), ];
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        if (n === "node_modules" || n === "__tests__" || n === "dist") continue;
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts")) files.push(p);
      }
    };
    for (const r of roots) walk(r);
    const allowed = ["assets/assets.ts", "attempt-assets.ts"];
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf-8");
      if (!/question_assets/.test(src)) continue;
      const norm = f.replace(/\\/g, "/");
      if (/SELECT\s+\*[^;`]*question_assets/i.test(src)) offenders.push(`${norm}: SELECT *`);
      if (!allowed.some((a) => norm.endsWith(a)) && /SELECT[^;`]*\bdata\b[^;`]*FROM\s+question_assets/i.test(src)) offenders.push(`${norm}: reads data`);
    }
    expect(offenders).toEqual([]);
    const svc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "assets.ts"), "utf-8");
    const metaCols = /const META_COLS = "([^"]+)"/.exec(svc)![1]!;
    expect(metaCols).not.toMatch(/\bdata\b/);
  });
});
