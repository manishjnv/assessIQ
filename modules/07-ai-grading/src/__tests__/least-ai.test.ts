/**
 * SP5 least-AI tiers 1-2 (testcontainers): blank -> rule band 0, identical accepted
 * answer -> reuse; both are proposals only and never reach the runtime.
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

import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { handleAdminGrade } from "../handlers/admin-grade.js";
import { handleAdminAccept } from "../handlers/admin-accept.js";

let container: StartedTestContainer;
let url: string;
const infra: Record<string, { pack: string; level: string; assessment: string; admin: string }> = {};
let tA: string;
let tB: string;
let q1: string;
let q2: string;

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
const aiProposal = (a: { attempt_id: string; question_id: string }, band = 3, score = 7.5) => ({
  attempt_id: a.attempt_id,
  question_id: a.question_id,
  anchors: [],
  band: { reasoning_band: band, ai_justification: "ok", error_class: null, needs_escalation: false },
  score_earned: score,
  score_max: 10,
  prompt_version_sha: SHA,
  prompt_version_label: "v1;v1;-",
  model: "test-model",
  escalation_chosen_stage: "2" as const,
  generated_at: new Date().toISOString(),
});
const fresh = () => new Date(Date.now() - 5_000);
const grade = (tenant: string, attemptId: string) =>
  handleAdminGrade({ tenantId: tenant, userId: infra[tenant]!.admin, attemptId, sessionLastActivity: fresh() });

/** An attempt that already has an accepted AI grade on `q` (band 3 / 7.5). */
async function gradedAttempt(answer: unknown, tenant = tA, qid = q1): Promise<string> {
  const id = await mkAttempt(tenant, "submitted", [[qid, answer]]);
  await handleAdminAccept({ tenantId: tenant, userId: infra[tenant]!.admin, attemptId: id, proposals: [aiProposal({ attempt_id: id, question_id: qid })] });
  return id;
}

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_least_ai" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_least_ai`;
  await sup(async (c) => {
    await c.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await applyAllMigrations(c);
    await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await c.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
  });
  await setPoolForTesting(url);
  tA = await mkTenant("least-a");
  tB = await mkTenant("least-b");
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

beforeEach(async () => {
  gradeSubjectiveMock.mockReset();
  gradeSubjectiveMock.mockImplementation(async (a: { attempt_id: string; question_id: string }) => aiProposal(a, 2, 5));
  // each test gets its own questions so earlier accepted grades never leak in
  q1 = await mkQuestion(1);
  q2 = await mkQuestion(1);
});

describe("tier 1 - rule", () => {
  it("blank / whitespace / tiny answers -> band 0 rule proposal, runtime never called", async () => {
    const id = await mkAttempt(tA, "submitted", [[q1, { response: "   \n " }], [q2, { response: "ab" }]]);
    const out = await grade(tA, id);
    expect(gradeSubjectiveMock).not.toHaveBeenCalled();
    expect(out.proposals).toHaveLength(2);
    for (const p of out.proposals) {
      expect(p).toMatchObject({ source: "rule", score_earned: 0, score_max: 10, model: "rule" });
      expect(p.band).toMatchObject({ reasoning_band: 0, ai_justification: "No answer given" });
    }
    // proposals only: nothing committed
    expect(await sup((c) => c.query(`SELECT COUNT(*)::int n FROM gradings WHERE attempt_id=$1`, [id]).then((r) => r.rows[0].n))).toBe(0);
  });
});

describe("tier 2 - reuse", () => {
  it("identical answer (whitespace/case-insensitive) reuses the accepted band, runtime never called", async () => {
    const src = await gradedAttempt({ response: "The  attacker used PsExec" });
    const id = await mkAttempt(tA, "submitted", [[q1, { response: "  the attacker used psexec " }]]);
    const out = await grade(tA, id);
    expect(gradeSubjectiveMock).not.toHaveBeenCalled();
    const srcGrading = await sup((c) => c.query(`SELECT id FROM gradings WHERE attempt_id=$1`, [src]).then((r) => r.rows[0].id as string));
    expect(out.proposals[0]).toMatchObject({ source: "reuse", reused_from_grading_id: srcGrading, score_earned: 7.5, model: "reuse" });
    expect(out.proposals[0]!.band).toMatchObject({ reasoning_band: 3, ai_justification: "Same answer as an earlier accepted grade" });
    // reuse is still only a proposal; accept writes the row (D8)
    expect(await sup((c) => c.query(`SELECT COUNT(*)::int n FROM gradings WHERE attempt_id=$1`, [id]).then((r) => r.rows[0].n))).toBe(0);
    await handleAdminAccept({ tenantId: tA, userId: infra[tA]!.admin, attemptId: id, proposals: out.proposals });
    expect(await sup((c) => c.query(`SELECT COUNT(*)::int n FROM gradings WHERE attempt_id=$1`, [id]).then((r) => r.rows[0].n))).toBe(1);
  });

  it("no reuse across tenants (RLS)", async () => {
    // tenant B graded the very same question id + answer
    await gradedAttempt({ response: "same text" }, tB);
    const id = await mkAttempt(tA, "submitted", [[q1, { response: "same text" }]]);
    const out = await grade(tA, id);
    expect(gradeSubjectiveMock).toHaveBeenCalledTimes(1);
    expect(out.proposals[0]!.source).toBeUndefined();
  });

  it("no reuse from a review_needed grade", async () => {
    const src = await mkAttempt(tA, "submitted", [[q1, { response: "flagged answer" }]]);
    await handleAdminAccept({
      tenantId: tA, userId: infra[tA]!.admin, attemptId: src,
      proposals: [{ ...aiProposal({ attempt_id: src, question_id: q1 }), band: { reasoning_band: 0, ai_justification: "", error_class: "AIG_RUNTIME_FAILURE" } }],
    });
    const id = await mkAttempt(tA, "submitted", [[q1, { response: "flagged answer" }]]);
    await grade(tA, id);
    expect(gradeSubjectiveMock).toHaveBeenCalledTimes(1);
  });

  it("no reuse once the source grade was overridden later", async () => {
    const src = await gradedAttempt({ response: "overridden answer" });
    await sup(async (c) => {
      const g = (await c.query(`SELECT * FROM gradings WHERE attempt_id=$1`, [src])).rows[0];
      await c.query(
        `INSERT INTO gradings (tenant_id, attempt_id, question_id, grader, score_earned, score_max, status, prompt_version_sha, prompt_version_label, model, override_of, override_reason, graded_at)
         VALUES ($1,$2,$3,'admin_override',2.5,10,'overridden','override','override','none',$4,'why', now() + interval '1 second')`,
        [g.tenant_id, src, q1, g.id],
      );
    });
    const id = await mkAttempt(tA, "submitted", [[q1, { response: "overridden answer" }]]);
    await grade(tA, id);
    expect(gradeSubjectiveMock).toHaveBeenCalledTimes(1);
  });

  it("no reuse across question versions", async () => {
    await gradedAttempt({ response: "versioned answer" });
    await sup((c) => c.query(`INSERT INTO question_versions (question_id, version, content, saved_by) VALUES ($1,2,'{"question":"q"}'::jsonb,$2)`, [q1, infra[tA]!.admin]));
    const id = await mkAttempt(tA, "submitted", [[q1, { response: "versioned answer" }]], 2);
    await grade(tA, id);
    expect(gradeSubjectiveMock).toHaveBeenCalledTimes(1);
  });

  it("no reuse when the source was graded under a different prompt version", async () => {
    const src = await mkAttempt(tA, "submitted", [[q1, { response: "old prompt answer" }]]);
    await handleAdminAccept({
      tenantId: tA, userId: infra[tA]!.admin, attemptId: src,
      proposals: [{ ...aiProposal({ attempt_id: src, question_id: q1 }), prompt_version_sha: "anchors:aaaaaaaa;band:cccccccc;escalate:-" }],
    });
    const id = await mkAttempt(tA, "submitted", [[q1, { response: "old prompt answer" }]]);
    await grade(tA, id);
    expect(gradeSubjectiveMock).toHaveBeenCalledTimes(1);
  });
});

describe("mixed attempt", () => {
  it("blank -> rule, repeat -> reuse, new -> AI: only the remainder reaches the runtime", async () => {
    const q3 = await mkQuestion(1);
    await gradedAttempt({ response: "known answer here" }, tA, q2);
    const id = await mkAttempt(tA, "submitted", [[q1, { response: "" }], [q2, { response: "Known answer here" }], [q3, { response: "brand new answer" }]]);
    const out = await grade(tA, id);
    expect(gradeSubjectiveMock).toHaveBeenCalledTimes(1);
    expect(gradeSubjectiveMock.mock.calls[0]![0]).toMatchObject({ question_id: q3 });
    const bySource = Object.fromEntries(out.proposals.map((p) => [p.question_id, p.source ?? "ai"]));
    expect(bySource).toEqual({ [q1]: "rule", [q2]: "reuse", [q3]: "ai" });
    // cached for the evaluator UI exactly like AI proposals
    const cached = await sup((c) => c.query(`SELECT ai_proposals FROM attempts WHERE id=$1`, [id]).then((r) => r.rows[0].ai_proposals as unknown[]));
    expect(cached).toHaveLength(3);
  });
});
