/**
 * Per-student MCQ option shuffle, end to end on a real Postgres (testcontainers):
 * attempt start stores the order, the candidate view serves it, saves translate the
 * DISPLAYED index to the ORIGINAL index, reloads translate back, scoring (09) sees
 * original indexes only, and legacy (NULL order) attempts are untouched.
 *
 * Pure helper behaviour is covered by option-shuffle.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import {
  startAttempt as rawStartAttempt,
  recordTakeConsent,
  getAttemptForCandidate,
  listAnswersForAttempt,
  saveAnswer,
  submitAttempt,
} from "../service.js";

const toFsPath = (url: URL): string => url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
const MODULES_ROOT = join(toFsPath(new URL(".", import.meta.url)), "..", "..", "..");
const DIRS: Array<[string, string[] | undefined]> = [
  ["02-tenancy", undefined],
  ["03-users", ["020_users.sql"]],
  ["14-audit-log", undefined],
  ["04-question-bank", undefined],
  ["05-assessment-lifecycle", undefined],
  ["06-attempt-engine", undefined], // includes 0119_attempt_questions_option_order.sql
  ["12-embed-sdk", ["0073_attempt_embed_origin.sql"]],
  ["07-ai-grading", ["0040_gradings.sql", "0041_tenant_grading_budgets.sql", "0100_attempts_ai_proposals_cache.sql"]],
  ["09-scoring", undefined],
  ["19-billing", undefined],
  ["20-data-rights", ["0101_consent_events.sql"]],
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
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_ae_shuffle" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_ae_shuffle`;

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
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'t-ae-shuffle','T')`, [tenant]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tenant]);
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@aeshuffle.test','A','admin','active')`,
      [admin, tenant],
    );
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Q {
  id: string;
  type: "mcq" | "subjective";
  options: string[];
  correct: number;
  /** Expected: does startAttempt shuffle this question? */
  shuffled: boolean;
}

const MCQ = (question: string, options: string[], correct: number, shuffled: boolean) =>
  ({ type: "mcq" as const, content: { question, options, correct, rationale: "r" }, options, correct, shuffled });

const SPECS = {
  mixed: [
    MCQ("Capital of France?", ["Paris", "London", "Berlin", "Madrid"], 0, true),
    MCQ("Boiling point of water?", ["50 C", "75 C", "100 C", "150 C", "200 C"], 2, true),
    MCQ("Largest planet?", ["Mars", "Venus", "Jupiter", "Saturn"], 2, true),
    MCQ("Which are fruits?", ["Apple", "Banana", "Mango", "All of the above"], 3, false),
    MCQ("Which animals bark?", ["Cats", "Dogs", "Both A and B", "Neither"], 1, false),
    { type: "subjective" as const, content: { question: "Explain TLS." }, options: [], correct: -1, shuffled: false },
  ],
  mcqOnly: [
    MCQ("Capital of France?", ["Paris", "London", "Berlin", "Madrid"], 0, true),
    MCQ("Largest planet?", ["Mars", "Venus", "Jupiter", "Saturn"], 2, true),
    MCQ("Square root of 144?", ["10", "11", "12", "14"], 2, true),
    MCQ("Which are fruits?", ["Apple", "Banana", "Mango", "All of the above"], 3, false),
  ],
};

interface Fixture {
  assessmentId: string;
  questions: Q[];
}

async function seedFixture(spec: ReadonlyArray<(typeof SPECS)["mixed"][number]>): Promise<Fixture> {
  const pack = randomUUID();
  const level = randomUUID();
  const assessmentId = randomUUID();
  const questions: Q[] = [];
  await sup(async (c) => {
    await c.query(
      `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,$3,'P','soc','published',$4)`,
      [pack, tenant, `p-${randomUUID().slice(0, 8)}`, admin],
    );
    await c.query(
      `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,$3,60)`,
      [level, pack, spec.length],
    );
    await c.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, created_by) VALUES ($1,$2,$3,$4,1,'A','active',$5,$6)`,
      [assessmentId, tenant, pack, level, spec.length, admin],
    );
    for (const s of spec) {
      const id = randomUUID();
      const content = JSON.stringify(s.content);
      await c.query(
        `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, version, created_by) VALUES ($1,$2,$3,$4,'t',10,'active',$5::jsonb,1,$6)`,
        [id, pack, level, s.type, content, admin],
      );
      await c.query(`INSERT INTO question_versions (question_id, version, content, saved_by) VALUES ($1,1,$2::jsonb,$3)`, [id, content, admin]);
      questions.push({ id, type: s.type, options: s.options, correct: s.correct, shuffled: s.shuffled });
    }
  });
  return { assessmentId, questions };
}

/** A candidate invited to the assessment. */
async function seedCandidate(assessmentId: string): Promise<string> {
  const userId = randomUUID();
  await sup(async (c) => {
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'C','candidate','active')`,
      [userId, tenant, `c-${randomUUID().slice(0, 8)}@aeshuffle.test`],
    );
    await c.query(
      `INSERT INTO assessment_invitations (assessment_id, user_id, token_hash, expires_at, status, invited_by)
       VALUES ($1,$2,$3, now() + interval '1 day', 'pending', $4)`,
      [assessmentId, userId, randomUUID(), admin],
    );
  });
  return userId;
}

/** Standard Begin: consent then start. */
async function begin(userId: string, assessmentId: string) {
  await recordTakeConsent(tenant, { userId, ip: null, userAgent: null });
  return rawStartAttempt(tenant, { userId, assessmentId });
}

const storedOrders = (attemptId: string) =>
  sup((c) =>
    c
      .query<{ question_id: string; option_order: number[] | null }>(
        `SELECT question_id, option_order FROM attempt_questions WHERE attempt_id=$1`,
        [attemptId],
      )
      .then((r) => new Map(r.rows.map((x) => [x.question_id, x.option_order]))),
  );

const storedAnswer = (attemptId: string, qid: string) =>
  sup((c) =>
    c
      .query<{ answer: unknown }>(`SELECT answer FROM attempt_answers WHERE attempt_id=$1 AND question_id=$2`, [attemptId, qid])
      .then((r) => r.rows[0]?.answer),
  );

/** Pin a known permutation so the display/original mapping is exercised with a non-identity order. */
const forceOrder = (attemptId: string, qid: string, order: number[]) =>
  sup((c) =>
    c.query(`UPDATE attempt_questions SET option_order = $3::smallint[] WHERE attempt_id=$1 AND question_id=$2`, [attemptId, qid, order]),
  );

const displayedOptions = (view: Awaited<ReturnType<typeof getAttemptForCandidate>>, qid: string): string[] =>
  (view.questions.find((q) => q.question_id === qid)!.content as { options: string[] }).options;

const answerOf = (view: Awaited<ReturnType<typeof getAttemptForCandidate>>, qid: string): unknown =>
  view.answers.find((a) => a.question_id === qid)!.answer;

// ---------------------------------------------------------------------------

describe("per-student MCQ option shuffle", () => {
  let mixed: Fixture;
  beforeAll(async () => {
    mixed = await seedFixture(SPECS.mixed);
  });

  it("start stores a permutation for eligible MCQs and NULL for cross-referencing MCQs / non-MCQs (standard + embed)", async () => {
    const userId = await seedCandidate(mixed.assessmentId);
    const attempt = await begin(userId, mixed.assessmentId);

    const check = (orders: Map<string, number[] | null>) => {
      for (const q of mixed.questions) {
        const order = orders.get(q.id);
        if (q.shuffled) {
          expect(order, `${q.options.join("|")}`).not.toBeNull();
          expect([...(order as number[])].sort((a, b) => a - b)).toEqual(q.options.map((_, i) => i));
        } else {
          expect(order, `${q.type}: ${q.options.join("|")}`).toBeNull();
        }
      }
    };
    const first = await storedOrders(attempt.id);
    check(first);

    // Resume (second Begin / reload) is the same attempt and never redraws the order.
    const again = await begin(userId, mixed.assessmentId);
    expect(again.id).toBe(attempt.id);
    expect(await storedOrders(attempt.id)).toEqual(first);

    // The embed / JIT start goes through the same function and gets an order too.
    const embedUser = randomUUID();
    await sup((c) =>
      c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'E','candidate','active')`, [
        embedUser,
        tenant,
        `e-${randomUUID().slice(0, 8)}@aeshuffle.test`,
      ]),
    );
    const embedAttempt = await rawStartAttempt(tenant, { userId: embedUser, assessmentId: mixed.assessmentId, embedOrigin: true });
    check(await storedOrders(embedAttempt.id));
  });

  it("saving a DISPLAYED index stores the ORIGINAL index; a reload maps back to the same displayed choice and order", async () => {
    const userId = await seedCandidate(mixed.assessmentId);
    const attempt = await begin(userId, mixed.assessmentId);
    const q = mixed.questions[0]!; // Paris|London|Berlin|Madrid, correct = 0 (Paris)
    await forceOrder(attempt.id, q.id, [2, 0, 3, 1]); // displayed: Berlin, Paris, Madrid, London

    const view1 = await getAttemptForCandidate(tenant, attempt.id, userId);
    expect(displayedOptions(view1, q.id)).toEqual(["Berlin", "Paris", "Madrid", "London"]);

    // The candidate clicks displayed position 1 ("Paris").
    await saveAnswer(tenant, userId, { attemptId: attempt.id, questionId: q.id, answer: { selected: 1 }, client_revision: 0 });
    expect(await storedAnswer(attempt.id, q.id)).toEqual({ selected: 0 }); // ORIGINAL index of Paris

    // Reload: same order, same choice at the same displayed position.
    const view2 = await getAttemptForCandidate(tenant, attempt.id, userId);
    expect(displayedOptions(view2, q.id)).toEqual(["Berlin", "Paris", "Madrid", "London"]);
    expect(answerOf(view2, q.id)).toEqual({ selected: 1 });
    expect(await listAnswersForAttempt(tenant, userId, attempt.id)).toEqual(view2.answers);

    // Re-save over it (last write wins) with another displayed position.
    await saveAnswer(tenant, userId, { attemptId: attempt.id, questionId: q.id, answer: { selected: 3 }, client_revision: 1 });
    expect(await storedAnswer(attempt.id, q.id)).toEqual({ selected: 1 }); // London
    expect(answerOf(await getAttemptForCandidate(tenant, attempt.id, userId), q.id)).toEqual({ selected: 3 });

    // The candidate never receives the order, the answer key or original indexes.
    expect(JSON.stringify(view2)).not.toMatch(/option_order|optionOrder|"correct"|rationale/);
  });

  it("a random order served to the candidate is a permutation of the authored options, and each choice maps to the same option text", async () => {
    const userId = await seedCandidate(mixed.assessmentId);
    const attempt = await begin(userId, mixed.assessmentId);
    const view = await getAttemptForCandidate(tenant, attempt.id, userId);

    for (const q of mixed.questions.filter((x) => x.type === "mcq")) {
      const shown = displayedOptions(view, q.id);
      expect([...shown].sort()).toEqual([...q.options].sort());
      const d = shown.length - 1;
      await saveAnswer(tenant, userId, { attemptId: attempt.id, questionId: q.id, answer: { selected: d }, client_revision: 0 });
      const stored = (await storedAnswer(attempt.id, q.id)) as { selected: number };
      // What the admin review shows (authored options[stored.selected]) is exactly what the candidate clicked.
      expect(q.options[stored.selected]).toBe(shown[d]);
      expect(answerOf(await getAttemptForCandidate(tenant, attempt.id, userId), q.id)).toEqual({ selected: d });
    }
  });

  it("an out-of-range / malformed index on a shuffled MCQ is stored exactly as sent (as before) and never credited", async () => {
    const userId = await seedCandidate(mixed.assessmentId);
    const attempt = await begin(userId, mixed.assessmentId);
    const q = mixed.questions[0]!;
    await forceOrder(attempt.id, q.id, [2, 0, 3, 1]);

    for (const bad of [{ selected: 9 }, { selected: -1 }, { selected: 1.5 }, { selected: "1" }, "1"]) {
      await saveAnswer(tenant, userId, { attemptId: attempt.id, questionId: q.id, answer: bad, client_revision: 0 });
      expect(await storedAnswer(attempt.id, q.id)).toEqual(bad); // untouched, no new rejection
      expect(answerOf(await getAttemptForCandidate(tenant, attempt.id, userId), q.id)).toEqual(bad);
    }

    await submitAttempt(tenant, userId, attempt.id);
    const g = await sup((c) =>
      c.query(`SELECT score_earned::float AS e FROM gradings WHERE attempt_id=$1 AND question_id=$2 AND grader='deterministic'`, [attempt.id, q.id]),
    );
    expect(g.rows[0]!.e).toBe(0);
  });

  it("scoring a shuffled attempt: picking the correct option's DISPLAYED position earns full marks, a wrong one earns none", async () => {
    const fixture = await seedFixture(SPECS.mcqOnly);
    const scoreOf = (attemptId: string) =>
      sup((c) =>
        c
          .query(`SELECT total_earned::float e, total_max::float m FROM attempt_scores WHERE attempt_id=$1`, [attemptId])
          .then((r) => r.rows[0] as { e: number; m: number }),
      );

    // Candidate 1 answers everything correctly, Candidate 2 everything wrong — by what is on screen.
    for (const mode of ["correct", "wrong"] as const) {
      const userId = await seedCandidate(fixture.assessmentId);
      const attempt = await begin(userId, fixture.assessmentId);
      // Pin a reversed (non-identity) order on every shuffled question so a missing
      // translation cannot pass by luck of a random identity draw.
      for (const q of fixture.questions.filter((x) => x.shuffled)) {
        await forceOrder(attempt.id, q.id, q.options.map((_, i) => q.options.length - 1 - i));
      }
      const view = await getAttemptForCandidate(tenant, attempt.id, userId);
      for (const q of fixture.questions) {
        const shown = displayedOptions(view, q.id);
        const correctText = q.options[q.correct]!;
        const pick = mode === "correct" ? shown.indexOf(correctText) : shown.findIndex((t) => t !== correctText);
        await saveAnswer(tenant, userId, { attemptId: attempt.id, questionId: q.id, answer: { selected: pick }, client_revision: 0 });
      }
      await submitAttempt(tenant, userId, attempt.id);
      expect(await scoreOf(attempt.id)).toEqual(mode === "correct" ? { e: 40, m: 40 } : { e: 0, m: 40 });
    }
  });

  it("a legacy attempt with a NULL option_order is unchanged: authored order, indexes stored and read as sent, scored by index", async () => {
    const fixture = await seedFixture(SPECS.mcqOnly);
    const userId = await seedCandidate(fixture.assessmentId);
    const attempt = await begin(userId, fixture.assessmentId);
    // An attempt created before migration 0119 has no order on any row.
    await sup((c) => c.query(`UPDATE attempt_questions SET option_order = NULL WHERE attempt_id=$1`, [attempt.id]));

    const view = await getAttemptForCandidate(tenant, attempt.id, userId);
    for (const q of fixture.questions) {
      expect(displayedOptions(view, q.id)).toEqual(q.options); // authored order
      // pick the authored index of the correct option; stored/read back untouched
      await saveAnswer(tenant, userId, { attemptId: attempt.id, questionId: q.id, answer: { selected: q.correct }, client_revision: 0 });
      expect(await storedAnswer(attempt.id, q.id)).toEqual({ selected: q.correct });
      expect(answerOf(await getAttemptForCandidate(tenant, attempt.id, userId), q.id)).toEqual({ selected: q.correct });
    }
    await submitAttempt(tenant, userId, attempt.id);
    const s = await sup((c) =>
      c.query(`SELECT total_earned::float e, total_max::float m FROM attempt_scores WHERE attempt_id=$1`, [attempt.id]).then((r) => r.rows[0]),
    );
    expect(s).toEqual({ e: 40, m: 40 });
  });
});
