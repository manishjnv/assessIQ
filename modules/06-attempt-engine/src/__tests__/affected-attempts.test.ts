/**
 * EXP-12: listAttemptsOnOlderVersions (finished attempts on an older question version).
 *
 * Same testcontainer + migration order as attempt-engine.test.ts. One container for the file.
 * No module mocks: the real services run against the real schema (so a missing mock export cannot hide a bug).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { startAttempt as rawStartAttempt, recordTakeConsent, submitAttempt } from "../service.js";
import { listAttemptsOnOlderVersions } from "../service.js";
import { createPack, addLevel, createQuestion, publishPack, updateQuestion } from "../../../04-question-bank/src/service.js";
import {
  createAssessment,
  publishAssessment,
  inviteUsers,
} from "../../../05-assessment-lifecycle/src/service.js";
import { NotFoundError } from "@assessiq/core";

const THIS_DIR = dirname(fileURLToPath(import.meta.url)) + sep;
const AE_MODULE_ROOT = join(THIS_DIR, "..", "..");
const MODULES_ROOT = join(AE_MODULE_ROOT, "..");

let container: StartedTestContainer;
let containerUrl: string;
let tenantA: string;
let tenantB: string;
let adminA: string;
let adminB: string;

async function sup<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: containerUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function applyDir(client: Client, dir: string, only?: string[]): Promise<void> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const f of only !== undefined ? files.filter((x) => only.includes(x)) : files) {
    await client.query(await readFile(join(dir, f), "utf8"));
  }
}

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "assessiq", POSTGRES_PASSWORD: "assessiq_test_pw", POSTGRES_DB: "assessiq" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  containerUrl = `postgres://assessiq:assessiq_test_pw@${container.getHost()}:${container.getMappedPort(5432)}/assessiq`;

  await sup(async (c) => {
    await applyDir(c, join(MODULES_ROOT, "02-tenancy", "migrations"));
    await applyDir(c, join(MODULES_ROOT, "03-users", "migrations"), ["020_users.sql"]);
    await applyDir(c, join(MODULES_ROOT, "04-question-bank", "migrations"));
    await applyDir(c, join(MODULES_ROOT, "05-assessment-lifecycle", "migrations"));
    await applyDir(c, join(MODULES_ROOT, "06-attempt-engine", "migrations"));
    await applyDir(c, join(MODULES_ROOT, "12-embed-sdk", "migrations"), ["0073_attempt_embed_origin.sql"]);
    await applyDir(c, join(MODULES_ROOT, "14-audit-log", "migrations"));
    await applyDir(c, join(MODULES_ROOT, "13-notifications", "migrations"));
    await applyDir(c, join(MODULES_ROOT, "19-billing", "migrations"), [
      "0078_tenant_plans.sql",
      "0079_billing_events.sql",
      "0081_tenant_entitlements.sql",
    ]);
    await applyDir(c, join(MODULES_ROOT, "07-ai-grading", "migrations"), [
      "0040_gradings.sql",
      "0100_attempts_ai_proposals_cache.sql",
    ]);
    await applyDir(c, join(MODULES_ROOT, "09-scoring", "migrations"));
    await applyDir(c, join(MODULES_ROOT, "18-certification", "migrations")); // the result view LEFT JOINs certificates
    await applyDir(c, join(MODULES_ROOT, "20-data-rights", "migrations"), [
      "0101_consent_events.sql",
      "0102_users_erased_at.sql",
    ]);
  });
  setPoolForTesting(containerUrl);

  tenantA = randomUUID();
  tenantB = randomUUID();
  adminA = randomUUID();
  adminB = randomUUID();
  await sup(async (c) => {
    for (const [id, slug] of [[tenantA, "ta"], [tenantB, "tb"]] as const) {
      await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`, [id, slug, `Tenant ${slug}`]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
      await c.query(`INSERT INTO tenant_plans (tenant_id, tier, included_credits) VALUES ($1, 'internal', NULL)`, [id]);
    }
    for (const [id, t, e] of [[adminA, tenantA, "a@t.local"], [adminB, tenantB, "b@t.local"]] as const) {
      await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1, $2, $3, 'Admin', 'admin', 'active')`, [id, t, e]);
    }
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

// Consent is part of every non-embed Begin (R4); record it first like the main suite does.
async function start(tenantId: string, input: Parameters<typeof rawStartAttempt>[1]) {
  if (input.embedOrigin !== true) await recordTakeConsent(tenantId, { userId: input.userId, ip: null, userAgent: null });
  return rawStartAttempt(tenantId, input);
}

/** An active assessment with one invited candidate. */
async function setup() {
  const candidate = randomUUID();
  await sup((c) =>
    c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1, $2, $3, 'Cand', 'candidate', 'active')`, [
      candidate,
      tenantA,
      `c-${candidate}@x.com`,
    ]),
  );
  const pack = await createPack(tenantA, { slug: `p-${randomUUID().slice(0, 8)}`, name: "P", domain: "soc" }, adminA);
  const level = await addLevel(tenantA, pack.id, { position: 1, label: "L1", duration_minutes: 30, default_question_count: 3 }, adminA);
  for (let i = 0; i < 3; i++) {
    await createQuestion(
      tenantA,
      { pack_id: pack.id, level_id: level.id, type: "mcq", topic: `t${i}`, points: 5, content: { question: `Q${i}?`, options: ["A", "B", "C", "D"], correct: 0, rationale: "A" } },
      adminA,
    );
  }
  await publishPack(tenantA, pack.id, adminA);
  await sup((c) => c.query(`UPDATE questions SET status = 'active', review_state = 'verified' WHERE pack_id = $1`, [pack.id]));
  const assessment = await createAssessment(
    tenantA,
    {
      pack_id: pack.id,
      level_id: level.id,
      name: "Retake test",
      question_count: 3,
      opens_at: new Date(Date.now() + 60_000),
    },
    adminA,
  );
  await publishAssessment(tenantA, assessment.id, adminA);
  await sup((c) => c.query(`UPDATE assessments SET status = 'active' WHERE id = $1`, [assessment.id]));
  await inviteUsers(tenantA, assessment.id, [candidate], adminA);
  return { candidate, assessmentId: assessment.id };
}

const questionsOf = (attemptId: string) =>
  sup((c) => c.query(`SELECT question_id FROM attempt_questions WHERE attempt_id = $1 ORDER BY position`, [attemptId])).then((r) => r.rows.map((x) => x.question_id as string));

const correctKey = (qid: string) =>
  updateQuestion(tenantA, qid, { content: { question: "Q?", options: ["A", "B", "C", "D"], correct: 1, rationale: "B" } }, adminA);

describe("EXP-12 affected attempts", () => {
  it("lists finished attempts on an older version only; not in-progress, not other tenants; 404 for a foreign question", async () => {
    const s = await setup();
    const done = await start(tenantA, { userId: s.candidate, assessmentId: s.assessmentId });
    const qid = (await questionsOf(done.id))[0]!;
    await submitAttempt(tenantA, s.candidate, done.id);

    // A second candidate on the same assessment stays in progress.
    const other = randomUUID();
    await sup((c) => c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1, $2, $3, 'C2', 'candidate', 'active')`, [other, tenantA, `c-${other}@x.com`]));
    await inviteUsers(tenantA, s.assessmentId, [other], adminA);
    const running = await start(tenantA, { userId: other, assessmentId: s.assessmentId });
    expect(await questionsOf(running.id)).toContain(qid);

    // The assessment's frozen pool predates the SQL activation in setup(); align the frozen versions with the live one.
    await sup((c) => c.query(`UPDATE attempt_questions aq SET question_version = q.version FROM questions q WHERE q.id = aq.question_id`));
    // Before the correction nothing is affected.
    const before = await listAttemptsOnOlderVersions(tenantA, qid);
    expect(before).toMatchObject({ question_id: qid, total: 0, items: [] });

    await correctKey(qid);
    const res = await listAttemptsOnOlderVersions(tenantA, qid);
    expect(res.current_version).toBe(before.current_version + 1);
    expect(res.total).toBe(1);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      attempt_id: done.id,
      assessment_id: s.assessmentId,
      assessment_name: "Retake test",
      candidate_user_id: s.candidate,
      status: "graded", // MCQ-only attempt is auto-scored at submit
      question_version: before.current_version,
    });
    expect(Object.keys(res.items[0]!).sort()).toEqual(
      ["assessment_id", "assessment_name", "attempt_id", "candidate_user_id", "question_version", "status", "submitted_at"],
    );

    // Tenant B cannot see tenant A's question: 404, not an empty 200.
    await expect(listAttemptsOnOlderVersions(tenantB, qid)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listAttemptsOnOlderVersions(tenantB, qid)).rejects.toMatchObject({ details: { code: "QUESTION_NOT_FOUND" } });
    await expect(listAttemptsOnOlderVersions(tenantA, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });

  it("caps items at 200, total is the full count, newest first", async () => {
    const s = await setup();
    const a = await start(tenantA, { userId: s.candidate, assessmentId: s.assessmentId });
    const qid = (await questionsOf(a.id))[0]!;
    await submitAttempt(tenantA, s.candidate, a.id);
    // 204 synthetic finished attempts on the same frozen question version.
    await sup((c) => c.query(`UPDATE attempt_questions aq SET question_version = q.version FROM questions q WHERE q.id = aq.question_id`));
    const v = (await sup((c) => c.query(`SELECT version FROM questions WHERE id = $1`, [qid]))).rows[0].version as number;
    await sup(async (c) => {
      for (let i = 0; i < 204; i++) {
        const uid = randomUUID();
        const aid = randomUUID();
        await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1, $2, $3, 'S', 'candidate', 'active')`, [uid, tenantA, `s-${uid}@x.com`]);
        await c.query(`INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, submitted_at) VALUES ($1, $2, $3, $4, 'graded', now() + ($5 || ' seconds')::interval)`, [aid, tenantA, s.assessmentId, uid, String(i + 10)]);
        await c.query(`INSERT INTO attempt_questions (attempt_id, question_id, position, question_version) VALUES ($1, $2, 0, $3)`, [aid, qid, v]);
      }
    });
    await correctKey(qid);
    const res = await listAttemptsOnOlderVersions(tenantA, qid);
    expect(res.total).toBe(205);
    expect(res.items).toHaveLength(200);
    const times = res.items.map((x) => Date.parse(x.submitted_at!));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
  });
});
