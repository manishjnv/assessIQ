/**
 * Integration tests for handleAdminListAttempts.
 *
 * Uses a postgres:16-alpine testcontainer so the full RLS stack is exercised.
 * Container is started ONCE in beforeAll and shared across all test cases.
 *
 * Migration apply order mirrors handlers.test.ts (CRITICAL — must respect FK chain):
 *   1. ALL 02-tenancy migrations
 *   2. 03-users 020_users.sql ONLY
 *   3. ALL 04-question-bank migrations
 *   4. ALL 05-assessment-lifecycle migrations
 *   5. ALL 06-attempt-engine migrations
 *   6. ALL 07-ai-grading migrations
 *
 * No AI runtime is touched — this is a pure data-read handler.
 *
 * Schema notes (same as handlers.test.ts):
 *   - `levels` has NO tenant_id; pack_id FK chains RLS.
 *   - `questions` has NO tenant_id.
 *   - `attempt_questions` PK is (attempt_id, question_id) — no id/tenant_id.
 *   - `attempt_answers` PK is (attempt_id, question_id) — no id/tenant_id.
 *   - `assessment_invitations` has NO tenant_id; requires expires_at + invited_by.
 *   - All superuser INSERTs bypass RLS.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";

import { handleAdminListAttempts } from "../handlers/admin-attempts-list.js";

// ---------------------------------------------------------------------------
// Path helpers — strip Windows leading slash before drive letter.
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

const THIS_DIR = toFsPath(new URL(".", import.meta.url));
const AI_MODULE_ROOT = join(THIS_DIR, "..", "..");
const MODULES_ROOT = join(AI_MODULE_ROOT, "..");

const TENANCY_MIGRATIONS_DIR = join(MODULES_ROOT, "02-tenancy", "migrations");
const USERS_MIGRATIONS_DIR = join(MODULES_ROOT, "03-users", "migrations");
const QB_MIGRATIONS_DIR = join(MODULES_ROOT, "04-question-bank", "migrations");
const AL_MIGRATIONS_DIR = join(MODULES_ROOT, "05-assessment-lifecycle", "migrations");
const AE_MIGRATIONS_DIR = join(MODULES_ROOT, "06-attempt-engine", "migrations");
const AI_MIGRATIONS_DIR = join(AI_MODULE_ROOT, "migrations");

// ---------------------------------------------------------------------------
// Shared test state — set in beforeAll, read-only in tests
// ---------------------------------------------------------------------------

let container: StartedTestContainer;
let containerUrl: string;
let TENANT_ID: string;
let OTHER_TENANT_ID: string;
let ADMIN_ID: string;
let OTHER_ADMIN_ID: string;
let CANDIDATE_ID: string;

// Shared pack/level/assessment seeded once — reused across fixture inserts.
let PACK_ID: string;
let LEVEL_ID: string;
let ASSESSMENT_ID: string;

// ---------------------------------------------------------------------------
// DB helpers (mirrors handlers.test.ts)
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

async function insertTenant(
  client: Client,
  id: string,
  slug: string,
  name: string,
): Promise<void> {
  await client.query(
    `INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`,
    [id, slug, name],
  );
  await client.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
}

async function insertAdminUser(
  client: Client,
  id: string,
  tenantId: string,
  email: string,
): Promise<void> {
  await client.query(
    `INSERT INTO users (id, tenant_id, email, name, role, status)
     VALUES ($1, $2, $3, 'Admin', 'admin', 'active')`,
    [id, tenantId, email],
  );
}

async function insertCandidateUser(
  client: Client,
  id: string,
  tenantId: string,
  email: string,
): Promise<void> {
  await client.query(
    `INSERT INTO users (id, tenant_id, email, name, role, status)
     VALUES ($1, $2, $3, 'Candidate', 'candidate', 'active')`,
    [id, tenantId, email],
  );
}

/**
 * Insert an attempt row with the given status, optional submitted_at, and
 * optional started_at offset (default: now()).
 *
 * Returns the new attempt's id.
 */
async function insertAttempt(
  client: Client,
  opts: {
    tenantId: string;
    assessmentId: string;
    candidateId: string;
    status: string;
    submittedAt?: string | null;
    startedAtOffset?: string; // interval string, e.g. '1 hour ago'
  },
): Promise<string> {
  const id = randomUUID();
  // Both startedAtOffset and submittedAt are parameterized (NOT
  // string-interpolated) — test-helper SQLi footgun closed even though no
  // current caller passes adversary strings.
  await client.query(
    `INSERT INTO attempts
       (id, tenant_id, assessment_id, user_id, status, started_at, ends_at, submitted_at, duration_seconds)
     VALUES (
       $1, $2, $3, $4, $5,
       COALESCE(now() - $6::interval, now()),
       now() + interval '30 minutes',
       $7::timestamptz,
       1800
     )`,
    [
      id,
      opts.tenantId,
      opts.assessmentId,
      opts.candidateId,
      opts.status,
      opts.startedAtOffset ?? null,
      opts.submittedAt ?? null,
    ],
  );
  return id;
}

// ---------------------------------------------------------------------------
// Global container lifecycle
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
    .start();

  const port = container.getMappedPort(5432);
  const host = container.getHost();
  containerUrl = `postgres://assessiq:assessiq_test_pw@${host}:${port}/assessiq`;

  await withSuperClient(async (client) => {
    await applyMigrationsFromDir(client, TENANCY_MIGRATIONS_DIR);
    await applyMigrationsFromDir(client, USERS_MIGRATIONS_DIR, ["020_users.sql"]);
    await applyMigrationsFromDir(client, QB_MIGRATIONS_DIR);
    await applyMigrationsFromDir(client, AL_MIGRATIONS_DIR);
    await applyMigrationsFromDir(client, AE_MIGRATIONS_DIR);
    await applyMigrationsFromDir(client, AI_MIGRATIONS_DIR);
  });

  setPoolForTesting(containerUrl);

  TENANT_ID = randomUUID();
  OTHER_TENANT_ID = randomUUID();
  ADMIN_ID = randomUUID();
  OTHER_ADMIN_ID = randomUUID();
  CANDIDATE_ID = randomUUID();

  await withSuperClient(async (client) => {
    await insertTenant(client, TENANT_ID, "tenant-list-a", "Tenant List A");
    await insertTenant(client, OTHER_TENANT_ID, "tenant-list-b", "Tenant List B");
    await insertAdminUser(client, ADMIN_ID, TENANT_ID, "admin-list-a@test.local");
    await insertAdminUser(
      client,
      OTHER_ADMIN_ID,
      OTHER_TENANT_ID,
      "admin-list-b@test.local",
    );
    await insertCandidateUser(
      client,
      CANDIDATE_ID,
      TENANT_ID,
      "candidate-list@test.local",
    );

    // Seed one pack + level + assessment used by most test cases.
    PACK_ID = randomUUID();
    LEVEL_ID = randomUUID();
    ASSESSMENT_ID = randomUUID();

    await client.query(
      `INSERT INTO question_packs
         (id, tenant_id, slug, name, domain, status, version, created_by)
       VALUES ($1, $2, $3, $4, 'soc', 'published', 2, $5)`,
      [PACK_ID, TENANT_ID, "list-test-pack", "List Test Pack", ADMIN_ID],
    );
    await client.query(
      `INSERT INTO levels
         (id, pack_id, position, label, duration_minutes, default_question_count)
       VALUES ($1, $2, 1, 'L1-list', 30, 1)`,
      [LEVEL_ID, PACK_ID],
    );
    await client.query(
      `INSERT INTO assessments
         (id, tenant_id, pack_id, level_id, pack_version, name, question_count, status, created_by)
       VALUES ($1, $2, $3, $4, 2, 'List Test Assessment', 1, 'active', $5)`,
      [ASSESSMENT_ID, TENANT_ID, PACK_ID, LEVEL_ID, ADMIN_ID],
    );
  });
}, 90_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) {
    await container.stop();
  }
}, 30_000);

// ===========================================================================
// Test suite
// ===========================================================================

describe("handleAdminListAttempts", () => {
  // -------------------------------------------------------------------------
  // 1. Happy path — 3 attempts with varied statuses → returns all 3, ordered
  //    by submitted_at DESC NULLS LAST.
  // -------------------------------------------------------------------------

  it("1. happy path — 3 attempts returned; ordered submitted_at DESC NULLS LAST", async () => {
    const candidateIds = [randomUUID(), randomUUID(), randomUUID()];
    const attemptIds: string[] = [];

    await withSuperClient(async (client) => {
      for (let i = 0; i < 3; i++) {
        await insertCandidateUser(
          client,
          candidateIds[i]!,
          TENANT_ID,
          `hp-${i}-${randomUUID().slice(0, 8)}@test.local`,
        );
      }
      // Attempt 0: submitted at a fixed time (oldest)
      attemptIds.push(
        await insertAttempt(client, {
          tenantId: TENANT_ID,
          assessmentId: ASSESSMENT_ID,
          candidateId: candidateIds[0]!,
          status: "submitted",
          submittedAt: "2026-01-01T10:00:00Z",
        }),
      );
      // Attempt 1: graded more recently
      attemptIds.push(
        await insertAttempt(client, {
          tenantId: TENANT_ID,
          assessmentId: ASSESSMENT_ID,
          candidateId: candidateIds[1]!,
          status: "graded",
          submittedAt: "2026-01-02T10:00:00Z",
        }),
      );
      // Attempt 2: released most recently
      attemptIds.push(
        await insertAttempt(client, {
          tenantId: TENANT_ID,
          assessmentId: ASSESSMENT_ID,
          candidateId: candidateIds[2]!,
          status: "released",
          submittedAt: "2026-01-03T10:00:00Z",
        }),
      );
    });

    const result = await handleAdminListAttempts({
      tenantId: TENANT_ID,
      userId: ADMIN_ID,
      limit: 10,
      offset: 0,
    });

    // All 3 attempts must appear (there may be more from other tests sharing
    // the container — check that all 3 seeded IDs are present).
    const resultIds = result.items.map((r) => r.id);
    expect(resultIds).toContain(attemptIds[0]!);
    expect(resultIds).toContain(attemptIds[1]!);
    expect(resultIds).toContain(attemptIds[2]!);
    expect(result.total).toBeGreaterThanOrEqual(3);

    // Verify ordering for the 3 known attempts: released (Jan-03) > graded (Jan-02) > submitted (Jan-01)
    const idx0 = resultIds.indexOf(attemptIds[0]!);
    const idx1 = resultIds.indexOf(attemptIds[1]!);
    const idx2 = resultIds.indexOf(attemptIds[2]!);
    expect(idx2).toBeLessThan(idx1); // released before graded
    expect(idx1).toBeLessThan(idx0); // graded before submitted (oldest)

    // Spot-check row shape.
    const releasedRow = result.items.find((r) => r.id === attemptIds[2]!)!;
    expect(releasedRow).toBeDefined();
    expect(releasedRow.status).toBe("released");
    expect(releasedRow.submitted_at).toBe("2026-01-03T10:00:00Z");
    expect(releasedRow.assessment_name).toBe("List Test Assessment");
    expect(releasedRow.level_label).toBe("L1-list");
    // candidate_email is the email of candidateIds[2]
    expect(releasedRow.candidate_email).toMatch(/@test\.local$/);
  });

  // -------------------------------------------------------------------------
  // 2. Status filter — only 'submitted' attempts returned.
  // -------------------------------------------------------------------------

  it("2. status filter — only 'submitted' attempts returned", async () => {
    const candidateA = randomUUID();
    const candidateB = randomUUID();
    let submittedId!: string;
    let gradedId!: string;

    await withSuperClient(async (client) => {
      await insertCandidateUser(
        client,
        candidateA,
        TENANT_ID,
        `sf-a-${randomUUID().slice(0, 8)}@test.local`,
      );
      await insertCandidateUser(
        client,
        candidateB,
        TENANT_ID,
        `sf-b-${randomUUID().slice(0, 8)}@test.local`,
      );
      submittedId = await insertAttempt(client, {
        tenantId: TENANT_ID,
        assessmentId: ASSESSMENT_ID,
        candidateId: candidateA,
        status: "submitted",
        submittedAt: "2026-02-01T08:00:00Z",
      });
      gradedId = await insertAttempt(client, {
        tenantId: TENANT_ID,
        assessmentId: ASSESSMENT_ID,
        candidateId: candidateB,
        status: "graded",
        submittedAt: "2026-02-01T09:00:00Z",
      });
    });

    const result = await handleAdminListAttempts({
      tenantId: TENANT_ID,
      userId: ADMIN_ID,
      limit: 100,
      offset: 0,
      status: "submitted",
    });

    const ids = result.items.map((r) => r.id);
    expect(ids).toContain(submittedId);
    expect(ids).not.toContain(gradedId);
    // Every returned item must have status 'submitted'.
    for (const item of result.items) {
      expect(item.status).toBe("submitted");
    }
  });

  // -------------------------------------------------------------------------
  // 3. RLS isolation — tenant B attempt is NOT visible when scoped to tenant A.
  // -------------------------------------------------------------------------

  it("3. RLS isolation — tenant B attempt does not appear in tenant A's list", async () => {
    const otherCandidateId = randomUUID();
    let otherAttemptId!: string;

    await withSuperClient(async (client) => {
      await insertCandidateUser(
        client,
        otherCandidateId,
        OTHER_TENANT_ID,
        `rls-other-${randomUUID().slice(0, 8)}@test.local`,
      );

      // Need a pack/assessment for OTHER_TENANT_ID.
      const otherPackId = randomUUID();
      const otherLevelId = randomUUID();
      const otherAssessmentId = randomUUID();

      await client.query(
        `INSERT INTO question_packs
           (id, tenant_id, slug, name, domain, status, version, created_by)
         VALUES ($1, $2, $3, $4, 'soc', 'published', 1, $5)`,
        [
          otherPackId,
          OTHER_TENANT_ID,
          `other-pack-${randomUUID().slice(0, 8)}`,
          "Other Pack",
          OTHER_ADMIN_ID,
        ],
      );
      await client.query(
        `INSERT INTO levels
           (id, pack_id, position, label, duration_minutes, default_question_count)
         VALUES ($1, $2, 1, 'L1-other', 30, 1)`,
        [otherLevelId, otherPackId],
      );
      await client.query(
        `INSERT INTO assessments
           (id, tenant_id, pack_id, level_id, pack_version, name, question_count, status, created_by)
         VALUES ($1, $2, $3, $4, 1, 'Other Assessment', 1, 'active', $5)`,
        [otherAssessmentId, OTHER_TENANT_ID, otherPackId, otherLevelId, OTHER_ADMIN_ID],
      );

      otherAttemptId = await insertAttempt(client, {
        tenantId: OTHER_TENANT_ID,
        assessmentId: otherAssessmentId,
        candidateId: otherCandidateId,
        status: "submitted",
        submittedAt: "2026-03-01T10:00:00Z",
      });
    });

    // Query as TENANT_ID — must NOT see other tenant's attempt.
    const result = await handleAdminListAttempts({
      tenantId: TENANT_ID,
      userId: ADMIN_ID,
      limit: 100,
      offset: 0,
    });

    const ids = result.items.map((r) => r.id);
    expect(ids).not.toContain(otherAttemptId);

    // Also verify from the other side: OTHER_TENANT_ID can only see its own.
    const otherResult = await handleAdminListAttempts({
      tenantId: OTHER_TENANT_ID,
      userId: OTHER_ADMIN_ID,
      limit: 100,
      offset: 0,
    });
    const otherIds = otherResult.items.map((r) => r.id);
    expect(otherIds).toContain(otherAttemptId);
    // TENANT_ID's attempts must not appear in OTHER_TENANT_ID's view.
    for (const id of ids) {
      expect(otherIds).not.toContain(id);
    }
  });

  // -------------------------------------------------------------------------
  // 4. Pagination — limit=2, offset=2 returns 2 items; total reflects all.
  // -------------------------------------------------------------------------

  it("4. pagination — limit=2 offset=2 returns correct slice; total is full count", async () => {
    // Use a fresh tenant so the total is deterministic (exactly 5 attempts).
    const paginationTenantId = randomUUID();
    const paginationAdminId = randomUUID();
    const paginationPackId = randomUUID();
    const paginationLevelId = randomUUID();
    const paginationAssessmentId = randomUUID();
    const paginationCandidateIds = Array.from({ length: 5 }, () => randomUUID());

    await withSuperClient(async (client) => {
      await insertTenant(client, paginationTenantId, `pg-tenant-${randomUUID().slice(0,8)}`, "Pagination Tenant");
      await insertAdminUser(client, paginationAdminId, paginationTenantId, `pg-admin-${randomUUID().slice(0,8)}@test.local`);

      for (const cid of paginationCandidateIds) {
        await insertCandidateUser(
          client,
          cid,
          paginationTenantId,
          `pg-c-${cid.slice(0, 8)}@test.local`,
        );
      }

      await client.query(
        `INSERT INTO question_packs
           (id, tenant_id, slug, name, domain, status, version, created_by)
         VALUES ($1, $2, $3, $4, 'soc', 'published', 1, $5)`,
        [paginationPackId, paginationTenantId, `pg-pack-${randomUUID().slice(0,8)}`, "Pg Pack", paginationAdminId],
      );
      await client.query(
        `INSERT INTO levels
           (id, pack_id, position, label, duration_minutes, default_question_count)
         VALUES ($1, $2, 1, 'L1-pg', 30, 1)`,
        [paginationLevelId, paginationPackId],
      );
      await client.query(
        `INSERT INTO assessments
           (id, tenant_id, pack_id, level_id, pack_version, name, question_count, status, created_by)
         VALUES ($1, $2, $3, $4, 1, 'Pg Assessment', 1, 'active', $5)`,
        [paginationAssessmentId, paginationTenantId, paginationPackId, paginationLevelId, paginationAdminId],
      );

      // Insert 5 attempts with distinct submitted_at times (oldest to newest by index).
      for (let i = 0; i < 5; i++) {
        await insertAttempt(client, {
          tenantId: paginationTenantId,
          assessmentId: paginationAssessmentId,
          candidateId: paginationCandidateIds[i]!,
          status: "submitted",
          submittedAt: `2026-04-0${i + 1}T10:00:00Z`,
        });
      }
    });

    // First page (offset=0, limit=2): 2 items, total=5.
    const page1 = await handleAdminListAttempts({
      tenantId: paginationTenantId,
      userId: paginationAdminId,
      limit: 2,
      offset: 0,
    });
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(5);

    // Second page (offset=2, limit=2): 2 items, total=5.
    const page2 = await handleAdminListAttempts({
      tenantId: paginationTenantId,
      userId: paginationAdminId,
      limit: 2,
      offset: 2,
    });
    expect(page2.items).toHaveLength(2);
    expect(page2.total).toBe(5);

    // No overlap between pages.
    const page1Ids = page1.items.map((r) => r.id);
    const page2Ids = page2.items.map((r) => r.id);
    for (const id of page1Ids) {
      expect(page2Ids).not.toContain(id);
    }

    // Third page (offset=4, limit=2): 1 item, total=5.
    const page3 = await handleAdminListAttempts({
      tenantId: paginationTenantId,
      userId: paginationAdminId,
      limit: 2,
      offset: 4,
    });
    expect(page3.items).toHaveLength(1);
    expect(page3.total).toBe(5);
  });

  // -------------------------------------------------------------------------
  // 5. Empty tenant — items=[], total=0.
  // -------------------------------------------------------------------------

  it("5. empty tenant — items=[], total=0", async () => {
    const emptyTenantId = randomUUID();
    const emptyAdminId = randomUUID();

    await withSuperClient(async (client) => {
      await insertTenant(client, emptyTenantId, `empty-${randomUUID().slice(0,8)}`, "Empty Tenant");
      await insertAdminUser(client, emptyAdminId, emptyTenantId, `empty-admin-${randomUUID().slice(0,8)}@test.local`);
    });

    const result = await handleAdminListAttempts({
      tenantId: emptyTenantId,
      userId: emptyAdminId,
      limit: 10,
      offset: 0,
    });

    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 6. Boundary — limit=100 does not throw.
  // -------------------------------------------------------------------------

  it("6. limit=100 boundary — no exception", async () => {
    await expect(
      handleAdminListAttempts({
        tenantId: TENANT_ID,
        userId: ADMIN_ID,
        limit: 100,
        offset: 0,
      }),
    ).resolves.toMatchObject({ items: expect.any(Array), total: expect.any(Number) });
  });
});
