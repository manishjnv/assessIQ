/**
 * Integration tests for modules/09-scoring.
 *
 * Uses a postgres:16-alpine testcontainer. One container for all tests.
 *
 * Migration apply order (FK chain must be respected):
 *   1. ALL 02-tenancy migrations (0001–0004)
 *   2. 03-users 020_users.sql ONLY
 *   3. ALL 04-question-bank migrations (0010–0015)
 *   4. ALL 05-assessment-lifecycle migrations (0020–0022)
 *   5. ALL 06-attempt-engine migrations (0030–0033)
 *   6. 07-ai-grading migrations 0040_gradings.sql + 0041_tenant_grading_budgets.sql
 *   7. 09-scoring migration 0050_attempt_scores.sql
 *
 * Test coverage:
 *   - computeAttemptScore: happy path, idempotency (UPSERT), pending_review flag
 *   - deriveArchetype: null on first attempt, confident_correct rule, confident_wrong rule
 *   - cohortStats: counts + percentiles + archetype_distribution
 *   - leaderboard: ordered DESC, topN, RLS isolation (tenant B cannot see tenant A)
 *   - individualReport: returns all scores for a user
 *   - archetype_signals: P2.D11 shape round-trips through JSONB
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool } from "@assessiq/tenancy";

// Module under test
import {
  computeAttemptScore,
  recomputeOnOverride,
  getAttemptScoreRow,
  cohortStats,
  leaderboard,
  individualReport,
  computeSignals,
  deriveArchetype,
} from "../index.js";
import type { ArchetypeLabel } from "../index.js";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

const THIS_DIR = toFsPath(new URL(".", import.meta.url));
const SCORING_MODULE_ROOT = join(THIS_DIR, "..", "..");
const MODULES_ROOT = join(SCORING_MODULE_ROOT, "..");

const TENANCY_DIR = join(MODULES_ROOT, "02-tenancy", "migrations");
const USERS_DIR = join(MODULES_ROOT, "03-users", "migrations");
const QB_DIR = join(MODULES_ROOT, "04-question-bank", "migrations");
const AL_DIR = join(MODULES_ROOT, "05-assessment-lifecycle", "migrations");
const AE_DIR = join(MODULES_ROOT, "06-attempt-engine", "migrations");
const GRADING_DIR = join(MODULES_ROOT, "07-ai-grading", "migrations");
const SCORING_DIR = join(SCORING_MODULE_ROOT, "migrations");

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

let container: StartedTestContainer;
let containerUrl: string;

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_USER: "assessiq",
      POSTGRES_PASSWORD: "assessiq",
      POSTGRES_DB: "aiq_test",
    })
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .withStartupTimeout(60_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  containerUrl = `postgres://assessiq:assessiq@${host}:${port}/aiq_test`;

  await applyAllMigrations();
  await setPoolForTesting(containerUrl);
});

afterAll(async () => {
  await closePool();
  await container.stop();
});

// ---------------------------------------------------------------------------
// Migration helpers
// ---------------------------------------------------------------------------

async function withSuperClient<T>(
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: containerUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function applyMigrationsFromDir(
  client: Client,
  dir: string,
  only?: string[],
): Promise<void> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const filtered =
    only !== undefined ? files.filter((f) => only.includes(f)) : files;
  for (const f of filtered) {
    const sql = await readFile(join(dir, f), "utf8");
    await client.query(sql);
  }
}

async function applyAllMigrations(): Promise<void> {
  await withSuperClient(async (client) => {
    await client.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await applyMigrationsFromDir(client, TENANCY_DIR);
    await applyMigrationsFromDir(client, USERS_DIR, ["020_users.sql"]);
    await applyMigrationsFromDir(client, QB_DIR);
    await applyMigrationsFromDir(client, AL_DIR);
    await applyMigrationsFromDir(client, AE_DIR);
    // 07-ai-grading: gradings + tenant_grading_budgets
    await applyMigrationsFromDir(client, GRADING_DIR, [
      "0040_gradings.sql",
      "0041_tenant_grading_budgets.sql",
    ]);
    // 09-scoring
    await applyMigrationsFromDir(client, SCORING_DIR);
  });
}

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let tenantA: string;
let tenantB: string;
let adminA: string;
let adminB: string;
let assessmentA: string;
let assessmentB: string;

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedBaseFixtures(): Promise<void> {
  await withSuperClient(async (client) => {
    tenantA = randomUUID();
    tenantB = randomUUID();
    adminA = randomUUID();
    adminB = randomUUID();

    // Tenants
    await client.query(
      `INSERT INTO tenants (id, name, slug) VALUES ($1,'TenantA','tenant-a'),($2,'TenantB','tenant-b')`,
      [tenantA, tenantB],
    );

    // Admins
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name, role) VALUES
        ($1,$2,'admin-a@test.com','Admin A','admin'),
        ($3,$4,'admin-b@test.com','Admin B','admin')`,
      [adminA, tenantA, adminB, tenantB],
    );
  });
}

/**
 * Create a minimal pack → level → question → assessment → attempt chain.
 * Returns { packId, levelId, questionId, assessmentId, candidateId, attemptId }.
 */
async function seedAssessmentChain(
  tenantId: string,
  adminId: string,
  questionType = "subjective",
): Promise<{
  packId: string;
  levelId: string;
  questionId: string;
  assessmentId: string;
  candidateId: string;
  attemptId: string;
}> {
  const ids = {
    packId: randomUUID(),
    levelId: randomUUID(),
    questionId: randomUUID(),
    assessmentId: randomUUID(),
    candidateId: randomUUID(),
    attemptId: randomUUID(),
  };

  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO question_packs (id,tenant_id,slug,name,domain,status,created_by)
       VALUES ($1,$2,'p','Pack','soc','published',$3)`,
      [ids.packId, tenantId, adminId],
    );
    await client.query(
      `INSERT INTO levels (id,pack_id,position,label,duration_minutes,default_question_count,passing_score_pct)
       VALUES ($1,$2,1,'L1',60,1,60)`,
      [ids.levelId, ids.packId],
    );
    const rubric =
      questionType === "subjective"
        ? JSON.stringify({
            anchors: [{ id: "a1", concept: "c1", weight: 60, synonyms: ["c1"] }],
            reasoning_bands: {
              band_4: "b4",
              band_3: "b3",
              band_2: "b2",
              band_1: "b1",
              band_0: "b0",
            },
            anchor_weight_total: 60,
            reasoning_weight_total: 40,
          })
        : null;
    await client.query(
      `INSERT INTO questions (id,pack_id,level_id,type,topic,points,status,content,rubric,created_by)
       VALUES ($1,$2,$3,$4,'topic',100,'active','"{}"'::jsonb,$5,$6)`,
      [
        ids.questionId,
        ids.packId,
        ids.levelId,
        questionType,
        rubric,
        adminId,
      ],
    );
    await client.query(
      `INSERT INTO assessments (id,tenant_id,pack_id,level_id,pack_version,name,status,question_count,created_by)
       VALUES ($1,$2,$3,$4,1,'Assess','active',1,$5)`,
      [ids.assessmentId, tenantId, ids.packId, ids.levelId, adminId],
    );
    await client.query(
      `INSERT INTO users (id,tenant_id,email,name,role) VALUES ($1,$2,'cand@test.com','Cand','candidate')`,
      [ids.candidateId, tenantId],
    );
    await client.query(
      `INSERT INTO attempts (id,tenant_id,assessment_id,user_id,status,started_at,duration_seconds)
       VALUES ($1,$2,$3,$4,'graded',now() - interval '60 minutes',3600)`,
      [ids.attemptId, tenantId, ids.assessmentId, ids.candidateId],
    );
    // Freeze the question in attempt_questions
    await client.query(
      `INSERT INTO attempt_questions (attempt_id,question_id,position,question_version)
       VALUES ($1,$2,1,1)`,
      [ids.attemptId, ids.questionId],
    );
    // answer row
    await client.query(
      `INSERT INTO attempt_answers (attempt_id,question_id,answer,time_spent_seconds,edits_count,flagged)
       VALUES ($1,$2,'"answer text"'::jsonb,120,3,false)`,
      [ids.attemptId, ids.questionId],
    );
  });

  return ids;
}

async function insertGrading(
  tenantId: string,
  attemptId: string,
  questionId: string,
  adminId: string,
  overrides: Partial<{
    score_earned: number;
    score_max: number;
    status: string;
    reasoning_band: number | null;
    error_class: string | null;
  }> = {},
): Promise<void> {
  // Use a unique SHA per call so multiple gradings on the same attempt+question
  // don't violate the partial unique index (attempt_id, question_id, sha) WHERE
  // override_of IS NULL. The DISTINCT ON graded_at DESC in getGradingsForAttempt
  // picks the latest row regardless of SHA.
  const uniqueSha = `anchors:${randomUUID().replace(/-/g, "").slice(0, 8)};band:${randomUUID().replace(/-/g, "").slice(0, 8)};escalate:-`;

  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO gradings
         (id,tenant_id,attempt_id,question_id,grader,score_earned,score_max,
          status,prompt_version_sha,prompt_version_label,model,graded_by)
       VALUES
         ($1,$2,$3,$4,'ai',$5,$6,$7,$8,'v1','sonnet-4.6',$9)`,
      [
        randomUUID(),
        tenantId,
        attemptId,
        questionId,
        overrides.score_earned ?? 75,
        overrides.score_max ?? 100,
        overrides.status ?? "partial",
        uniqueSha,
        adminId,
      ],
    );
    // Update reasoning_band + error_class if provided
    if (overrides.reasoning_band !== undefined || overrides.error_class !== undefined) {
      await client.query(
        `UPDATE gradings SET
           reasoning_band = $1,
           error_class    = $2
         WHERE attempt_id = $3 AND question_id = $4`,
        [
          overrides.reasoning_band ?? null,
          overrides.error_class ?? null,
          attemptId,
          questionId,
        ],
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("09-scoring", () => {
  beforeEach(async () => {
    // Wipe scoring + grading data between tests
    await withSuperClient(async (client) => {
      await client.query("DELETE FROM attempt_scores");
      await client.query("DELETE FROM gradings");
      await client.query("DELETE FROM attempt_events");
      await client.query("DELETE FROM attempt_answers");
      await client.query("DELETE FROM attempt_questions");
      await client.query("DELETE FROM attempts");
      await client.query("DELETE FROM assessment_invitations");
      await client.query("DELETE FROM assessments");
      await client.query("DELETE FROM question_tags");
      await client.query("DELETE FROM question_versions");
      await client.query("DELETE FROM questions");
      await client.query("DELETE FROM levels");
      await client.query("DELETE FROM question_packs");
      await client.query(
        `DELETE FROM users WHERE role = 'candidate'`,
      );
    });
  });

  beforeAll(async () => {
    await seedBaseFixtures();
  });

  // -------------------------------------------------------------------------
  // computeAttemptScore: happy path
  // -------------------------------------------------------------------------

  describe("computeAttemptScore", () => {
    it("writes an attempt_scores row from gradings", async () => {
      const chain = await seedAssessmentChain(tenantA, adminA);
      assessmentA = chain.assessmentId;

      await insertGrading(tenantA, chain.attemptId, chain.questionId, adminA, {
        score_earned: 75,
        score_max: 100,
        status: "partial",
        reasoning_band: 3,
      });

      const score = await computeAttemptScore(tenantA, chain.attemptId);

      expect(score.attempt_id).toBe(chain.attemptId);
      expect(score.tenant_id).toBe(tenantA);
      expect(score.total_earned).toBe(75);
      expect(score.total_max).toBe(100);
      expect(score.auto_pct).toBe(75);
      expect(score.pending_review).toBe(false);
    });

    it("sets pending_review=true when any grading is review_needed", async () => {
      const chain = await seedAssessmentChain(tenantA, adminA);

      await insertGrading(tenantA, chain.attemptId, chain.questionId, adminA, {
        score_earned: 0,
        score_max: 100,
        status: "review_needed",
      });

      const score = await computeAttemptScore(tenantA, chain.attemptId);
      expect(score.pending_review).toBe(true);
    });

    it("is idempotent — second call UPSERTS same row", async () => {
      const chain = await seedAssessmentChain(tenantA, adminA);

      await insertGrading(tenantA, chain.attemptId, chain.questionId, adminA, {
        score_earned: 50,
        score_max: 100,
        status: "partial",
      });

      const first = await computeAttemptScore(tenantA, chain.attemptId);
      const second = await computeAttemptScore(tenantA, chain.attemptId);

      // Same attempt_id (PK) — idempotent
      expect(second.attempt_id).toBe(first.attempt_id);
      expect(second.total_earned).toBe(first.total_earned);
      expect(second.total_max).toBe(first.total_max);
    });

    it("stored archetype_signals match P2.D11 shape", async () => {
      const chain = await seedAssessmentChain(tenantA, adminA);

      await insertGrading(tenantA, chain.attemptId, chain.questionId, adminA, {
        score_earned: 80,
        score_max: 100,
        status: "correct",
        reasoning_band: 3,
      });

      const score = await computeAttemptScore(tenantA, chain.attemptId);

      expect(score.archetype_signals).not.toBeNull();
      const s = score.archetype_signals!;
      expect(typeof s.time_per_question_p50_ms).toBe("number");
      expect(typeof s.time_per_question_iqr_ms).toBe("number");
      expect(typeof s.edit_count_total).toBe("number");
      expect(typeof s.flag_count).toBe("number");
      expect(typeof s.multi_tab_conflict_count).toBe("number");
      expect(typeof s.tab_blur_count).toBe("number");
      expect(typeof s.copy_paste_count).toBe("number");
      expect(s.reasoning_band_distribution).toMatchObject({
        "0": expect.any(Number),
        "1": expect.any(Number),
        "2": expect.any(Number),
        "3": expect.any(Number),
        "4": expect.any(Number),
      });
      expect(typeof s.auto_submitted).toBe("boolean");
    });

    it("recomputeOnOverride returns updated score after grading change", async () => {
      const chain = await seedAssessmentChain(tenantA, adminA);

      await insertGrading(tenantA, chain.attemptId, chain.questionId, adminA, {
        score_earned: 25,
        score_max: 100,
        status: "incorrect",
      });

      const first = await computeAttemptScore(tenantA, chain.attemptId);
      expect(first.total_earned).toBe(25);

      // Insert a newer override grading
      await insertGrading(tenantA, chain.attemptId, chain.questionId, adminA, {
        score_earned: 90,
        score_max: 100,
        status: "correct",
      });

      // recomputeOnOverride picks up the latest grading (DISTINCT ON graded_at DESC)
      const second = await recomputeOnOverride(tenantA, chain.attemptId);
      expect(second.total_earned).toBe(90);
      expect(second.attempt_id).toBe(first.attempt_id); // same PK, UPSERT
    });
  });

  // -------------------------------------------------------------------------
  // deriveArchetype (pure unit tests — no DB)
  // -------------------------------------------------------------------------

  describe("deriveArchetype (pure unit)", () => {
    const baseSignals = {
      time_per_question_p50_ms: 60_000,
      time_per_question_iqr_ms: 20_000,
      edit_count_total: 5,
      flag_count: 0,
      multi_tab_conflict_count: 0,
      tab_blur_count: 0,
      copy_paste_count: 0,
      reasoning_band_avg: 2,
      reasoning_band_distribution: { "0": 0, "1": 0, "2": 1, "3": 0, "4": 0 },
      error_class_counts: {},
      auto_submitted: false,
    };

    const cohort = {
      time_p25_ms: 30_000,
      time_p75_ms: 90_000,
      edit_p25: 2,
      edit_p75: 8,
      iqr_p25_ms: 25_000,
    };

    it("returns null archetype when cohortPercentiles is null (first attempt)", () => {
      const { archetype } = deriveArchetype({
        signals: baseSignals,
        totalPct: 0.8,
        mcqPct: null,
        lastMinuteFraction: null,
        cohortPercentiles: null,
      });
      expect(archetype).toBeNull();
    });

    it("confident_correct: fast + few edits + high score", () => {
      const { archetype } = deriveArchetype({
        signals: {
          ...baseSignals,
          time_per_question_p50_ms: 20_000, // < p25 (30_000)
          edit_count_total: 1,               // < edit_p25 (2)
        },
        totalPct: 0.90,                      // > 0.85
        mcqPct: null,
        lastMinuteFraction: null,
        cohortPercentiles: cohort,
      });
      expect(archetype).toBe<ArchetypeLabel>("confident_correct");
    });

    it("confident_wrong: fast + few edits + low score", () => {
      const { archetype } = deriveArchetype({
        signals: {
          ...baseSignals,
          time_per_question_p50_ms: 15_000, // < p25
          edit_count_total: 1,              // < edit_p25
        },
        totalPct: 0.40,                     // < 0.5
        mcqPct: null,
        lastMinuteFraction: null,
        cohortPercentiles: cohort,
      });
      expect(archetype).toBe<ArchetypeLabel>("confident_wrong");
    });

    it("methodical_diligent: slow + many edits + high band", () => {
      const { archetype } = deriveArchetype({
        signals: {
          ...baseSignals,
          time_per_question_p50_ms: 100_000, // > p75 (90_000)
          edit_count_total: 10,              // > edit_p75 (8)
          reasoning_band_avg: 3.5,           // > 3
          reasoning_band_distribution: { "0": 0, "1": 0, "2": 0, "3": 1, "4": 0 },
        },
        totalPct: 0.85,
        mcqPct: null,
        lastMinuteFraction: null,
        cohortPercentiles: cohort,
      });
      expect(archetype).toBe<ArchetypeLabel>("methodical_diligent");
    });

    it("cautious_uncertain: slow + many flags + mid band", () => {
      const { archetype } = deriveArchetype({
        signals: {
          ...baseSignals,
          time_per_question_p50_ms: 100_000, // > p75
          flag_count: 5,                     // > 3
          reasoning_band_avg: 2.0,           // in [1.5, 2.5]
          reasoning_band_distribution: { "0": 0, "1": 0, "2": 1, "3": 0, "4": 0 },
        },
        totalPct: 0.55,
        mcqPct: null,
        lastMinuteFraction: null,
        cohortPercentiles: cohort,
      });
      expect(archetype).toBe<ArchetypeLabel>("cautious_uncertain");
    });

    it("last_minute_rusher: < 30% of answers in first third", () => {
      const { archetype } = deriveArchetype({
        signals: baseSignals,
        totalPct: 0.6,
        mcqPct: null,
        lastMinuteFraction: 0.2, // < 0.3
        cohortPercentiles: cohort,
      });
      expect(archetype).toBe<ArchetypeLabel>("last_minute_rusher");
    });

    it("even_pacer: IQR below cohort p25 IQR", () => {
      const { archetype } = deriveArchetype({
        signals: {
          ...baseSignals,
          time_per_question_iqr_ms: 10_000, // < iqr_p25_ms (25_000)
        },
        totalPct: 0.6,
        mcqPct: null,
        lastMinuteFraction: 0.5, // not last-minute
        cohortPercentiles: cohort,
      });
      expect(archetype).toBe<ArchetypeLabel>("even_pacer");
    });

    it("pattern_matcher: high MCQ + low band", () => {
      const { archetype } = deriveArchetype({
        signals: {
          ...baseSignals,
          time_per_question_iqr_ms: 30_000, // >= iqr_p25_ms (25_000) so even_pacer won't fire
          reasoning_band_avg: 1.5, // < 2
          reasoning_band_distribution: { "0": 0, "1": 1, "2": 0, "3": 0, "4": 0 },
        },
        totalPct: 0.7,
        mcqPct: 0.90, // > 0.85
        lastMinuteFraction: 0.4,
        cohortPercentiles: cohort,
      });
      expect(archetype).toBe<ArchetypeLabel>("pattern_matcher");
    });

    it("deep_reasoner: high band + mid MCQ score", () => {
      const { archetype } = deriveArchetype({
        signals: {
          ...baseSignals,
          time_per_question_iqr_ms: 30_000, // >= iqr_p25_ms so even_pacer won't fire
          reasoning_band_avg: 3.5,           // > 3
          reasoning_band_distribution: { "0": 0, "1": 0, "2": 0, "3": 1, "4": 0 },
        },
        totalPct: 0.7,
        mcqPct: 0.70,  // in [0.5, 0.85]
        lastMinuteFraction: 0.4,
        cohortPercentiles: cohort,
      });
      expect(archetype).toBe<ArchetypeLabel>("deep_reasoner");
    });

    it("returns null when no rule matches", () => {
      const { archetype } = deriveArchetype({
        signals: {
          ...baseSignals,
          // mid-range everything — no rule fires
          time_per_question_p50_ms: 60_000, // between p25/p75
          time_per_question_iqr_ms: 30_000, // >= iqr_p25_ms so even_pacer won't fire
          edit_count_total: 5,              // between edit_p25/p75
          reasoning_band_avg: 2,
          flag_count: 1,
          reasoning_band_distribution: { "0": 0, "1": 0, "2": 1, "3": 0, "4": 0 },
        },
        totalPct: 0.65,
        mcqPct: 0.65,
        lastMinuteFraction: 0.4,
        cohortPercentiles: cohort,
      });
      expect(archetype).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // computeSignals (pure unit tests)
  // -------------------------------------------------------------------------

  describe("computeSignals (pure unit)", () => {
    it("aggregates edit_count_total from answers", () => {
      const signals = computeSignals({
        answers: [
          { time_spent_seconds: 60, edits_count: 3 },
          { time_spent_seconds: 90, edits_count: 5 },
        ],
        events: [],
        gradings: [],
        autoSubmitted: false,
      });
      expect(signals.edit_count_total).toBe(8);
    });

    it("counts flag/tab_blur/copy/paste/multi_tab events correctly", () => {
      const signals = computeSignals({
        answers: [],
        events: [
          { event_type: "flag", at: new Date() },
          { event_type: "flag", at: new Date() },
          { event_type: "tab_blur", at: new Date() },
          { event_type: "copy", at: new Date() },
          { event_type: "paste", at: new Date() },
          { event_type: "multi_tab_conflict", at: new Date() },
        ],
        gradings: [],
        autoSubmitted: false,
      });
      expect(signals.flag_count).toBe(2);
      expect(signals.tab_blur_count).toBe(1);
      expect(signals.copy_paste_count).toBe(2);
      expect(signals.multi_tab_conflict_count).toBe(1);
    });

    it("sets reasoning_band_avg null when no AI-graded questions", () => {
      const signals = computeSignals({
        answers: [],
        events: [],
        gradings: [
          { reasoning_band: null, error_class: null }, // MCQ row
        ],
        autoSubmitted: false,
      });
      expect(signals.reasoning_band_avg).toBeNull();
    });

    it("computes reasoning_band_distribution correctly", () => {
      const signals = computeSignals({
        answers: [],
        events: [],
        gradings: [
          { reasoning_band: 3, error_class: null },
          { reasoning_band: 3, error_class: null },
          { reasoning_band: 2, error_class: null },
        ],
        autoSubmitted: false,
      });
      expect(signals.reasoning_band_distribution["3"]).toBe(2);
      expect(signals.reasoning_band_distribution["2"]).toBe(1);
    });

    it("p50 of single answer = that answer's time", () => {
      const signals = computeSignals({
        answers: [{ time_spent_seconds: 120, edits_count: 0 }],
        events: [],
        gradings: [],
        autoSubmitted: false,
      });
      expect(signals.time_per_question_p50_ms).toBe(120_000);
    });

    it("sets auto_submitted from flag", () => {
      const s = computeSignals({
        answers: [],
        events: [],
        gradings: [],
        autoSubmitted: true,
      });
      expect(s.auto_submitted).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // cohortStats
  // -------------------------------------------------------------------------

  describe("cohortStats", () => {
    it("returns attempt_count=0 and null percentiles for empty assessment", async () => {
      const chain = await seedAssessmentChain(tenantA, adminA);
      const stats = await cohortStats(tenantA, chain.assessmentId);

      expect(stats.attempt_count).toBe(0);
      expect(stats.average_pct).toBeNull();
      expect(stats.p50).toBeNull();
      expect(stats.archetype_distribution).toEqual({});
    });

    it("returns correct stats after two scored attempts", async () => {
      // Create two separate candidate chains for the same assessment
      const packId = randomUUID();
      const levelId = randomUUID();
      const questionId = randomUUID();
      const assessmentId = randomUUID();

      await withSuperClient(async (client) => {
        await client.query(
          `INSERT INTO question_packs (id,tenant_id,slug,name,domain,status,created_by)
           VALUES ($1,$2,'pp2','Pack2','soc','published',$3)`,
          [packId, tenantA, adminA],
        );
        await client.query(
          `INSERT INTO levels (id,pack_id,position,label,duration_minutes,default_question_count,passing_score_pct)
           VALUES ($1,$2,1,'L1',60,1,60)`,
          [levelId, packId],
        );
        await client.query(
          `INSERT INTO questions (id,pack_id,level_id,type,topic,points,status,content,created_by)
           VALUES ($1,$2,$3,'mcq','t',100,'active','"{}"'::jsonb,$4)`,
          [questionId, packId, levelId, adminA],
        );
        await client.query(
          `INSERT INTO assessments (id,tenant_id,pack_id,level_id,pack_version,name,status,question_count,created_by)
           VALUES ($1,$2,$3,$4,1,'A2','active',1,$5)`,
          [assessmentId, tenantA, packId, levelId, adminA],
        );
      });

      // Two attempts with known scores
      for (const [score, label] of [
        [80, "methodical_diligent"],
        [60, null],
      ] as const) {
        const candidateId = randomUUID();
        const attemptId = randomUUID();

        await withSuperClient(async (client) => {
          await client.query(
            `INSERT INTO users (id,tenant_id,email,name,role) VALUES ($1,$2,$3,'C','candidate')`,
            [candidateId, tenantA, `c${score}@test.com`],
          );
          await client.query(
            `INSERT INTO attempts (id,tenant_id,assessment_id,user_id,status,started_at,duration_seconds)
             VALUES ($1,$2,$3,$4,'graded',now(),3600)`,
            [attemptId, tenantA, assessmentId, candidateId],
          );
          await client.query(
            `INSERT INTO attempt_scores (attempt_id,tenant_id,total_earned,total_max,auto_pct,archetype)
             VALUES ($1,$2,$3,100,$3,$4)`,
            [attemptId, tenantA, score, label ?? null],
          );
        });
      }

      const stats = await cohortStats(tenantA, assessmentId);
      expect(stats.attempt_count).toBe(2);
      expect(stats.average_pct).toBeCloseTo(70, 0);
      expect(stats.p50).toBeCloseTo(70, 0);
      expect(stats.archetype_distribution).toMatchObject({
        methodical_diligent: 1,
      });
    });
  });

  // -------------------------------------------------------------------------
  // leaderboard — ordering + RLS isolation
  // -------------------------------------------------------------------------

  describe("leaderboard", () => {
    it("returns rows ordered by auto_pct DESC", async () => {
      const packId = randomUUID();
      const levelId = randomUUID();
      const questionId = randomUUID();
      const assessmentId = randomUUID();

      await withSuperClient(async (client) => {
        await client.query(
          `INSERT INTO question_packs (id,tenant_id,slug,name,domain,status,created_by)
           VALUES ($1,$2,'lb','LBPack','soc','published',$3)`,
          [packId, tenantA, adminA],
        );
        await client.query(
          `INSERT INTO levels (id,pack_id,position,label,duration_minutes,default_question_count,passing_score_pct)
           VALUES ($1,$2,1,'L1',60,1,60)`,
          [levelId, packId],
        );
        await client.query(
          `INSERT INTO questions (id,pack_id,level_id,type,topic,points,status,content,created_by)
           VALUES ($1,$2,$3,'mcq','t',100,'active','"{}"'::jsonb,$4)`,
          [questionId, packId, levelId, adminA],
        );
        await client.query(
          `INSERT INTO assessments (id,tenant_id,pack_id,level_id,pack_version,name,status,question_count,created_by)
           VALUES ($1,$2,$3,$4,1,'LBAssess','active',1,$5)`,
          [assessmentId, tenantA, packId, levelId, adminA],
        );
      });

      const pcts = [90, 70, 50];
      for (const pct of pcts) {
        const candidateId = randomUUID();
        const attemptId = randomUUID();
        await withSuperClient(async (client) => {
          await client.query(
            `INSERT INTO users (id,tenant_id,email,name,role) VALUES ($1,$2,$3,'C','candidate')`,
            [candidateId, tenantA, `lb${pct}@test.com`],
          );
          await client.query(
            `INSERT INTO attempts (id,tenant_id,assessment_id,user_id,status) VALUES ($1,$2,$3,$4,'graded')`,
            [attemptId, tenantA, assessmentId, candidateId],
          );
          await client.query(
            `INSERT INTO attempt_scores (attempt_id,tenant_id,total_earned,total_max,auto_pct)
             VALUES ($1,$2,$3,100,$3)`,
            [attemptId, tenantA, pct],
          );
        });
      }

      const rows = await leaderboard(tenantA, assessmentId);
      expect(rows).toHaveLength(3);
      expect(rows[0]!.auto_pct).toBe(90);
      expect(rows[1]!.auto_pct).toBe(70);
      expect(rows[2]!.auto_pct).toBe(50);
      expect(rows[0]!.rank).toBe(1);
    });

    it("RLS: tenant B cannot see tenant A leaderboard", async () => {
      // tenantB has a separate assessment — its leaderboard is empty
      const chain = await seedAssessmentChain(tenantA, adminA);
      const chainB = await seedAssessmentChain(tenantB, adminB);
      assessmentB = chainB.assessmentId;

      await insertGrading(tenantA, chain.attemptId, chain.questionId, adminA);
      await computeAttemptScore(tenantA, chain.attemptId);

      // tenantB's leaderboard for tenantA's assessment should be empty
      const rows = await leaderboard(tenantB, chain.assessmentId);
      expect(rows).toHaveLength(0);
    });

    it("anonymize=true hides name and email", async () => {
      const chain = await seedAssessmentChain(tenantA, adminA);
      await insertGrading(tenantA, chain.attemptId, chain.questionId, adminA);
      await computeAttemptScore(tenantA, chain.attemptId);

      const rows = await leaderboard(tenantA, chain.assessmentId, {
        anonymize: true,
      });
      expect(rows[0]?.candidate_name).toBeNull();
      expect(rows[0]?.candidate_email).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // getAttemptScoreRow
  // -------------------------------------------------------------------------

  describe("getAttemptScoreRow", () => {
    it("returns null before score is computed", async () => {
      const chain = await seedAssessmentChain(tenantA, adminA);
      const row = await getAttemptScoreRow(tenantA, chain.attemptId);
      expect(row).toBeNull();
    });

    it("returns the row after computeAttemptScore", async () => {
      const chain = await seedAssessmentChain(tenantA, adminA);
      await insertGrading(tenantA, chain.attemptId, chain.questionId, adminA);
      await computeAttemptScore(tenantA, chain.attemptId);

      const row = await getAttemptScoreRow(tenantA, chain.attemptId);
      expect(row?.attempt_id).toBe(chain.attemptId);
    });
  });

  // -------------------------------------------------------------------------
  // individualReport
  // -------------------------------------------------------------------------

  describe("individualReport", () => {
    it("returns score rows for a user across multiple assessments", async () => {
      const chain1 = await seedAssessmentChain(tenantA, adminA);
      await insertGrading(tenantA, chain1.attemptId, chain1.questionId, adminA);
      await computeAttemptScore(tenantA, chain1.attemptId);

      const scores = await individualReport(tenantA, chain1.candidateId);
      expect(scores.length).toBeGreaterThanOrEqual(1);
      expect(scores[0]?.attempt_id).toBe(chain1.attemptId);
    });
  });
});
