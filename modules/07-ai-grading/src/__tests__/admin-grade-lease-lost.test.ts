/**
 * RW-95: handleAdminGrade / handleAdminRerun pass the single-flight lease signal
 * into the runtime and fail the run with AIG_LEASE_LOST when the lease is lost.
 * runtime-selector is mocked; no claude is called. The control (no-abort) success
 * path is already covered by mcq-admin-grade.test.ts (mixed attempt).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execSync } from "node:child_process";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { AppError } from "@assessiq/core";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";

const gradeSubjectiveMock = vi.fn();
vi.mock("../runtime-selector.js", () => ({
  gradeSubjective: (...a: unknown[]) => gradeSubjectiveMock(...a),
}));

import { startTestRedis, stopTestRedis } from "./redis-testing.js";
import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { handleAdminGrade } from "../handlers/admin-grade.js";
import { handleAdminRerun } from "../handlers/admin-rerun.js";
import { singleFlight } from "../single-flight.js";
import { AI_GRADING_ERROR_CODES } from "../types.js";

function isDockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}
const dockerAvailable = isDockerAvailable();

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
  if (!dockerAvailable) return;
  await startTestRedis();
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_aig_lease" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_aig_lease`;
  await sup(async (c) => {
    await c.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await applyAllMigrations(c);
    await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await c.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
  });
  await setPoolForTesting(url);
  tenant = randomUUID();
  admin = randomUUID();
  await sup(async (c) => {
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'t-aig-lease','T')`, [tenant]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tenant]);
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@aiglease.test','A','admin','active')`,
      [admin, tenant],
    );
  });
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  if (!dockerAvailable) return;
  await stopTestRedis();
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

/** One submitted attempt with one subjective question and a non-blank answer. */
async function seed(): Promise<string> {
  const pack = randomUUID();
  const level = randomUUID();
  const assessment = randomUUID();
  const cand = randomUUID();
  const attemptId = randomUUID();
  const qid = randomUUID();
  const content = JSON.stringify({ question: "q" });
  await sup(async (c) => {
    await c.query(
      `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,$3,'P','soc','published',$4)`,
      [pack, tenant, `p-${randomUUID().slice(0, 8)}`, admin],
    );
    await c.query(
      `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,1,60)`,
      [level, pack],
    );
    await c.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, created_by) VALUES ($1,$2,$3,$4,1,'A','active',1,$5)`,
      [assessment, tenant, pack, level, admin],
    );
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'C','candidate','active')`,
      [cand, tenant, `c-${randomUUID().slice(0, 6)}@aiglease.test`],
    );
    await c.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, duration_seconds)
       VALUES ($1,$2,$3,$4,'submitted', now() - interval '30 minutes', now(), 3600)`,
      [attemptId, tenant, assessment, cand],
    );
    await c.query(
      `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, version, created_by) VALUES ($1,$2,$3,'subjective','t',10,'active',$4::jsonb,1,$5)`,
      [qid, pack, level, content, admin],
    );
    await c.query(`INSERT INTO question_versions (question_id, version, content, saved_by) VALUES ($1,1,$2::jsonb,$3)`, [qid, content, admin]);
    await c.query(`INSERT INTO attempt_questions (attempt_id, question_id, position, question_version) VALUES ($1,$2,1,1)`, [attemptId, qid]);
    await c.query(`INSERT INTO attempt_answers (attempt_id, question_id, answer) VALUES ($1,$2,$3::jsonb)`, [
      attemptId,
      qid,
      JSON.stringify({ response: "text" }),
    ]);
  });
  return attemptId;
}

const proposals = (id: string) =>
  sup((c) => c.query(`SELECT ai_proposals FROM attempts WHERE id=$1`, [id]).then((r) => r.rows[0].ai_proposals as unknown));

function leaseLostRun(): AbortController {
  const ctrl = new AbortController();
  vi.spyOn(singleFlight, "acquire").mockResolvedValue({
    kind: "acquired",
    release: async () => undefined,
    signal: ctrl.signal,
  });
  gradeSubjectiveMock.mockReset();
  gradeSubjectiveMock.mockImplementation(async (input: { signal?: AbortSignal }) => {
    expect(input.signal).toBe(ctrl.signal);
    ctrl.abort();
    throw new AppError("aborted", AI_GRADING_ERROR_CODES.LEASE_LOST, 503);
  });
  return ctrl;
}

describe("RW-95 lease lost mid-run", () => {
  it.skipIf(!dockerAvailable)("handleAdminGrade rejects with AIG_LEASE_LOST and writes no proposals", async () => {
    const attemptId = await seed();
    leaseLostRun();
    await expect(
      handleAdminGrade({ tenantId: tenant, userId: admin, attemptId, sessionLastActivity: new Date() }),
    ).rejects.toMatchObject({ code: "AIG_LEASE_LOST" });
    expect(gradeSubjectiveMock).toHaveBeenCalledTimes(1);
    expect(await proposals(attemptId)).toBeNull();
  });

  it.skipIf(!dockerAvailable)("handleAdminRerun rejects with AIG_LEASE_LOST and writes no proposals", async () => {
    const attemptId = await seed();
    leaseLostRun();
    await expect(
      handleAdminRerun({ tenantId: tenant, userId: admin, attemptId, sessionLastActivity: new Date() }),
    ).rejects.toMatchObject({ code: "AIG_LEASE_LOST" });
    expect(gradeSubjectiveMock).toHaveBeenCalledTimes(1);
    expect(await proposals(attemptId)).toBeNull();
  });
});
