/**
 * Z-111 call-site proof (testcontainers Postgres). getCandidateFeedback (feedback.ts) and the
 * released branch of getCandidateResult (result.ts) must pass the attempt's and the
 * assessment's delivery_mode into effectiveLevel. A mock attempt on a mock assessment raises
 * the tenant level to with_expected_answer; every other case keeps the tenant level.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { getCandidateFeedback } from "../feedback.js";
import { getCandidateResult } from "../result.js";

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
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_elcs" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_elcs`;

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
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'t-elcs','Acme University')`, [tenant]);
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

interface Seeded { attemptId: string; userId: string; assessmentId: string }

/** A released attempt with a score row. `assessmentRow: false` deletes the assessment row (FK off, seed only). */
async function seed(opts: { attemptMode: "real" | "mock"; assessmentMode?: "real" | "mock"; assessmentRow?: boolean }): Promise<Seeded> {
  const pack = randomUUID(); const level = randomUUID(); const assessmentId = randomUUID();
  const userId = randomUUID(); const attemptId = randomUUID();
  await sup(async (c) => {
    await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,$3,'P','soc','published',$4)`, [pack, tenant, `p-${randomUUID().slice(0, 8)}`, admin]);
    await c.query(`INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,1,60)`, [level, pack]);
    await c.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, created_by, delivery_mode) VALUES ($1,$2,$3,$4,1,'SOC Analyst L1','active',4,$5,$6)`,
      [assessmentId, tenant, pack, level, admin, opts.assessmentMode ?? "real"],
    );
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Riya','candidate','active')`, [userId, tenant, `r-${userId.slice(0, 6)}@x.test`]);
    await c.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, ends_at, submitted_at, duration_seconds, delivery_mode) VALUES ($1,$2,$3,$4,'released', now() - interval '20 minutes', now() + interval '40 minutes', now(), 3600, $5)`,
      [attemptId, tenant, assessmentId, userId, opts.attemptMode],
    );
    await c.query(`INSERT INTO attempt_scores (attempt_id, tenant_id, total_earned, total_max, auto_pct, pending_review, pass_mark_pct) VALUES ($1,$2,21,40,52.5,false,60)`, [attemptId, tenant]);
    if (opts.assessmentRow === false) {
      // attempts.assessment_id has a foreign key; switch triggers off for this one delete.
      await c.query(`SET session_replication_role = replica`);
      await c.query(`DELETE FROM assessments WHERE id = $1`, [assessmentId]);
      await c.query(`SET session_replication_role = origin`);
    }
  });
  return { attemptId, userId, assessmentId };
}

async function setLevel(level: string): Promise<void> {
  await sup((c) => c.query(`UPDATE tenant_settings SET result_feedback_level = $2 WHERE tenant_id = $1`, [tenant, level]));
}

describe.each([
  ["getCandidateFeedback", async (s: Seeded) => (await getCandidateFeedback(tenant, s.userId, s.attemptId)).level],
  ["getCandidateResult", async (s: Seeded) => {
    const view = await getCandidateResult(tenant, s.userId, s.attemptId);
    if (view.status !== "released") throw new Error(`expected released, got ${view.status}`);
    return view.feedback_level;
  }],
])("Z-111 call sites: %s", (_name, levelOf) => {
  it("mock attempt on a mock assessment with tenant none shows expected answers", async () => {
    await setLevel("none");
    const s = await seed({ attemptMode: "mock", assessmentMode: "mock" });
    expect(await levelOf(s)).toBe("with_expected_answer");
  });

  it("real attempt on a real assessment keeps the tenant level", async () => {
    await setLevel("right_wrong");
    const s = await seed({ attemptMode: "real", assessmentMode: "real" });
    expect(await levelOf(s)).toBe("right_wrong");
  });

  it("mock attempt on a real assessment keeps the tenant level", async () => {
    await setLevel("none");
    const s = await seed({ attemptMode: "mock", assessmentMode: "real" });
    expect(await levelOf(s)).toBe("none");
  });
});

describe("Z-111 call sites: missing assessment row", () => {
  it("getCandidateFeedback keeps the tenant level when the assessment row is missing", async () => {
    await setLevel("none");
    const s = await seed({ attemptMode: "mock", assessmentRow: false });
    expect((await getCandidateFeedback(tenant, s.userId, s.attemptId)).level).toBe("none");
  });
});
