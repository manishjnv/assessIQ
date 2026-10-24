/**
 * RW-84 — getCandidateProgress (testcontainers Postgres). Released attempts only:
 * history, score trend, per-subject strengths. Harness copied from candidate-result.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { getCandidateProgress } from "../progress.js";

const THIS_DIR = dirname(fileURLToPath(import.meta.url)) + sep;
const MODULES_ROOT = join(THIS_DIR, "..", "..", "..");
const DIRS: Array<[string, string[] | undefined]> = [
  ["02-tenancy", undefined],
  ["03-users", ["020_users.sql"]],
  ["14-audit-log", undefined],
  ["04-question-bank", undefined],
  ["05-assessment-lifecycle", undefined],
  ["06-attempt-engine", undefined],
  ["12-embed-sdk", ["0073_attempt_embed_origin.sql"]],
  ["07-ai-grading", ["0040_gradings.sql", "0041_tenant_grading_budgets.sql", "0100_attempts_ai_proposals_cache.sql", "0168_gradings_cli_version_stage_inputs.sql", "0258_gradings_ai_cost.sql"]],
  ["09-scoring", undefined],
  ["13-notifications", undefined],
  ["18-certification", undefined],
  ["19-billing", undefined],
];

let container: StartedTestContainer;
let url: string;
let tenant: string;
let admin: string;

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_prog" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_prog`;

  await sup(async (c) => {
    await c.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    for (const r of ["assessiq_app", "assessiq_system"]) {
      const bypass = r === "assessiq_system" ? " BYPASSRLS" : "";
      await c.query(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN CREATE ROLE ${r}${bypass}; END IF; END $$;`,
      );
      await c.query(`GRANT ${r} TO test`);
    }
    for (const [mod, only] of DIRS) {
      const dir = join(MODULES_ROOT, mod, "migrations");
      const files = (await readdir(dir))
        .filter((f) => f.endsWith(".sql") && (only === undefined || only.includes(f)))
        .sort();
      for (const f of files) await c.query(await readFile(join(dir, f), "utf-8"));
    }
    await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await c.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
  });
  await setPoolForTesting(url);

  tenant = randomUUID();
  admin = randomUUID();
  await sup(async (c) => {
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'t-prog','Acme University')`, [tenant]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [tenant]);
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@x.test','Admin','admin','active')`,
      [admin, tenant],
    );
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

describe("getCandidateProgress", () => {
  it("covers released attempts only: history, trend, subject strengths, certificate", async () => {
    const pack = randomUUID();
    const level = randomUUID();
    const [asm, asm2, asm3] = [randomUUID(), randomUUID(), randomUUID()];
    const user = randomUUID();
    const other = randomUUID();
    const fw = randomUUID();
    const algebra = randomUUID();
    const geometry = randomUUID();
    const unit = randomUUID();
    const [q1, q2, q3] = [randomUUID(), randomUUID(), randomUUID()];
    const [a1, a2, a3] = [randomUUID(), randomUUID(), randomUUID()];

    await sup(async (c) => {
      await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,'p-prog','P','soc','published',$3)`, [pack, tenant, admin]);
      await c.query(`INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,1,60)`, [level, pack]);
      // one attempt per (assessment, user): three assessments
      for (const [id, name] of [[asm, "Maths Test 1"], [asm2, "Maths Test 2"], [asm3, "Maths Test 3"]] as const) {
        await c.query(`INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, created_by) VALUES ($1,$2,$3,$4,1,$6,'active',3,$5)`, [id, tenant, pack, level, admin, name]);
      }
      for (const [id, email] of [[user, "u@x.test"], [other, "o@x.test"]] as const) {
        await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Cand','candidate','active')`, [id, tenant, email]);
      }
      for (const id of [q1, q2, q3]) {
        await c.query(`INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, version, created_by) VALUES ($1,$2,$3,'mcq','t',10,'active','{}'::jsonb,1,$4)`, [id, pack, level, admin]);
      }
      // taxonomy: q1 -> Algebra (subject), q2 -> unit under Geometry, q3 -> none (Other).
      await c.query(`INSERT INTO frameworks (id, tenant_id, slug, name, source) VALUES ($1,$2,'fw','FW','tenant')`, [fw, tenant]);
      await c.query(
        `INSERT INTO taxonomy_nodes (id, tenant_id, framework_id, parent_id, kind, code, label)
         VALUES ($1,$4,$5,NULL,'subject','alg','Algebra'),($2,$4,$5,NULL,'subject','geo','Geometry'),($3,$4,$5,$2,'unit','tri','Triangles')`,
        [algebra, geometry, unit, tenant, fw],
      );
      await c.query(`INSERT INTO question_taxonomy (question_id, node_id) VALUES ($1,$2),($3,$4)`, [q1, algebra, q2, unit]);

      const att = async (id: string, aid: string, uid: string, status: string, earned: number, max: number, releasedAt: string | null) => {
        await c.query(
          `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, ends_at, submitted_at, duration_seconds)
           VALUES ($1,$2,$3,$4,$5, now() - interval '20 minutes', now() + interval '40 minutes', now(), 3600)`,
          [id, tenant, aid, uid, status],
        );
        await c.query(`INSERT INTO attempt_scores (attempt_id, tenant_id, total_earned, total_max, auto_pct, pending_review) VALUES ($1,$2,$3,$4,$5,false)`, [id, tenant, earned, max, (earned / max) * 100]);
        if (releasedAt !== null) {
          await c.query(`INSERT INTO audit_log (tenant_id, actor_kind, action, entity_type, entity_id, after, at) VALUES ($1,'system','grading.released','attempt',$2,'{}'::jsonb,$3)`, [tenant, id, releasedAt]);
        }
      };
      await att(a1, asm, user, "released", 10, 20, "2026-10-01T09:00:00Z");
      await att(a2, asm2, user, "released", 30, 30, "2026-10-05T09:00:00Z");
      await att(a3, asm3, user, "graded", 0, 30, null); // graded, NOT released
      await c.query(
        `INSERT INTO certificates (tenant_id, attempt_id, candidate_id, template_key, credential_id, tier, display_name, course_title, level, signed_hash)
         VALUES ($1,$2,$3,'standard','CERT-PROG-1','completion','Cand','Maths Test','L1','sig')`,
        [tenant, a2, user],
      );
      const g = (at: string, qid: string, status: string, earned: number) =>
        c.query(
          `INSERT INTO gradings (id, attempt_id, question_id, tenant_id, grader, score_earned, score_max, status, prompt_version_sha, prompt_version_label, model)
           VALUES ($1,$2,$3,$4,'deterministic',$5,10,$6,'sha:test','v1','deterministic')`,
          [randomUUID(), at, qid, tenant, earned, status],
        );
      await g(a1, q1, "correct", 10);
      await g(a1, q2, "incorrect", 0);
      await g(a2, q1, "correct", 10);
      await g(a2, q2, "correct", 10);
      await g(a2, q3, "correct", 10);
      await g(a3, q1, "incorrect", 0); // unreleased: must not count
      await g(a3, q3, "incorrect", 0);
      await g(a3, q2, "review_needed", 0);
    });

    const p = await getCandidateProgress(tenant, user);
    expect(p.attempts.map((a) => a.attempt_id)).toEqual([a2, a1]); // newest first, a3 absent
    expect(p.attempts[0]).toMatchObject({ score_pct: 100, passed: true, passing_score_pct: 60 });
    expect(p.attempts[0]!.certificate?.credential_id).toBe("CERT-PROG-1");
    expect(p.attempts[0]!.certificate?.verify_url).toContain("/verify/CERT-PROG-1");
    expect(p.attempts[1]).toMatchObject({ score_pct: 50, passed: false, certificate: null });
    expect(p.trend).toEqual([50, 100]); // oldest -> newest
    expect(p.subjects).toEqual([
      { node_id: geometry, label: "Geometry", questions: 2, correct: 1, rate_pct: 50 },
      { node_id: algebra, label: "Algebra", questions: 2, correct: 2, rate_pct: 100 },
      { node_id: "other", label: "Other", questions: 1, correct: 1, rate_pct: 100 },
    ]);

    // another candidate sees nothing of it
    expect(await getCandidateProgress(tenant, other)).toEqual({ attempts: [], trend: [], subjects: [] });
  });
});
