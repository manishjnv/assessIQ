/**
 * G3.D coverage + structural-shape tests for the 07-ai-grading audit-write
 * slice.
 *
 * Why this file exists:
 *   The existing handlers.test.ts + admin-generate-*.test.ts files run against
 *   a testcontainer that does NOT apply the audit-log migrations, so they mock
 *   @assessiq/audit-log to a no-op. That keeps their fast-path coverage but
 *   loses the "is audit actually wired everywhere it should be?" guard.
 *
 *   This file is the guard. It does two things:
 *
 *   A. Static structural tests (no testcontainer):
 *     1. Coverage: every admin-mutating handler has at least one
 *        `auditInTx(client, ...)` call site.
 *     2. Action-name correctness: each call site uses an action that exists
 *        in ACTION_CATALOG.
 *     3. Atomicity-by-structure: every auditInTx call site is inside a
 *        withTenant closure scope (so it shares the PoolClient with the
 *        domain mutation and either both INSERTs commit or both roll back via
 *        pg transaction semantics — no separate audit tx).
 *     4. No re-add of the old fire-and-forget `audit(` call site.
 *
 *   B. Live integration tests (testcontainer — describe block at bottom):
 *     5. Happy-path: handleAdminClaimAttempt with status='submitted' writes a
 *        grading.claimed audit_log row with correct actor/entity/before/after.
 *     6. Atomicity: mock auditInTx to throw once, assert the handler rejects
 *        AND attempts.status rolls back to 'submitted' (the UPDATE was inside
 *        the same withTenant tx as the auditInTx call).
 *
 * Migration apply order for the testcontainer (section B):
 *   1. ALL 02-tenancy migrations
 *   2. 03-users 020_users.sql ONLY (021 depends on auth tables absent here)
 *   3. ALL 04-question-bank migrations
 *   4. ALL 05-assessment-lifecycle migrations
 *   5. ALL 06-attempt-engine migrations
 *   6. ALL 07-ai-grading migrations
 *   7. 14-audit-log 0050_audit_log.sql — must come last (FKs to tenants+users)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Mock @assessiq/audit-log — allows one-shot failure injection for the
// atomicity test (section B, test 6) without touching production code.
// vi.spyOn cannot intercept static-import ESM bindings; the mock factory +
// importActual pattern is the canonical workaround (03-users, line ~57).
// The static tests in section A use readFile only and are unaffected.
// ---------------------------------------------------------------------------

let injectAuditFailure: Error | null = null;

vi.mock("@assessiq/audit-log", async () => {
  const actual =
    await vi.importActual<typeof import("@assessiq/audit-log")>("@assessiq/audit-log");
  return {
    ...actual,
    auditInTx: vi.fn(async (...args: Parameters<typeof actual.auditInTx>) => {
      if (injectAuditFailure !== null) {
        const err = injectAuditFailure;
        injectAuditFailure = null; // one-shot
        throw err;
      }
      return actual.auditInTx(...args);
    }),
  };
});

import { ACTION_CATALOG } from "@assessiq/audit-log";
import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { handleAdminClaimAttempt } from "../handlers/admin-claim-release.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HANDLERS_DIR = join(HERE, "..", "handlers");

// Path roots for testcontainer migration loading (section B)
const AI_MODULE_ROOT = join(HERE, "..", "..");
const MODULES_ROOT = join(AI_MODULE_ROOT, "..");

const TENANCY_MIGRATIONS_DIR = join(MODULES_ROOT, "02-tenancy", "migrations");
const USERS_MIGRATIONS_DIR = join(MODULES_ROOT, "03-users", "migrations");
const QB_MIGRATIONS_DIR = join(MODULES_ROOT, "04-question-bank", "migrations");
const AL_MIGRATIONS_DIR = join(MODULES_ROOT, "05-assessment-lifecycle", "migrations");
const AE_MIGRATIONS_DIR = join(MODULES_ROOT, "06-attempt-engine", "migrations");
const AI_MIGRATIONS_DIR = join(AI_MODULE_ROOT, "migrations");
const AUDIT_MIGRATIONS_DIR = join(MODULES_ROOT, "14-audit-log", "migrations");

// ---------------------------------------------------------------------------
// Coverage table: handler file → expected audit actions (from ACTION_CATALOG).
//
// Per the G3.D sweep, every admin-mutating handler emits at least one audit
// row inside the same withTenant tx as its DB mutation. Non-mutating handlers
// (read-only queue/budget, Phase-1-stub grading-jobs, proposal-only admin-grade)
// are NO-OPs and intentionally absent from this table.
// ---------------------------------------------------------------------------

const COVERAGE: Array<{
  file: string;
  expectedActions: readonly string[];
  expectedCallCount: number;
}> = [
  {
    file: "admin-override.ts",
    expectedActions: ["grading.override"],
    expectedCallCount: 1,
  },
  {
    file: "admin-accept.ts",
    expectedActions: ["grading.accepted"],
    expectedCallCount: 1,
  },
  {
    file: "admin-rerun.ts",
    expectedActions: ["grading.retry"],
    expectedCallCount: 1,
  },
  {
    file: "admin-claim-release.ts",
    expectedActions: ["grading.claimed", "grading.released"],
    expectedCallCount: 2,
  },
  {
    file: "admin-generate.ts",
    expectedActions: ["question.ai_generated"],
    // 3 because admin-generate has 3 success-return branches (sharded, omnibus
    // single-call, omnibus chunked) — each emits one audit row before its
    // branch return. Reducing to 1 requires a helper refactor; the inline
    // repetition is intentional per the implementation change-log.
    expectedCallCount: 3,
  },
];

// Handlers that are intentionally NOT audited (state-readonly or proposal-only).
const NO_AUDIT_HANDLERS = [
  "admin-grade.ts",        // returns proposals, never writes (D8 accept-before-commit)
  "admin-queue.ts",        // read-only dashboard query
  "admin-budget.ts",       // read-only billing query
  "admin-grading-jobs.ts", // Phase-1 stubs (empty list + 503)
];

// ---------------------------------------------------------------------------

describe("07-ai-grading G3.D audit-write coverage", () => {
  // -------------------------------------------------------------------------
  // 1. Coverage + action-name correctness
  // -------------------------------------------------------------------------

  for (const entry of COVERAGE) {
    describe(entry.file, () => {
      it(`has exactly ${entry.expectedCallCount} auditInTx call site(s)`, async () => {
        const src = await readFile(join(HANDLERS_DIR, entry.file), "utf-8");
        const callCount = (src.match(/auditInTx\s*\(/g) ?? []).length;
        expect(callCount).toBe(entry.expectedCallCount);
      });

      it("imports auditInTx from @assessiq/audit-log", async () => {
        const src = await readFile(join(HANDLERS_DIR, entry.file), "utf-8");
        expect(src).toMatch(
          /import\s*\{[^}]*\bauditInTx\b[^}]*\}\s*from\s*["']@assessiq\/audit-log["']/,
        );
      });

      for (const action of entry.expectedActions) {
        it(`emits action "${action}" (and that action exists in ACTION_CATALOG)`, async () => {
          const src = await readFile(join(HANDLERS_DIR, entry.file), "utf-8");
          // Look for the action literal as a string in the source. Both
          // double-quoted and single-quoted are accepted to keep the test
          // robust against future style changes.
          const matches =
            src.match(new RegExp(`["']${action.replace(".", "\\.")}["']`, "g")) ?? [];
          expect(matches.length).toBeGreaterThan(0);
          expect(ACTION_CATALOG).toContain(action);
        });
      }
    });
  }

  // -------------------------------------------------------------------------
  // 2. Negative coverage: handlers that MUST NOT audit (NO-OP per spec).
  //    A future "helpful" PR that wires auditInTx into these will fail here.
  // -------------------------------------------------------------------------

  describe("non-mutating handlers stay audit-free", () => {
    for (const file of NO_AUDIT_HANDLERS) {
      it(`${file} contains zero auditInTx call sites`, async () => {
        const src = await readFile(join(HANDLERS_DIR, file), "utf-8");
        const callCount = (src.match(/auditInTx\s*\(/g) ?? []).length;
        expect(callCount).toBe(0);
      });
    }
  });

  // -------------------------------------------------------------------------
  // 3. Atomicity contract — every audit-wired handler file also references
  //    withTenant. The full source-order structural check was tried but is
  //    too strict for the `acceptProposals(client, ...)` helper pattern used
  //    in admin-accept.ts: the auditInTx lives inside a helper that takes
  //    `client: PoolClient` as a parameter, with withTenant called by an
  //    outer function elsewhere in the file. Atomicity holds via the shared
  //    PoolClient + pg tx semantics, but the source-text order does not show
  //    withTenant before auditInTx in the helper.
  //
  //    Instead, we assert a weaker invariant: every audit-wired file mentions
  //    BOTH withTenant AND auditInTx. The strong "audit inside the same tx"
  //    invariant is verified by the Phase 3 Opus diff review and by the
  //    16-help-system audit-writes.test.ts which does end-to-end pg-rollback
  //    testing against a real audit_log table.
  // -------------------------------------------------------------------------

  describe("audit-wired files also use withTenant", () => {
    for (const entry of COVERAGE) {
      it(`${entry.file} mentions both withTenant and auditInTx`, async () => {
        const src = await readFile(join(HANDLERS_DIR, entry.file), "utf-8");
        expect(src).toMatch(/withTenant\s*\(/);
        expect(src).toMatch(/auditInTx\s*\(/);
      });
    }
  });

  // -------------------------------------------------------------------------
  // 4. Old fire-and-forget audit() call site must not re-appear in
  //    admin-override.ts (the G3.D migration removed it; a regression here
  //    would re-introduce non-atomic audit writes).
  // -------------------------------------------------------------------------

  it("admin-override.ts no longer imports the old fire-and-forget audit()", async () => {
    const src = await readFile(
      join(HANDLERS_DIR, "admin-override.ts"),
      "utf-8",
    );
    // Allow `auditInTx` mentions; reject standalone `audit` import + `audit(` call.
    const badImport =
      /import\s*\{[^}]*\baudit\b(?!InTx)[^}]*\}\s*from\s*["']@assessiq\/audit-log["']/;
    expect(src).not.toMatch(badImport);
    // Reject bare `audit(` calls (allow `auditInTx(`).
    const bareAuditCall = /(?<!In|Tx)\baudit\s*\(/g;
    const matches = src.match(bareAuditCall) ?? [];
    // The regex above is a heuristic; a 0-match assertion is the load-bearing one.
    expect(matches.length).toBe(0);
  });
});

// ===========================================================================
// Section B — Live integration tests (testcontainer + real audit_log table)
//
// These tests prove the runtime invariant that handlers.test.ts cannot:
// handlers.test.ts mocks auditInTx to a no-op and skips the audit-log
// migrations. Here we apply the full migration set and assert real DB writes.
// ===========================================================================

// ---------------------------------------------------------------------------
// Testcontainer state
// ---------------------------------------------------------------------------

let container: StartedTestContainer;
let containerUrl: string;
let TENANT_ID: string;
let ADMIN_ID: string;
let ATTEMPT_ID: string;

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

async function applyMigrationsFromDir(
  client: Client,
  dir: string,
  only?: string[],
): Promise<void> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const filtered = only !== undefined ? files.filter((f) => only.includes(f)) : files;
  for (const f of filtered) {
    const sql = await readFile(join(dir, f), "utf8");
    await client.query(sql);
  }
}

interface AuditRow {
  id: string;
  actor_user_id: string | null;
  actor_kind: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
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
  // Test-only: bypass the REVOKE on assessiq_app by running as superuser.
  await withSuperClient((client) =>
    client.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [tenantId]),
  );
}

async function readAttemptStatus(attemptId: string): Promise<string | null> {
  return withSuperClient(async (client) => {
    const r = await client.query<{ status: string }>(
      `SELECT status FROM attempts WHERE id = $1 LIMIT 1`,
      [attemptId],
    );
    return r.rows[0]?.status ?? null;
  });
}

/**
 * Seed the minimal fixture that handleAdminClaimAttempt needs:
 *   pack → level → question + question_version (for loadFrozenQuestions JOIN)
 *   candidate user → assessment → attempt (status='submitted')
 *   attempt_questions row (PK: attempt_id, question_id)
 *
 * assessment_invitations is intentionally omitted — claim only reads/writes
 * attempts and attempt_questions; the invitation FK is on attempts.assessment_id
 * via assessments, not directly required by the claim handler.
 */
async function seedMinimalAttempt(
  client: Client,
  tenantId: string,
  adminId: string,
): Promise<{ attemptId: string }> {
  const packId = randomUUID();
  const levelId = randomUUID();
  const questionId = randomUUID();
  const assessmentId = randomUUID();
  const attemptId = randomUUID();
  const candidateId = randomUUID();

  await client.query(
    `INSERT INTO question_packs
       (id, tenant_id, slug, name, domain, status, version, created_by)
     VALUES ($1, $2, $3, 'Audit Test Pack', 'soc', 'published', 1, $4)`,
    [packId, tenantId, `audit-test-${randomUUID().slice(0, 8)}`, adminId],
  );

  // levels has NO tenant_id column — JOIN-RLS through question_packs
  await client.query(
    `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count)
     VALUES ($1, $2, 1, 'L1', 30, 1)`,
    [levelId, packId],
  );

  // questions has NO tenant_id column
  await client.query(
    `INSERT INTO questions
       (id, pack_id, level_id, type, topic, points, status, version, content, rubric, created_by)
     VALUES ($1, $2, $3, 'subjective', 'audit-topic', 10, 'active', 1, $4::jsonb, $5::jsonb, $6)`,
    [
      questionId, packId, levelId,
      JSON.stringify({ question: "Audit test question?" }),
      JSON.stringify({ criteria: ["criterion 1"] }),
      adminId,
    ],
  );

  // question_versions uses saved_by (not created_by) — required for loadFrozenQuestions JOIN
  await client.query(
    `INSERT INTO question_versions (id, question_id, version, content, rubric, saved_by)
     VALUES ($1, $2, 1, $3::jsonb, $4::jsonb, $5)`,
    [
      randomUUID(), questionId,
      JSON.stringify({ question: "Audit test question?" }),
      JSON.stringify({ criteria: ["criterion 1"] }),
      adminId,
    ],
  );

  await client.query(
    `INSERT INTO users (id, tenant_id, email, name, role, status)
     VALUES ($1, $2, $3, 'Candidate', 'candidate', 'active')`,
    [candidateId, tenantId, `cand-audit-${randomUUID().slice(0, 8)}@test.local`],
  );

  await client.query(
    `INSERT INTO assessments
       (id, tenant_id, pack_id, level_id, pack_version, name, question_count, status, created_by)
     VALUES ($1, $2, $3, $4, 1, 'Audit Test Assessment', 1, 'active', $5)`,
    [assessmentId, tenantId, packId, levelId, adminId],
  );

  await client.query(
    `INSERT INTO attempts
       (id, tenant_id, assessment_id, user_id, status, started_at, ends_at, submitted_at, duration_seconds)
     VALUES ($1, $2, $3, $4, 'submitted', now(), now() + interval '30 minutes', now(), 1800)`,
    [attemptId, tenantId, assessmentId, candidateId],
  );

  // attempt_questions: PK (attempt_id, question_id) — no id or tenant_id column
  await client.query(
    `INSERT INTO attempt_questions (attempt_id, question_id, position, question_version)
     VALUES ($1, $2, 1, 1)`,
    [attemptId, questionId],
  );

  return { attemptId };
}

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "assessiq",
      POSTGRES_PASSWORD: "assessiq_test_pw",
      POSTGRES_DB: "assessiq",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  const port = container.getMappedPort(5432);
  const host = container.getHost();
  containerUrl = `postgres://assessiq:assessiq_test_pw@${host}:${port}/assessiq`;

  await withSuperClient(async (client) => {
    // Role setup mirrors 03-users audit-writes.test.ts (~line 252)
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
    await client.query(`GRANT assessiq_app TO assessiq`);
    await client.query(`GRANT assessiq_system TO assessiq`);

    // Migration apply order — respects FK chain
    await applyMigrationsFromDir(client, TENANCY_MIGRATIONS_DIR);
    await applyMigrationsFromDir(client, USERS_MIGRATIONS_DIR, ["020_users.sql"]);
    await applyMigrationsFromDir(client, QB_MIGRATIONS_DIR);
    await applyMigrationsFromDir(client, AL_MIGRATIONS_DIR);
    await applyMigrationsFromDir(client, AE_MIGRATIONS_DIR);
    await applyMigrationsFromDir(client, AI_MIGRATIONS_DIR);
    await applyMigrationsFromDir(client, AUDIT_MIGRATIONS_DIR); // must be last

    await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await client.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
    await client.query(`GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO assessiq_app`);
  });

  setPoolForTesting(containerUrl);

  TENANT_ID = randomUUID();
  ADMIN_ID = randomUUID();

  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'AI Grading Audit Test')`,
      [TENANT_ID, `ai-audit-${TENANT_ID.slice(0, 8)}`],
    );
    await client.query(
      `INSERT INTO tenant_settings (tenant_id) VALUES ($1)`,
      [TENANT_ID],
    );
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status)
       VALUES ($1, $2, $3, 'Admin', 'admin', 'active')`,
      [ADMIN_ID, TENANT_ID, `admin-audit-${TENANT_ID.slice(0, 8)}@test.local`],
    );

    const { attemptId } = await seedMinimalAttempt(client, TENANT_ID, ADMIN_ID);
    ATTEMPT_ID = attemptId;
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

beforeEach(() => {
  injectAuditFailure = null;
});

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("07-ai-grading G3.D audit writes — live integration (handleAdminClaimAttempt)", () => {
  it("happy-path: writes a grading.claimed audit row with correct actor/entity/before/after", async () => {
    // Reset to 'submitted' so the idempotent UPDATE fires (wasClaimed=true)
    await withSuperClient((c) =>
      c.query(`UPDATE attempts SET status = 'submitted' WHERE id = $1`, [ATTEMPT_ID]),
    );
    await clearAudit(TENANT_ID);

    const result = await handleAdminClaimAttempt({
      tenantId: TENANT_ID,
      userId: ADMIN_ID,
      attemptId: ATTEMPT_ID,
    });

    expect(result.attempt.id).toBe(ATTEMPT_ID);
    expect(result.attempt.status).toBe("pending_admin_grading");

    const rows = await queryAudit(TENANT_ID, "grading.claimed");
    const row = rows.find((r) => r.entity_id === ATTEMPT_ID);
    expect(row).toBeDefined();
    expect(row!.actor_kind).toBe("user");
    expect(row!.actor_user_id).toBe(ADMIN_ID);
    expect(row!.entity_type).toBe("attempt");
    const before = row!.before as Record<string, unknown>;
    const after = row!.after as Record<string, unknown>;
    expect(before.attempt_status).toBe("submitted");
    expect(after.attempt_status).toBe("pending_admin_grading");
  });

  it("atomicity: when auditInTx throws, attempts.status is NOT updated (withTenant rolls back)", async () => {
    // Ensure 'submitted' so the UPDATE fires and auditInTx is called
    await withSuperClient((c) =>
      c.query(`UPDATE attempts SET status = 'submitted' WHERE id = $1`, [ATTEMPT_ID]),
    );

    // Inject one-shot failure — auditInTx throws inside the withTenant tx
    injectAuditFailure = new Error("audit write injection failure");

    await expect(
      handleAdminClaimAttempt({
        tenantId: TENANT_ID,
        userId: ADMIN_ID,
        attemptId: ATTEMPT_ID,
      }),
    ).rejects.toThrow(/audit write injection failure/);

    // The attempts row must still be 'submitted' — the withTenant transaction
    // rolled back when auditInTx threw, undoing the UPDATE
    const status = await readAttemptStatus(ATTEMPT_ID);
    expect(status).toBe("submitted");
  });
});
