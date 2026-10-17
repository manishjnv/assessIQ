/**
 * RW-80 - per-question feedback for a released result (testcontainers Postgres).
 * The tenant level gates what is present: none, right_wrong, with_expected_answer, with_ai_justification.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { getCandidateFeedback, plainWords } from "../feedback.js";

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
  ["07-ai-grading", ["0040_gradings.sql", "0041_tenant_grading_budgets.sql", "0100_attempts_ai_proposals_cache.sql", "0168_gradings_cli_version_stage_inputs.sql"]],
  ["09-scoring", undefined],
  ["13-notifications", undefined], // POST /submit emits attempt.submitted after commit (reads webhook_endpoints)
  ["18-certification", undefined],
  ["19-billing", undefined],
];

let container: StartedTestContainer;
let url: string;
let tenant: string; // auto tenant (switched on)
let manualTenant: string;
let otherTenant: string;
let admin: string;
let manualAdmin: string;

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
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_cres" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_cres`;

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
  manualTenant = randomUUID();
  otherTenant = randomUUID();
  admin = randomUUID();
  manualAdmin = randomUUID();
  await sup(async (c) => {
    await c.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1,'t-auto','Acme University'),($2,'t-manual','Manual College'),($3,'t-other','Other')`,
      [tenant, manualTenant, otherTenant],
    );
    await c.query(
      `INSERT INTO tenant_settings (tenant_id, result_release_mode, result_release_auto_since) VALUES ($1,'auto', now() - interval '1 hour')`,
      [tenant],
    );
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1),($2)`, [manualTenant, otherTenant]);
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@x.test','Admin','admin','active'),($3,$4,'b@x.test','Admin2','admin','active')`,
      [admin, tenant, manualAdmin, manualTenant],
    );
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);


async function setLevel(level: string): Promise<void> {
  await sup((c) => c.query(`UPDATE tenant_settings SET result_feedback_level = $2 WHERE tenant_id = $1`, [tenant, level]));
}

const JUSTIFICATION = [
  "Stage 2: anchors matched [a1, a2]",
  "Band 2 chosen from the rubric",
  "```json",
  '{"anchor_hits": ["SECRETANCHOR"]}',
  "```",
  "The answer names the key control [anchor:a1]. It misses the logging step. Third sentence must not appear.",
].join("\n");

const EXPLANATION = "Partial answer: The answer names the key control . It misses the logging step.";

interface Seeded { attemptId: string; userId: string; qs: Record<string, string> }

async function seed(status = "released"): Promise<Seeded> {
  const pack = randomUUID(); const level = randomUUID(); const assessmentId = randomUUID();
  const userId = randomUUID(); const attemptId = randomUUID();
  const qs: Record<string, string> = {};
  await sup(async (c) => {
    await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,$3,'P','soc','published',$4)`, [pack, tenant, `p-${randomUUID().slice(0, 8)}`, admin]);
    await c.query(`INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,1,60)`, [level, pack]);
    await c.query(`INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, created_by) VALUES ($1,$2,$3,$4,1,'SOC Analyst L1','active',4,$5)`, [assessmentId, tenant, pack, level, admin]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Riya','candidate','active')`, [userId, tenant, `r-${userId.slice(0, 6)}@x.test`]);
    await c.query(`INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, ends_at, submitted_at, duration_seconds) VALUES ($1,$2,$3,$4,$5, now() - interval '20 minutes', now() + interval '40 minutes', now(), 3600)`, [attemptId, tenant, assessmentId, userId, status]);

    const defs: Array<{ key: string; type: string; content: unknown; answer: unknown; grader: string; status: string; earned: number; band?: number; just?: string }> = [
      { key: "mcq", type: "mcq", content: { question: "Which is private?", options: ["8.8.8.8", "10.0.0.1", "1.1.1.1", "9.9.9.9"], correct: 1, rationale: "SECRETRATIONALE" }, answer: { selected: 1 }, grader: "deterministic", status: "correct", earned: 10 },
      { key: "numeric", type: "numeric", content: { question: "How many hosts?", answer: 42, tolerance: 1, unit: "hosts" }, answer: { value: 7 }, grader: "deterministic", status: "incorrect", earned: 0 },
      { key: "ordering", type: "ordering", content: { question: "Order the steps", items: ["Detect", "Contain", "Recover"], correct_order: [0, 1, 2], scoring: "partial" }, answer: { order: [0, 2, 1] }, grader: "deterministic", status: "partial", earned: 5 },
      { key: "subjective", type: "subjective", content: { question: "Explain defence in depth" }, answer: { response: "Layers of controls." }, grader: "ai", status: "partial", earned: 6, band: 2, just: JUSTIFICATION },
    ];
    let pos = 1;
    for (const d of defs) {
      const qid = randomUUID(); qs[d.key] = qid;
      const content = JSON.stringify(d.content);
      await c.query(`INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, version, created_by) VALUES ($1,$2,$3,$4,'Fallback topic',10,'active',$5::jsonb,1,$6)`, [qid, pack, level, d.type, content, admin]);
      await c.query(`INSERT INTO question_versions (question_id, version, content, saved_by) VALUES ($1,1,$2::jsonb,$3)`, [qid, content, admin]);
      await c.query(`INSERT INTO attempt_questions (attempt_id, question_id, position, question_version) VALUES ($1,$2,$3,1)`, [attemptId, qid, pos++]);
      await c.query(`INSERT INTO attempt_answers (attempt_id, question_id, answer) VALUES ($1,$2,$3::jsonb)`, [attemptId, qid, JSON.stringify(d.answer)]);
      await c.query(
        `INSERT INTO gradings (tenant_id, attempt_id, question_id, grader, score_earned, score_max, status, anchor_hits, reasoning_band, ai_justification, stage_inputs, prompt_version_sha, prompt_version_label, model)
         VALUES ($1,$2,$3,$4,$5,10,$6,$7::jsonb,$8,$9,$10::jsonb,'sha','lbl','m')`,
        [tenant, attemptId, qid, d.grader, d.earned, d.status, d.just ? JSON.stringify(["SECRETANCHOR"]) : null, d.band ?? null, d.just ?? null, d.just ? JSON.stringify({ x: "SECRETSTAGEINPUT" }) : null],
      );
    }
    await c.query(`INSERT INTO attempt_scores (attempt_id, tenant_id, total_earned, total_max, auto_pct, pending_review) VALUES ($1,$2,21,40,52.5,false)`, [attemptId, tenant]);
    // taxonomy: subject "Networking" > unit "Subnetting", linked to the mcq only
    const fw = randomUUID(); const subj = randomUUID(); const unit = randomUUID();
    await c.query(`INSERT INTO frameworks (id, tenant_id, slug, name) VALUES ($1,NULL,$2,'FW')`, [fw, `fw-${fw.slice(0, 8)}`]);
    await c.query(`INSERT INTO taxonomy_nodes (id, tenant_id, framework_id, parent_id, kind, code, label) VALUES ($1,NULL,$2,NULL,'subject','net','Networking')`, [subj, fw]);
    await c.query(`INSERT INTO taxonomy_nodes (id, tenant_id, framework_id, parent_id, kind, code, label) VALUES ($1,NULL,$2,$3,'unit','sub','Subnetting')`, [unit, fw, subj]);
    await c.query(`INSERT INTO question_taxonomy (question_id, node_id) VALUES ($1,$2)`, [qs.mcq, unit]);
  });
  return { attemptId, userId, qs };
}

describe("plainWords", () => {
  it("band label + first two clean sentences; strips markers, brackets, json, code fences", () => {
    expect(plainWords(JUSTIFICATION, 2, null)).toBe(EXPLANATION);
  });
  it("labels per band, band only when nothing is left, capped at 280 chars", () => {
    expect(plainWords("Stage 1: x", 4, null)).toBe("Strong answer");
    expect(plainWords(null, 0, null)).toBe("No credit");
    expect(plainWords("Good work.", 3, "AIG_PARSE")).toBe("Good answer"); // error class: band only
    expect(plainWords(null, null, null)).toBeNull();
    const long = plainWords(`${"word ".repeat(100)}.`, 1, null)!;
    expect(long.length).toBeLessThanOrEqual("Weak answer: ".length + 280);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("getCandidateFeedback", () => {
  type Item = Awaited<ReturnType<typeof getCandidateFeedback>>["items"][number];
  const byKey = (s: Seeded, items: Item[]) =>
    Object.fromEntries(Object.entries(s.qs).map(([k, id]) => [k, items.find((i) => i.question_id === id)!])) as Record<
      "mcq" | "numeric" | "ordering" | "subjective",
      Item
    >;

  it("none -> items []", async () => {
    await setLevel("none");
    const s = await seed();
    expect(await getCandidateFeedback(tenant, s.userId, s.attemptId)).toEqual({ level: "none", items: [] });
  });

  it("right_wrong -> outcome, own answer, study; no expected answer, no explanation", async () => {
    await setLevel("right_wrong");
    const s = await seed();
    const r = await getCandidateFeedback(tenant, s.userId, s.attemptId);
    expect(r.level).toBe("right_wrong");
    expect(r.items.map((i) => i.position)).toEqual([1, 2, 3, 4]);
    const q = byKey(s, r.items);
    expect(q.mcq).toMatchObject({ type: "mcq", prompt: "Which is private?", your_answer: "10.0.0.1", outcome: "correct", score_earned: 10, score_max: 10 });
    expect(q.numeric).toMatchObject({ outcome: "incorrect", your_answer: "7 hosts" });
    expect(q.ordering).toMatchObject({ outcome: "partial", your_answer: "1. Detect; 2. Recover; 3. Contain" });
    expect(q.subjective).toMatchObject({ outcome: "partial", your_answer: "Layers of controls." });
    expect(q.mcq.study).toEqual({ unit: "Subnetting", subject: "Networking", topic: "Fallback topic" });
    expect(q.numeric.study).toEqual({ unit: null, subject: null, topic: "Fallback topic" });
    for (const i of r.items) { expect(i.expected_answer).toBeNull(); expect(i.explanation).toBeNull(); }
  });

  it("with_expected_answer -> expected answer on deterministic types only; still no explanation", async () => {
    await setLevel("with_expected_answer");
    const s = await seed();
    const r = await getCandidateFeedback(tenant, s.userId, s.attemptId);
    const q = byKey(s, r.items);
    expect(q.mcq.expected_answer).toBe("10.0.0.1");
    expect(q.numeric.expected_answer).toBe("42 hosts (± 1)");
    expect(q.ordering.expected_answer).toBe("1. Detect; 2. Contain; 3. Recover");
    expect(q.subjective.expected_answer).toBeNull();
    for (const i of r.items) expect(i.explanation).toBeNull();
  });

  it("with_ai_justification -> explanation only on the AI-graded row, never the stripped marker text", async () => {
    await setLevel("with_ai_justification");
    const s = await seed();
    const r = await getCandidateFeedback(tenant, s.userId, s.attemptId);
    const q = byKey(s, r.items);
    expect(q.subjective.explanation).toBe(EXPLANATION);
    expect(q.mcq.explanation).toBeNull();
    expect(q.numeric.explanation).toBeNull();
    expect(q.mcq.expected_answer).toBe("10.0.0.1");
    const raw = JSON.stringify(r);
    for (const leak of ["Stage 2", "SECRETANCHOR", "SECRETSTAGEINPUT", "SECRETRATIONALE", "Third sentence", "Band 2 chosen", "stage_inputs", "anchor_hits"]) {
      expect(raw).not.toContain(leak);
    }
  });

  it("a row that is not final (review_needed / AIG_ error) is not shown", async () => {
    await setLevel("right_wrong");
    const s = await seed();
    await sup((c) => c.query(`UPDATE gradings SET status = 'review_needed', error_class = 'AIG_PARSE' WHERE question_id = $1`, [s.qs.subjective]));
    const r = await getCandidateFeedback(tenant, s.userId, s.attemptId);
    expect(r.items.map((i) => i.question_id)).not.toContain(s.qs.subjective);
    expect(r.items).toHaveLength(3);
  });

  it("an unreleased attempt -> 409 not ready; another user or unknown attempt -> 404", async () => {
    await setLevel("with_ai_justification");
    const pending = await seed("graded");
    await expect(getCandidateFeedback(tenant, pending.userId, pending.attemptId)).rejects.toMatchObject({ status: 409 });
    const s = await seed();
    await expect(getCandidateFeedback(tenant, randomUUID(), s.attemptId)).rejects.toMatchObject({ status: 404 });
    await expect(getCandidateFeedback(tenant, s.userId, randomUUID())).rejects.toMatchObject({ status: 404 });
    await expect(getCandidateFeedback(otherTenant, s.userId, s.attemptId)).rejects.toMatchObject({ status: 404 });
  });
});
