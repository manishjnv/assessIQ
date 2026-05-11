/**
 * G3.D audit-write sweep — coverage tests for modules/09-scoring.
 *
 * Mirrors modules/05-assessment-lifecycle/src/__tests__/audit-writes.test.ts.
 *
 * modules/09-scoring has no classic admin-mutation sites (no override/adjust
 * POST routes). The single audit-wired site is recomputeOnOverride(), which
 * is called by modules/07-ai-grading after an admin grading override. That
 * function gains an optional actorUserId parameter: when supplied (admin path)
 * an attempt_scores.recomputed_by_admin audit row is written in the same
 * transaction as the upsert; when absent (system pipeline path) no row is
 * emitted.
 *
 * Migration order: tenancy → users (020 only) → audit-log → qb → al → ae →
 *   grading (0040+0041) → scoring (0050).
 * Roles assessiq_app and assessiq_system are created so RLS policies work.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { ACTION_CATALOG } from "@assessiq/audit-log";
import { recomputeOnOverride } from "../service.js";

// ---------------------------------------------------------------------------
// Path helpers (Windows: strip leading slash before drive letter)
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

const THIS_DIR = toFsPath(new URL(".", import.meta.url));
const SCORING_MODULE_ROOT = join(THIS_DIR, "..", "..");
const MODULES_ROOT = join(SCORING_MODULE_ROOT, "..");

const TENANCY_DIR = join(MODULES_ROOT, "02-tenancy", "migrations");
const USERS_DIR = join(MODULES_ROOT, "03-users", "migrations");
const AUDIT_DIR = join(MODULES_ROOT, "14-audit-log", "migrations");
const QB_DIR = join(MODULES_ROOT, "04-question-bank", "migrations");
const AL_DIR = join(MODULES_ROOT, "05-assessment-lifecycle", "migrations");
const AE_DIR = join(MODULES_ROOT, "06-attempt-engine", "migrations");
const GRADING_DIR = join(MODULES_ROOT, "07-ai-grading", "migrations");
const SCORING_DIR = join(SCORING_MODULE_ROOT, "migrations");

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let container: StartedTestContainer;
let containerUrl: string;
let tenantA: string;
let adminA: string;

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function withSuperClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: containerUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

interface AuditRow {
  id: string;
  actor_user_id: string | null;
  actor_kind: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
}

async function queryAudit(tenantId: string, action?: string): Promise<AuditRow[]> {
  return withSuperClient(async (client) => {
    const params: unknown[] = [tenantId];
    let where = `tenant_id = $1`;
    if (action !== undefined) {
      params.push(action);
      where += ` AND action = $2`;
    }
    const result = await client.query<AuditRow>(
      `SELECT id::text, actor_user_id::text, actor_kind, action,
              entity_type, entity_id::text, before, after
         FROM audit_log
        WHERE ${where}
        ORDER BY at DESC`,
      params,
    );
    return result.rows;
  });
}

async function clearAudit(tenantId: string): Promise<void> {
  await withSuperClient(async (client) => {
    await client.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [tenantId]);
  });
}

// ---------------------------------------------------------------------------
// Global setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "test",
      POSTGRES_PASSWORD: "test",
      POSTGRES_DB: "aiq_scoring_audit_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  containerUrl = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_scoring_audit_test`;

  const [tenancyFiles, usersFiles, auditFiles, qbFiles, alFiles, aeFiles, gradingFiles, scoringFiles] =
    await Promise.all([
      readdir(TENANCY_DIR),
      readdir(USERS_DIR),
      readdir(AUDIT_DIR),
      readdir(QB_DIR),
      readdir(AL_DIR),
      readdir(AE_DIR),
      readdir(GRADING_DIR),
      readdir(SCORING_DIR),
    ]);

  const sqlOf = (dir: string, files: string[], only?: string[]) =>
    files
      .filter((f) => f.endsWith(".sql") && (only === undefined || only.includes(f)))
      .sort()
      .map((f) => ({ dir, file: f }));

  const migrations = [
    ...sqlOf(TENANCY_DIR, tenancyFiles),
    ...sqlOf(USERS_DIR, usersFiles, ["020_users.sql"]),
    ...sqlOf(AUDIT_DIR, auditFiles),
    ...sqlOf(QB_DIR, qbFiles),
    ...sqlOf(AL_DIR, alFiles),
    ...sqlOf(AE_DIR, aeFiles),
    ...sqlOf(GRADING_DIR, gradingFiles, ["0040_gradings.sql", "0041_tenant_grading_budgets.sql"]),
    ...sqlOf(SCORING_DIR, scoringFiles),
  ];

  await withSuperClient(async (client) => {
    await client.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assessiq_app') THEN
          CREATE ROLE assessiq_app;
        END IF;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assessiq_system') THEN
          CREATE ROLE assessiq_system BYPASSRLS;
        END IF;
      END $$;
    `);
    await client.query(`GRANT assessiq_app TO test`);
    await client.query(`GRANT assessiq_system TO test`);

    for (const { dir, file } of migrations) {
      const sql = await readFile(join(dir, file), "utf-8");
      await client.query(sql);
    }

    await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await client.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
  });

  await setPoolForTesting(containerUrl);

  tenantA = randomUUID();
  adminA = randomUUID();

  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, 'tenant-scoring-audit', 'Scoring Audit Tenant')`,
      [tenantA],
    );
    await client.query(
      `INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [tenantA],
    );
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status)
       VALUES ($1, $2, 'admin-scoring@example.com', 'Admin', 'admin', 'active')`,
      [adminA, tenantA],
    );
  });
}, 90_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedScoringChain(): Promise<{
  attemptId: string;
  assessmentId: string;
  questionId: string;
}> {
  const packId = randomUUID();
  const levelId = randomUUID();
  const questionId = randomUUID();
  const assessmentId = randomUUID();
  const candidateId = randomUUID();
  const attemptId = randomUUID();

  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by)
       VALUES ($1, $2, $3, 'Pack', 'soc', 'published', $4)`,
      [packId, tenantA, `sp-${randomUUID().slice(0, 8)}`, adminA],
    );
    await client.query(
      `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct)
       VALUES ($1, $2, 1, 'L1', 60, 1, 60)`,
      [levelId, packId],
    );
    await client.query(
      `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, created_by)
       VALUES ($1, $2, $3, 'mcq', 'topic', 100, 'active', '"test"'::jsonb, $4)`,
      [questionId, packId, levelId, adminA],
    );
    await client.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, created_by)
       VALUES ($1, $2, $3, $4, 1, 'Assess', 'active', 1, $5)`,
      [assessmentId, tenantA, packId, levelId, adminA],
    );
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status)
       VALUES ($1, $2, $3, 'Candidate', 'candidate', 'active')`,
      [candidateId, tenantA, `cand-${randomUUID().slice(0, 6)}@test.com`],
    );
    await client.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, duration_seconds)
       VALUES ($1, $2, $3, $4, 'graded', now() - interval '60 minutes', 3600)`,
      [attemptId, tenantA, assessmentId, candidateId],
    );
    await client.query(
      `INSERT INTO attempt_questions (attempt_id, question_id, position, question_version)
       VALUES ($1, $2, 1, 1)`,
      [attemptId, questionId],
    );
    await client.query(
      `INSERT INTO attempt_answers (attempt_id, question_id, answer, time_spent_seconds, edits_count, flagged)
       VALUES ($1, $2, '"answer"'::jsonb, 120, 2, false)`,
      [attemptId, questionId],
    );
    // Seed a grading row
    await client.query(
      `INSERT INTO gradings
         (id, tenant_id, attempt_id, question_id, grader, score_earned, score_max,
          status, prompt_version_sha, prompt_version_label, model, graded_by)
       VALUES ($1, $2, $3, $4, 'ai', 75, 100, 'partial', 'sha:test', 'v1', 'sonnet-4.6', $5)`,
      [randomUUID(), tenantA, attemptId, questionId, adminA],
    );
  });

  return { attemptId, assessmentId, questionId };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("G3.D audit writes — 09-scoring", () => {
  it("recomputeOnOverride with actorUserId writes attempt_scores.recomputed_by_admin audit row", async () => {
    const { attemptId } = await seedScoringChain();
    await clearAudit(tenantA);

    const score = await recomputeOnOverride(tenantA, attemptId, adminA);

    const rows = await queryAudit(tenantA, "attempt_scores.recomputed_by_admin");
    const row = rows.find((r) => r.entity_id === attemptId);
    expect(row).toBeDefined();
    expect(row!.actor_kind).toBe("user");
    expect(row!.actor_user_id).toBe(adminA);
    expect(row!.entity_type).toBe("attempt_score");
    const after = row!.after as Record<string, unknown>;
    expect(typeof after.auto_pct).toBe("number");
    expect(after.auto_pct).toBe(score.auto_pct);
    expect(typeof after.pending_review).toBe("boolean");
    expect(after.computed_at).toBe(score.computed_at);
  });

  it("before is null on first compute (INSERT-only — no prior row to snapshot)", async () => {
    const { attemptId } = await seedScoringChain();
    await clearAudit(tenantA);

    await recomputeOnOverride(tenantA, attemptId, adminA);

    const rows = await queryAudit(tenantA, "attempt_scores.recomputed_by_admin");
    const row = rows.find((r) => r.entity_id === attemptId);
    expect(row).toBeDefined();
    // No prior row → before column is NULL in DB.
    expect(row!.before).toBeNull();
  });

  it("before captures prior score on subsequent recompute", async () => {
    const { attemptId } = await seedScoringChain();

    // First compute — no actorUserId (system path, no audit row).
    const first = await recomputeOnOverride(tenantA, attemptId);
    await clearAudit(tenantA);

    // Second compute — with actorUserId (admin override path).
    await recomputeOnOverride(tenantA, attemptId, adminA);

    const rows = await queryAudit(tenantA, "attempt_scores.recomputed_by_admin");
    const row = rows.find((r) => r.entity_id === attemptId);
    expect(row).toBeDefined();
    const before = row!.before as Record<string, unknown>;
    // before should match the first compute's score.
    expect(before.auto_pct).toBe(first.auto_pct);
    expect(before.total_earned).toBe(first.total_earned);
    expect(before.total_max).toBe(first.total_max);
  });

  it("recomputeOnOverride without actorUserId writes NO audit row (system-triggered path)", async () => {
    const { attemptId } = await seedScoringChain();
    await clearAudit(tenantA);

    // System-triggered call — no actorUserId.
    await recomputeOnOverride(tenantA, attemptId);

    const rows = await queryAudit(tenantA);
    expect(rows.filter((r) => r.action.startsWith("attempt_scores."))).toHaveLength(0);
  });

  it("recomputeOnOverride on non-existent attemptId throws and writes NO audit row", async () => {
    await clearAudit(tenantA);
    const fakeId = randomUUID();

    await expect(recomputeOnOverride(tenantA, fakeId, adminA)).rejects.toThrow();

    const rows = await queryAudit(tenantA);
    expect(rows.filter((r) => r.action.startsWith("attempt_scores."))).toHaveLength(0);
  });

  it("attempt_scores.recomputed_by_admin is in ACTION_CATALOG", () => {
    // Runtime membership check — catches typos that compile but break DB inserts.
    expect(ACTION_CATALOG).toContain("attempt_scores.recomputed_by_admin");
  });

  it("service.ts contains exactly 1 auditInTx call-site (the recomputeOnOverride path)", async () => {
    const servicePath = join(SCORING_MODULE_ROOT, "src", "service.ts");
    const source = await readFile(servicePath, "utf-8");
    const matches = source.match(/auditInTx\(/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
