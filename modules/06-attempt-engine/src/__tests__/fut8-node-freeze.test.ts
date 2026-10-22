/**
 * FUT-8: platform (shared) questions draw and report by taxonomy node, not by the tenant's
 * domain_id / category_id. Testcontainers (postgres:16-alpine); fixtures are seeded as superuser.
 * (a) a frozen pool with no node data behaves as before, (b) the node draw returns platform
 * questions for a tenant whose domain/category ids differ, (c) the results export keeps all rows.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool, withTenant } from "@assessiq/tenancy";
import { listFrozenPoolForCriterion, listQuestionIdsUnderNode } from "../repository.js";

vi.mock("@assessiq/audit-log", () => ({ audit: vi.fn(async () => undefined) }));
import { buildAssessmentResultsCsv } from "../../../15-analytics/src/results-export.js";

let container: StartedTestContainer;
let url: string;
const T = randomUUID(); // licensed tenant
const P = randomUUID(); // platform tenant
const admin = randomUUID();
const cand = randomUUID();
const nodeId = randomUUID();
const fw = randomUUID();
const domP = randomUUID();
const catP = randomUUID();
const q1 = randomUUID();
const q2 = randomUUID();
const asNew = randomUUID(); // frozen with node_ids
const asOld = randomUUID(); // frozen before FUT-8: node_ids = '{}'

async function sup<R>(fn: (c: Client) => Promise<R>): Promise<R> {
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
  await sup(async (c) => {
    await applyAllMigrations(c);
    await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await c.query(`INSERT INTO tenants (id,name,slug) VALUES ($1,'T','t-fut8'),($2,'P','p-fut8')`, [T, P]);
    await c.query(`INSERT INTO users (id,tenant_id,email,name,role,status) VALUES ($1,$3,'a@t.test','Admin','admin','active'),($2,$3,'c@t.test','Cand','candidate','active')`, [admin, cand, T]);
    const pack = randomUUID(); const level = randomUUID();
    await c.query(`INSERT INTO question_packs (id,tenant_id,slug,name,domain,status,created_by) VALUES ($1,$2,'pp','PP','aptitude','published',$3)`, [pack, P, admin]);
    await c.query(`INSERT INTO levels (id,pack_id,position,label,duration_minutes,default_question_count) VALUES ($1,$2,1,'L1',60,2)`, [level, pack]);
    await c.query(`INSERT INTO domains (id,tenant_id,slug,name) VALUES ($1,$2,'d','D')`, [domP, P]);
    await c.query(`INSERT INTO categories (id,tenant_id,domain_id,slug,name) VALUES ($1,$2,$3,'c','PlatformCat')`, [catP, P, domP]);
    await c.query(`INSERT INTO frameworks (id,tenant_id,slug,name) VALUES ($1,NULL,'fut8-f','F')`, [fw]);
    await c.query(`INSERT INTO taxonomy_nodes (id,tenant_id,framework_id,kind,code,label) VALUES ($1,NULL,$2,'subject','alg','Algebra')`, [nodeId, fw]);
    for (const q of [q1, q2]) {
      await c.query(
        `INSERT INTO questions (id,pack_id,level_id,type,topic,points,status,content,created_by,domain_id,category_id)
         VALUES ($1,$2,$3,'mcq','t',10,'active','{"question":"Q","options":["A","B"],"correct":0}',$4,$5,$6)`,
        [q, pack, level, admin, domP, catP]);
      await c.query(`INSERT INTO question_taxonomy (question_id,node_id) VALUES ($1,$2)`, [q, nodeId]);
    }
    for (const [a, nodes] of [[asNew, `{${nodeId}}`], [asOld, "{}"]] as const) {
      await c.query(`INSERT INTO assessments (id,tenant_id,pack_id,level_id,name,status,pack_version,question_count,created_by) VALUES ($1,$2,$3,$4,'A','active',1,2,$5)`, [a, T, pack, level, admin]);
      for (const q of [q1, q2]) {
        await c.query(
          `INSERT INTO assessment_frozen_pool (tenant_id,assessment_id,question_id,question_version,level_id,domain_id,category_id,type,points,node_ids)
           VALUES ($1,$2,$3,1,$4,$5,$6,'mcq',10,$7::uuid[])`, [T, a, q, level, domP, catP, nodes]);
      }
    }
    // One graded attempt on the new assessment; the questions belong to the platform tenant.
    await c.query(`INSERT INTO assessment_invitations (assessment_id,user_id,token_hash,expires_at,status,invited_by) VALUES ($1,$2,$3,now()+interval '7 day','submitted',$4)`, [asNew, cand, randomUUID(), admin]);
    const att = randomUUID();
    await c.query(`INSERT INTO attempts (id,tenant_id,assessment_id,user_id,status,started_at,submitted_at,evaluation_released_at) VALUES ($1,$2,$3,$4,'graded',now()-interval '1 hour',now(),now())`, [att, T, asNew, cand]);
    let pos = 1;
    for (const q of [q1, q2]) {
      await c.query(`INSERT INTO attempt_questions (attempt_id,question_id,position,question_version) VALUES ($1,$2,$3,1)`, [att, q, pos++]);
      await c.query(
        `INSERT INTO gradings (attempt_id,question_id,tenant_id,grader,score_earned,score_max,status,prompt_version_sha,prompt_version_label,model,graded_at)
         VALUES ($1,$2,$3,'deterministic',10,10,'correct','sha','v1','m',now())`, [att, q, T]);
    }
  });
  await setPoolForTesting(url);
}, 180_000);

afterAll(async () => {
  await closePool();
  await container?.stop();
});

describe("FUT-8 taxonomy by node", () => {
  it("(a) a frozen pool without node ids still draws by domain and category", async () => {
    const rows = await withTenant(T, (c) => listFrozenPoolForCriterion(c, asOld, domP, catP, "mcq"));
    expect(rows.map((r) => r.id).sort()).toEqual([q1, q2].sort());
    // no node data: the node draw gives what the live link gives (nothing readable for T), no error
    const none = await withTenant(T, (c) => listFrozenPoolForCriterion(c, asOld, domP, undefined, "mcq", { nodeId }));
    expect(none).toEqual([]);
  });

  it("(b) the node draw returns platform questions for a tenant with other domain and category ids", async () => {
    const rows = await withTenant(T, (c) => listFrozenPoolForCriterion(c, asNew, randomUUID(), randomUUID(), "mcq", { nodeId }));
    expect(rows.map((r) => r.id).sort()).toEqual([q1, q2].sort());
    const set = await withTenant(T, (c) => listQuestionIdsUnderNode(c, nodeId, asNew));
    expect([...set].sort()).toEqual([q1, q2].sort());
  });

  it("(c) the results export groups by node and keeps every row", async () => {
    const csv = await buildAssessmentResultsCsv(T, asNew);
    const lines = csv.csv.replace(/^﻿/, "").trim().split("\n");
    expect(lines[0]).toContain("Algebra (%)");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("100");
  });
});
