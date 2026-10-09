/**
 * RW-7 (testcontainers): a tenant AI pause that lands during the AI call discards the
 * proposal (grade + rerun) and Accept is blocked while paused.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { randomUUID } from "node:crypto";

const gradeSubjectiveMock = vi.fn();
vi.mock("../runtime-selector.js", () => ({
  gradeSubjective: (...a: unknown[]) => gradeSubjectiveMock(...a),
}));
vi.mock("../skill-sha.js", () => ({
  skillSha: async (n: string) => ({ short: n === "grade-anchors" ? "aaaaaaaa" : "bbbbbbbb", sha256: "", label: "v1", model: "m" }),
}));

import { startTestRedis, stopTestRedis } from "./redis-testing.js";
import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { handleAdminGrade } from "../handlers/admin-grade.js";
import { handleAdminRerun } from "../handlers/admin-rerun.js";
import { singleFlight } from "../single-flight.js";
import { handleAdminAccept } from "../handlers/admin-accept.js";

let container: StartedTestContainer;
let url: string;
const infra: Record<string, { pack: string; level: string; assessment: string; admin: string }> = {};
let tA: string;
let q1: string;

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function mkTenant(slug: string): Promise<string> {
  const t = randomUUID();
  const i = { pack: randomUUID(), level: randomUUID(), assessment: randomUUID(), admin: randomUUID() };
  infra[t] = i;
  await sup(async (c) => {
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,'T')`, [t, slug]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [t]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'A','admin','active')`, [i.admin, t, `a@${slug}.test`]);
    await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,'p','P','soc','published',$3)`, [i.pack, t, i.admin]);
    await c.query(`INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,1,60)`, [i.level, i.pack]);
    await c.query(`INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, created_by) VALUES ($1,$2,$3,$4,1,'A','active',2,$5)`, [i.assessment, t, i.pack, i.level, i.admin]);
  });
  return t;
}

/** Subjective question (10 pts) in tenant A's pack. */
async function mkQuestion(version: number): Promise<string> {
  const qid = randomUUID();
  const content = JSON.stringify({ question: "q" });
  await sup(async (c) => {
    await c.query(`INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, version, created_by) VALUES ($1,$2,$3,'subjective','t',10,'active',$4::jsonb,$5,$6)`, [qid, infra[tA]!.pack, infra[tA]!.level, content, version, infra[tA]!.admin]);
    for (let v = 1; v <= version; v++) await c.query(`INSERT INTO question_versions (question_id, version, content, saved_by) VALUES ($1,$2,$3::jsonb,$4)`, [qid, v, content, infra[tA]!.admin]);
  });
  return qid;
}

async function mkAttempt(
  tenant: string,
  status: string,
  answers: Array<[string, unknown]>,
  version = 1,
): Promise<string> {
  const id = randomUUID();
  const cand = randomUUID();
  const i = infra[tenant]!;
  await sup(async (c) => {
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'C','candidate','active')`, [cand, tenant, `c-${cand.slice(0, 8)}@x.test`]);
    await c.query(`INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, duration_seconds) VALUES ($1,$2,$3,$4,$5, now() - interval '30 minutes', now(), 3600)`, [id, tenant, i.assessment, cand, status]);
    let pos = 1;
    for (const [qid, ans] of answers) {
      await c.query(`INSERT INTO attempt_questions (attempt_id, question_id, position, question_version) VALUES ($1,$2,$3,$4)`, [id, qid, pos++, version]);
      await c.query(`INSERT INTO attempt_answers (attempt_id, question_id, answer) VALUES ($1,$2,$3::jsonb)`, [id, qid, JSON.stringify(ans)]);
    }
  });
  return id;
}

const SHA = "anchors:aaaaaaaa;band:bbbbbbbb;escalate:-";
const aiProposal = (a: { attempt_id: string; question_id: string }) => ({
  attempt_id: a.attempt_id,
  question_id: a.question_id,
  anchors: [],
  band: { reasoning_band: 2, ai_justification: "ok", error_class: null, needs_escalation: false },
  score_earned: 5,
  score_max: 10,
  prompt_version_sha: SHA,
  prompt_version_label: "v1;v1;-",
  model: "test-model",
  escalation_chosen_stage: "2" as const,
  generated_at: new Date().toISOString(),
});
const fresh = () => new Date(Date.now() - 5_000);
const setPause = (paused: boolean) =>
  sup((c) => c.query(`UPDATE tenant_settings SET ai_grading_enabled = $2 WHERE tenant_id = $1`, [tA, !paused]));
const proposalsOf = (id: string) =>
  sup((c) => c.query(`SELECT ai_proposals FROM attempts WHERE id=$1`, [id]).then((r) => r.rows[0].ai_proposals as unknown));
const gradingCount = (id: string) =>
  sup((c) => c.query(`SELECT COUNT(*)::int n FROM gradings WHERE attempt_id=$1`, [id]).then((r) => r.rows[0].n as number));

/** The lock is free again iff a different key can take it. */
async function expectLockReleased(): Promise<void> {
  const probe = await singleFlight.acquire(randomUUID());
  expect(probe.kind).toBe("acquired");
  if (probe.kind === "acquired") await probe.release();
}

beforeAll(async () => {
  await startTestRedis();
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_rw7" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_rw7`;
  await sup(async (c) => {
    await c.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await applyAllMigrations(c);
    await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await c.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
  });
  await setPoolForTesting(url);
  tA = await mkTenant("rw7-a");
}, 120_000);

afterAll(async () => {
  await stopTestRedis();
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

beforeEach(async () => {
  gradeSubjectiveMock.mockReset();
  await setPause(false);
  q1 = await mkQuestion(1);
});

/** Runtime that flips the pause flag mid-call, then returns a valid proposal. */
const pauseDuringCall = () =>
  gradeSubjectiveMock.mockImplementation(async (a: { attempt_id: string; question_id: string }) => {
    await setPause(true);
    return aiProposal(a);
  });

describe("RW-7 pause landing during the AI call", () => {
  it("admin-grade: 409 AIG_TENANT_AI_PAUSED, no ai_proposals written, lock released", async () => {
    const id = await mkAttempt(tA, "submitted", [[q1, { response: "a real answer with enough text" }]]);
    pauseDuringCall();
    await expect(
      handleAdminGrade({ tenantId: tA, userId: infra[tA]!.admin, attemptId: id, sessionLastActivity: fresh() }),
    ).rejects.toMatchObject({ code: "AIG_TENANT_AI_PAUSED", status: 409 });
    expect(gradeSubjectiveMock).toHaveBeenCalledTimes(1);
    expect(await proposalsOf(id)).toBeNull();
    await expectLockReleased();
  });

  it("admin-rerun: 409 AIG_TENANT_AI_PAUSED, no ai_proposals written, lock released", async () => {
    // graded attempt -> re-evaluation path writes ai_proposals
    const id = await mkAttempt(tA, "graded", [[q1, { response: "a real answer with enough text" }]]);
    pauseDuringCall();
    await expect(
      handleAdminRerun({ tenantId: tA, userId: infra[tA]!.admin, attemptId: id, sessionLastActivity: fresh() }),
    ).rejects.toMatchObject({ code: "AIG_TENANT_AI_PAUSED", status: 409 });
    expect(gradeSubjectiveMock).toHaveBeenCalledTimes(1);
    expect(await proposalsOf(id)).toBeNull();
    await expectLockReleased();
  });
});

describe("RW-7 accept while paused", () => {
  it("admin-accept: 409 AIG_TENANT_AI_PAUSED and no gradings row; works again after resume", async () => {
    const id = await mkAttempt(tA, "submitted", [[q1, { response: "x" }]]);
    const input = {
      tenantId: tA, userId: infra[tA]!.admin, attemptId: id,
      proposals: [aiProposal({ attempt_id: id, question_id: q1 })],
    };
    await setPause(true);
    await expect(handleAdminAccept(input)).rejects.toMatchObject({ code: "AIG_TENANT_AI_PAUSED", status: 409 });
    expect(await gradingCount(id)).toBe(0);
    await setPause(false);
    await handleAdminAccept(input);
    expect(await gradingCount(id)).toBe(1);
  });
});
