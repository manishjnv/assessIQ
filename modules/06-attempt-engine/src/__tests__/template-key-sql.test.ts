/**
 * EXP-24 SQL: the template key (question_source.seed_ref before '@') is read live, frozen in migration 0290's
 * column, and counted by the publish pre-flight the same way the draw counts it. Testcontainers (postgres:16-alpine).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool, withTenant } from "@assessiq/tenancy";
import { listPoolWithCategory } from "../repository.js";
import { assertSectionPoolsFillable } from "../../../05-assessment-lifecycle/src/service/blueprint.js";

vi.mock("@assessiq/audit-log", () => ({ audit: vi.fn(async () => undefined) }));

let container: StartedTestContainer;
let url: string;
const T = randomUUID();
const admin = randomUUID();
const pack = randomUUID();
const level = randomUUID();
const asm = randomUUID();
const ids = { a1: randomUUID(), a2: randomUUID(), b1: randomUUID(), h1: randomUUID() };

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_test" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_test`;
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await applyAllMigrations(c);
    await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await c.query(`INSERT INTO tenants (id,name,slug) VALUES ($1,'T','t-exp24')`, [T]);
    await c.query(`INSERT INTO users (id,tenant_id,email,name,role,status) VALUES ($1,$2,'a@t.test','Admin','admin','active')`, [admin, T]);
    await c.query(`INSERT INTO question_packs (id,tenant_id,slug,name,domain,status,created_by) VALUES ($1,$2,'pp','PP','aptitude','published',$3)`, [pack, T, admin]);
    await c.query(`INSERT INTO levels (id,pack_id,position,label,duration_minutes,default_question_count) VALUES ($1,$2,1,'L1',60,2)`, [level, pack]);
    // a1 and a2 = v1 and v2 of one template; b1 = another template; h1 = no source row (keyless)
    const seeds: Record<string, string | null> = { a1: "t.add@1:seed=1", a2: "t.add@2:seed=9", b1: "t.sub@1:seed=3", h1: null };
    for (const [k, id] of Object.entries(ids)) {
      await c.query(
        `INSERT INTO questions (id,pack_id,level_id,type,topic,points,status,content,created_by)
         VALUES ($1,$2,$3,'mcq','t',10,'active','{"question":"Q","options":["A","B"],"correct":0}',$4)`, [id, pack, level, admin]);
      await c.query(`INSERT INTO question_versions (question_id,version,content,saved_by) VALUES ($1,1,'{"question":"Q","options":["A","B"],"correct":0}',$2)`, [id, admin]);
      if (seeds[k] != null) {
        await c.query(`INSERT INTO question_source (tenant_id,question_id,origin,rights_status,seed_ref) VALUES ($1,$2,'ai_seeded','original',$3)`, [T, id, seeds[k]]);
      }
    }
    await c.query(`INSERT INTO assessments (id,tenant_id,pack_id,level_id,name,status,pack_version,question_count,created_by) VALUES ($1,$2,$3,$4,'A','active',1,2,$5)`, [asm, T, pack, level, admin]);
    // frozen rows as the freeze would write them (key from question_source)
    for (const id of Object.values(ids)) {
      await c.query(
        `INSERT INTO assessment_frozen_pool (tenant_id,assessment_id,question_id,question_version,level_id,type,points,template_key)
         VALUES ($1,$2,$3,1,$4,'mcq',10,(SELECT NULLIF(split_part(seed_ref,'@',1),'') FROM question_source WHERE question_id=$3))`, [T, asm, id, level]);
    }
  } finally { await c.end(); }
  await setPoolForTesting(url);
}, 180_000);

afterAll(async () => { await closePool(); await container?.stop(); });

const keys = (rows: Array<{ id: string; template_key: string | null }>) => Object.fromEntries(rows.map((r) => [r.id, r.template_key]));
const want = { [ids.a1]: "t.add", [ids.a2]: "t.add", [ids.b1]: "t.sub", [ids.h1]: null };

describe("EXP-24 template key SQL", () => {
  it("live pool: v1 and v2 share the key, keyless is null", async () => {
    const rows = await withTenant(T, (c) => listPoolWithCategory(c, { assessmentId: asm, packId: pack, levelId: level, useFrozen: false }));
    expect(keys(rows)).toEqual(want);
  });

  it("frozen pool: the key comes from the frozen column", async () => {
    const rows = await withTenant(T, (c) => listPoolWithCategory(c, { assessmentId: asm, packId: pack, levelId: level, useFrozen: true }));
    expect(keys(rows)).toEqual(want);
  });

  it("pre-flight counts distinct keys plus keyless (3 here), same as the draw", async () => {
    const run = (n: number) => withTenant(T, (c) => assertSectionPoolsFillable(c, pack, level, { sections: [{ name: "S", question_count: n, minutes: 5 }] }));
    await expect(run(3)).resolves.toBeUndefined();
    await expect(run(4)).rejects.toMatchObject({ details: { available: 3, required: 4 } });
  });
});
