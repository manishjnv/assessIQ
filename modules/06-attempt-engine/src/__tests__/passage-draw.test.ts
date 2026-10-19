/**
 * EXP-8: passage draw-together and freeze.
 * Part 1: pure takeUnits / groupUnits. Part 2: real startAttempt against Postgres
 * (same container recipe as retake.test.ts). Fake data only.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { withTenant } from "../../../02-tenancy/src/with-tenant.js";
import { startAttempt as rawStartAttempt, recordTakeConsent } from "../service.js";
import { listFrozenQuestionsForAttempt } from "../repository.js";
import { takeUnits, groupUnits, type PassageInfo, type PassageFact } from "../passages.js";
import { createPack, addLevel, createQuestion, publishPack } from "../../../04-question-bank/src/service.js";
import { createAssessment, publishAssessment, inviteUsers } from "../../../05-assessment-lifecycle/src/service.js";

// ---------------------------------------------------------------------------
// Part 1: pure
// ---------------------------------------------------------------------------

const fact = (passageId: string, position: number | null, createdAt = 0): PassageFact => ({ passageId, position, createdAt });
const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id);

describe("takeUnits / groupUnits", () => {
  const info: PassageInfo = new Map([
    ["p1b", fact("P1", 2)], ["p1a", fact("P1", 1)], // P1: two children, a before b by position
    ["q1", fact("Q", null, 1)], ["q2", fact("Q", null, 1)], ["q3", fact("Q", null, 2)], // Q: tie on created_at -> id
  ]);
  const pick = (id: string) => ({ id, version: 1 });

  it("without passages it is exactly slice(0, n)", () => {
    const picks = ["a", "b", "c", "d"].map(pick);
    expect(takeUnits(picks, 3, new Map())).toEqual(picks.slice(0, 3));
  });

  it("draws all children of a drawn passage, together, in fixed order", () => {
    const out = takeUnits(["s1", "p1b", "s2", "p1a"].map(pick), 3, info);
    expect(ids(out)).toEqual(["s1", "p1a", "p1b"]);
  });

  it("orders by position, then created_at, then id", () => {
    expect(ids(groupUnits(["q3", "q2", "q1"].map(pick), info).flat())).toEqual(["q1", "q2", "q3"]);
  });

  it("skips a passage whole when it does not fit, and lets a later unit fill the gap", () => {
    // Q has 3 children, only 2 slots left after s1: Q is skipped whole, s2 fills.
    expect(ids(takeUnits(["s1", "q1", "q2", "q3", "s2"].map(pick), 2, info))).toEqual(["s1", "s2"]);
    // Never a partial passage.
    expect(ids(takeUnits(["q1", "q2", "q3"].map(pick), 2, info))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Part 2: database
// ---------------------------------------------------------------------------

const THIS_DIR = dirname(fileURLToPath(import.meta.url)) + sep;
const MODULES_ROOT = join(THIS_DIR, "..", "..", "..");

let container: StartedTestContainer;
let containerUrl: string;
let tenantA: string;
let adminA: string;

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
    await applyDir(c, join(MODULES_ROOT, "19-billing", "migrations"), ["0078_tenant_plans.sql", "0079_billing_events.sql", "0081_tenant_entitlements.sql"]);
    await applyDir(c, join(MODULES_ROOT, "07-ai-grading", "migrations"), ["0040_gradings.sql", "0100_attempts_ai_proposals_cache.sql"]);
    await applyDir(c, join(MODULES_ROOT, "09-scoring", "migrations"));
    await applyDir(c, join(MODULES_ROOT, "18-certification", "migrations"));
    await applyDir(c, join(MODULES_ROOT, "20-data-rights", "migrations"), ["0101_consent_events.sql", "0102_users_erased_at.sql"]);
  });
  setPoolForTesting(containerUrl);
  tenantA = randomUUID();
  adminA = randomUUID();
  await sup(async (c) => {
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'ta', 'Tenant ta')`, [tenantA]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [tenantA]);
    await c.query(`INSERT INTO tenant_plans (tenant_id, tier, included_credits) VALUES ($1, 'internal', NULL)`, [tenantA]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1, $2, 'a@t.local', 'Admin', 'admin', 'active')`, [adminA, tenantA]);
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

async function candidateUser(): Promise<string> {
  const id = randomUUID();
  await sup((c) => c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1, $2, $3, 'Cand', 'candidate', 'active')`, [id, tenantA, `c-${id}@x.com`]));
  return id;
}

/** A pack with the given passages (child counts) and `singles` standalone questions; an active assessment drawing `count`. */
async function setup(passageSizes: number[], singles: number, count: number) {
  const pack = await createPack(tenantA, { slug: `p-${randomUUID().slice(0, 8)}`, name: "P", domain: "soc" }, adminA);
  const level = await addLevel(tenantA, pack.id, { position: 1, label: "L1", duration_minutes: 30, default_question_count: count }, adminA);
  const mk = (topic: string) => createQuestion(
    tenantA,
    { pack_id: pack.id, level_id: level.id, type: "mcq", topic, points: 2, content: { question: `${topic} ${randomUUID()}?`, options: ["A", "B", "C", "D"], correct: 0, rationale: "A" } },
    adminA,
  );
  const passages: Array<{ id: string; children: string[] }> = [];
  for (const [pi, size] of passageSizes.entries()) {
    const pid = randomUUID();
    await sup((c) => c.query(`INSERT INTO passages (id, tenant_id, title, body) VALUES ($1,$2,$3,$4)`, [pid, tenantA, `Passage ${pi}`, `Read the text ${pi}. 2+2?`]));
    const children: string[] = [];
    for (let k = 0; k < size; k++) children.push((await mk(`p${pi}c${k}`)).id);
    // Reverse positions: the first-created child comes LAST in the passage.
    for (const [k, qid] of children.entries()) {
      await sup((c) => c.query(`UPDATE questions SET passage_id=$2, passage_position=$3 WHERE id=$1`, [qid, pid, size - k]));
    }
    passages.push({ id: pid, children: [...children].reverse() }); // children in fixed order
  }
  for (let i = 0; i < singles; i++) await mk(`s${i}`);
  await publishPack(tenantA, pack.id, adminA);
  await sup((c) => c.query(`UPDATE questions SET status = 'active', review_state = 'verified' WHERE pack_id = $1`, [pack.id]));
  const assessment = await createAssessment(tenantA, { pack_id: pack.id, level_id: level.id, name: "Passage test", question_count: count, opens_at: new Date(Date.now() + 60_000) }, adminA);
  await publishAssessment(tenantA, assessment.id, adminA);
  await sup((c) => c.query(`UPDATE assessments SET status = 'active' WHERE id = $1`, [assessment.id]));
  return { assessmentId: assessment.id, passages };
}

async function begin(assessmentId: string) {
  const userId = await candidateUser();
  await inviteUsers(tenantA, assessmentId, [userId], adminA);
  await recordTakeConsent(tenantA, { userId, ip: null, userAgent: null });
  const attempt = await rawStartAttempt(tenantA, { userId, assessmentId });
  const frozen = await withTenant(tenantA, (c) => listFrozenQuestionsForAttempt(c, attempt.id));
  return { attempt, frozen };
}

describe("startAttempt with passages", () => {
  it("draws all children of a chosen passage, adjacent, in fixed order; positions stay unique", async () => {
    const { assessmentId, passages } = await setup([2, 3], 4, 5);
    for (let i = 0; i < 12; i++) {
      const { frozen } = await begin(assessmentId);
      expect(frozen).toHaveLength(5);
      expect(frozen.map((f) => f.position)).toEqual([1, 2, 3, 4, 5]);
      const order = frozen.map((f) => f.question_id);
      for (const p of passages) {
        const at = p.children.map((q) => order.indexOf(q));
        const drawn = at.filter((x) => x >= 0).length;
        expect(drawn === 0 || drawn === p.children.length).toBe(true); // never a partial passage
        if (drawn > 0) expect(at).toEqual([at[0]!, at[0]! + 1, ...(p.children.length === 3 ? [at[0]! + 2] : [])]);
      }
      // The frozen row carries the passage for exactly the passage children.
      for (const f of frozen) {
        const p = passages.find((x) => x.children.includes(f.question_id));
        expect(f.passage?.id).toBe(p?.id);
      }
    }
  });

  it("skips a passage whole when it does not fit", async () => {
    const { assessmentId, passages } = await setup([2, 3], 0, 2);
    const { frozen } = await begin(assessmentId);
    expect(frozen.map((f) => f.question_id)).toEqual(passages[0]!.children); // the 3-child passage is skipped whole
  });

  it("a frozen attempt keeps its passage when the question is repointed later", async () => {
    const { assessmentId, passages } = await setup([2], 0, 2);
    const { attempt, frozen } = await begin(assessmentId);
    expect(frozen[0]!.passage).toMatchObject({ id: passages[0]!.id, title: "Passage 0", body: "Read the text 0. 2+2?" });
    const other = randomUUID();
    await sup(async (c) => {
      await c.query(`INSERT INTO passages (id, tenant_id, body) VALUES ($1,$2,'New text')`, [other, tenantA]);
      await c.query(`UPDATE questions SET passage_id=$2 WHERE id = ANY($1::uuid[])`, [passages[0]!.children, other]);
    });
    const again = await withTenant(tenantA, (c) => listFrozenQuestionsForAttempt(c, attempt.id));
    expect(again[0]!.passage?.id).toBe(passages[0]!.id);
    expect(again[0]!.passage?.body).toBe("Read the text 0. 2+2?");
    const stored = await sup((c) => c.query(`SELECT passage_id FROM attempt_questions WHERE attempt_id=$1 ORDER BY position`, [attempt.id]));
    expect(stored.rows.map((r) => r.passage_id)).toEqual([passages[0]!.id, passages[0]!.id]);
  });
});
