/**
 * EXP-14 phase 1 (migrations 0276, 0277, 0278) against a real Postgres: owner columns are filled by
 * the insert triggers, composite foreign keys reject a wrong owner, is_platform is unique, and the app
 * role can no longer insert into tenant_entitlements. Fake data only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { createPack, addLevel } from "../service/packs.js";
import { createQuestion } from "../service/questions.js";

let container: StartedTestContainer;
let url: string;
let tP = "";
let uP = "";
const tA = randomUUID();
const uA = randomUUID();

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
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
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'ta','ta')`, [tA]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [tA]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@x.io','Admin','super_admin','active')`, [uA, tA]);
    for (const t of [tP, tA]) await c.query(`INSERT INTO domains (tenant_id, slug, name) VALUES ($1,'soc','SOC') ON CONFLICT DO NOTHING`, [t]);
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

describe("EXP-14 phase 1", () => {
  it("marks exactly the platform tenant and keeps it unique", async () => {
    await sup(async (c) => {
      const r = await c.query(`SELECT slug FROM tenants WHERE is_platform`);
      expect(r.rows.map((x) => x.slug)).toEqual(["platform"]);
      await expect(c.query(`UPDATE tenants SET is_platform = true WHERE id=$1`, [tA])).rejects.toThrow();
    });
  });

  it("fills tenant_id and pack_id on questions and versions from the parent", async () => {
    const pack = await createPack(tA, { name: `P ${randomUUID().slice(0, 8)}`, domain: "soc" }, uA);
    const level = await addLevel(tA, pack.id, { label: "L1" }, uA);
    const q = await createQuestion(tA, {
      pack_id: pack.id, level_id: level.id, type: "mcq", topic: "t", points: 1,
      content: { question: `Owner fill ${randomUUID()}?`, options: ["a", "b"], correct: 0, rationale: "r" },
    }, uA);
    await sup(async (c) => {
      const qr = await c.query(`SELECT tenant_id FROM questions WHERE id=$1`, [q.id]);
      expect(qr.rows[0].tenant_id).toBe(tA);
      // a version insert that names no owner gets it from the question
      await c.query(`INSERT INTO question_versions (question_id, version, content, saved_by) VALUES ($1, 50, '{}'::jsonb, $2)`, [q.id, uA]);
      const vr = await c.query(`SELECT tenant_id, pack_id FROM question_versions WHERE question_id=$1`, [q.id]);
      expect(vr.rowCount).toBeGreaterThan(0);
      for (const v of vr.rows) {
        expect(v.tenant_id).toBe(tA);
        expect(v.pack_id).toBe(pack.id);
      }
    });
  });

  it("rejects a question that claims another tenant's pack, and a version with a wrong owner", async () => {
    const pack = await createPack(tP, { name: `PP ${randomUUID().slice(0, 8)}`, domain: "soc" }, uP);
    const level = await addLevel(tP, pack.id, { label: "L1" }, uP);
    const q = await createQuestion(tP, {
      pack_id: pack.id, level_id: level.id, type: "mcq", topic: "t", points: 1,
      content: { question: `Platform item ${randomUUID()}?`, options: ["a", "b"], correct: 0, rationale: "r" },
    }, uP);
    await sup(async (c) => {
      // question row tagged with tenant A inside a platform pack: composite FK fails
      await expect(c.query(
        `INSERT INTO questions (pack_id, level_id, tenant_id, type, topic, points, status, created_by, content)
         SELECT pack_id, level_id, $2, type, 'x', 1, 'draft', created_by, content FROM questions WHERE id=$1`, [q.id, tA],
      )).rejects.toThrow(/foreign key/);
      // version row with tenant A on a platform question: composite FK fails
      await expect(c.query(
        `INSERT INTO question_versions (question_id, version, content, saved_by, tenant_id)
         VALUES ($1, 99, '{}'::jsonb, $2, $3)`, [q.id, uP, tA],
      )).rejects.toThrow(/foreign key/);
    });
  });

  it("removes the app role's direct INSERT on tenant_entitlements", async () => {
    // The harness keeps the legacy assessiq_app -> assessiq_system membership (0002), so the role still
    // inherits INSERT there; production drops it (FUT-10, 0237). Assert the direct grant instead.
    await sup(async (c) => {
      const r = await c.query(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE table_name='tenant_entitlements' AND grantee='assessiq_app'`);
      const types = r.rows.map((x) => x.privilege_type);
      expect(types).not.toContain("INSERT");
      expect(types).toContain("SELECT");
    });
  });
});
