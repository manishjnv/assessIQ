/**
 * Admin Grade / Accept with deterministic MCQ scoring (testcontainers).
 * Regression: MCQ questions were never scored - see RCA_LOG 2026-10-01.
 *
 *  - MCQ-only attempt stuck in submitted / auto_submitted (pre-fix): one admin
 *    Grade click finalises it (score + graded + billing + audit), no AI call.
 *  - Mixed attempt: Grade writes MCQ rows, attempt stays pending; Accept of the
 *    AI proposal flips to graded and the total includes the MCQ points.
 *
 * runtime-selector is mocked; gradeSubjective never calls claude.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const gradeSubjectiveMock = vi.fn();
vi.mock("../runtime-selector.js", () => ({
  gradeSubjective: (...a: unknown[]) => gradeSubjectiveMock(...a),
}));

import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { handleAdminGrade } from "../handlers/admin-grade.js";
import { handleAdminAccept } from "../handlers/admin-accept.js";

const toFsPath = (url: URL): string => url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
const MODULES_ROOT = join(toFsPath(new URL(".", import.meta.url)), "..", "..", "..");
const DIRS: Array<[string, string[] | undefined]> = [
  ["02-tenancy", undefined],
  ["03-users", ["020_users.sql"]],
  ["14-audit-log", undefined],
  ["04-question-bank", undefined],
  ["05-assessment-lifecycle", undefined],
  ["06-attempt-engine", undefined],
  ["12-embed-sdk", ["0073_attempt_embed_origin.sql"]],
  ["07-ai-grading", ["0040_gradings.sql", "0041_tenant_grading_budgets.sql", "0100_attempts_ai_proposals_cache.sql"]],
  ["09-scoring", undefined],
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
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_aig_mcq" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_aig_mcq`;

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
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'t-aig-mcq','T')`, [tenant]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tenant]);
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@aigmcq.test','A','admin','active')`,
      [admin, tenant],
    );
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

/** 2 MCQ (10 pts each; first correct, second wrong) [+ 1 subjective, 10 pts]. Pre-fix state: no gradings rows. */
async function seed(status: string, mixed: boolean): Promise<{ attemptId: string; subjectiveId: string | null }> {
  const pack = randomUUID();
  const level = randomUUID();
  const assessment = randomUUID();
  const cand = randomUUID();
  const attemptId = randomUUID();
  let subjectiveId: string | null = null;
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
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, created_by) VALUES ($1,$2,$3,$4,1,'A','active',3,$5)`,
      [assessment, tenant, pack, level, admin],
    );
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'C','candidate','active')`,
      [cand, tenant, `c-${randomUUID().slice(0, 6)}@aigmcq.test`],
    );
    await c.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, duration_seconds)
       VALUES ($1,$2,$3,$4,$5, now() - interval '30 minutes', now(), 3600)`,
      [attemptId, tenant, assessment, cand, status],
    );
    const types = mixed ? ["mcq", "mcq", "subjective"] : ["mcq", "mcq"];
    let pos = 1;
    for (const type of types) {
      const qid = randomUUID();
      if (type === "subjective") subjectiveId = qid;
      const content = JSON.stringify(
        type === "mcq" ? { question: "q", options: ["a", "b", "c", "d"], correct: 1, rationale: "r" } : { question: "q" },
      );
      await c.query(
        `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, version, created_by) VALUES ($1,$2,$3,$4,'t',10,'active',$5::jsonb,1,$6)`,
        [qid, pack, level, type, content, admin],
      );
      await c.query(`INSERT INTO question_versions (question_id, version, content, saved_by) VALUES ($1,1,$2::jsonb,$3)`, [qid, content, admin]);
      await c.query(`INSERT INTO attempt_questions (attempt_id, question_id, position, question_version) VALUES ($1,$2,$3,1)`, [attemptId, qid, pos]);
      await c.query(`INSERT INTO attempt_answers (attempt_id, question_id, answer) VALUES ($1,$2,$3::jsonb)`, [
        attemptId,
        qid,
        JSON.stringify(type === "mcq" ? { selected: pos === 1 ? 1 : 0 } : { response: "text" }),
      ]);
      pos++;
    }
  });
  return { attemptId, subjectiveId };
}

const status = (id: string) =>
  sup((c) => c.query(`SELECT status FROM attempts WHERE id=$1`, [id]).then((r) => r.rows[0].status as string));
const count = (sql: string, id: string) => sup((c) => c.query(sql, [id]).then((r) => Number(r.rows[0].n)));
const fresh = (): Date => new Date(Date.now() - 5_000);

describe("handleAdminGrade - MCQ-only attempts", () => {
  for (const st of ["submitted", "auto_submitted"]) {
    it(`attempt stuck in '${st}' with no gradings: one Grade click finalises it`, async () => {
      const { attemptId } = await seed(st, false);
      const out = await handleAdminGrade({ tenantId: tenant, userId: admin, attemptId, sessionLastActivity: fresh() });
      expect(out.proposals).toEqual([]);
      expect(out.attempt).toEqual({ id: attemptId, status: "graded" });
      expect(gradeSubjectiveMock).not.toHaveBeenCalled();
      expect(await status(attemptId)).toBe("graded");
      const s = await sup((c) =>
        c.query(`SELECT total_earned::float e, total_max::float m FROM attempt_scores WHERE attempt_id=$1`, [attemptId]).then((r) => r.rows[0]),
      );
      expect(s).toMatchObject({ e: 10, m: 20 });
      expect(await count(`SELECT COUNT(*) n FROM billing_events WHERE attempt_id=$1`, attemptId)).toBe(1);
      expect(await count(`SELECT COUNT(*) n FROM audit_log WHERE entity_id=$1 AND action='grading.accepted'`, attemptId)).toBe(1);
    });
  }
});

describe("mixed attempt - Grade then Accept", () => {
  it("Grade writes MCQ rows but leaves it pending; Accept of the AI proposal -> graded with MCQ in the total", async () => {
    const { attemptId, subjectiveId } = await seed("submitted", true);
    gradeSubjectiveMock.mockImplementation(async (a: { attempt_id: string; question_id: string }) => ({
      attempt_id: a.attempt_id,
      question_id: a.question_id,
      anchors: [],
      band: { reasoning_band: 4, ai_justification: "good", error_class: null, needs_escalation: false },
      score_earned: 10,
      score_max: 10,
      prompt_version_sha: "anchors:aaaaaaaa;band:bbbbbbbb;escalate:-",
      prompt_version_label: "v1;v1;-",
      model: "test-model",
      escalation_chosen_stage: "2",
      generated_at: new Date().toISOString(),
    }));

    const out = await handleAdminGrade({ tenantId: tenant, userId: admin, attemptId, sessionLastActivity: fresh() });
    expect(out.attempt).toBeUndefined();
    expect(out.proposals).toHaveLength(1); // only the subjective goes to the AI batch
    expect(await status(attemptId)).toBe("submitted");
    expect(await count(`SELECT COUNT(*) n FROM gradings WHERE attempt_id=$1 AND grader='deterministic'`, attemptId)).toBe(2);
    expect(await count(`SELECT COUNT(*) n FROM billing_events WHERE attempt_id=$1`, attemptId)).toBe(0);

    const acc = await handleAdminAccept({ tenantId: tenant, userId: admin, attemptId, proposals: out.proposals });
    expect(acc.attempt.status).toBe("graded"); // gate counts only AI-gradable questions
    expect(subjectiveId).not.toBeNull();
    const s = await sup((c) =>
      c.query(`SELECT total_earned::float e, total_max::float m FROM attempt_scores WHERE attempt_id=$1`, [attemptId]).then((r) => r.rows[0]),
    );
    expect(s).toMatchObject({ e: 20, m: 30 }); // 10 (MCQ correct) + 0 + 10 (AI)
    expect(await count(`SELECT COUNT(*) n FROM billing_events WHERE attempt_id=$1`, attemptId)).toBe(1);
  });
});
