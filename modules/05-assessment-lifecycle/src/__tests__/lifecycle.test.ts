/**
 * Integration tests for modules/05-assessment-lifecycle.
 *
 * Uses a postgres:16-alpine testcontainer so the full RLS stack is exercised.
 * Container is started ONCE in beforeAll and torn down in afterAll.
 * All tests share the same container — no Redis needed (boundary cron is called
 * directly; no BullMQ worker scaffolded in this suite).
 *
 * Migration apply order (CRITICAL — must respect FK chain):
 *   1. ALL 02-tenancy migrations (0001–0004) — sorted lexicographically.
 *   2. 03-users 020_users.sql ONLY — supplies the users table.
 *      021_user_invitations.sql is SKIPPED (depends on auth tables not
 *      present in this scaffold).
 *   3. ALL 04-question-bank migrations (0010–0015) — assessments has FKs to
 *      question_packs and levels; pack must exist before assessment INSERT.
 *   4. ALL 05-assessment-lifecycle migrations (0020–0022).
 *
 * ESLint: no console.log — vitest reporter output only.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import os from "node:os";

import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";

// Module-05 service surface
import {
  createAssessment,
  getAssessment,
  listAssessments,
  publishAssessment,
  closeAssessment,
  reopenAssessment,
  inviteUsers,
  listInvitations,
  revokeInvitation,
  previewAssessment,
} from "../service.js";

// State machine — pure-function surface
import {
  canTransition,
  nextStateOnTimeBoundary,
  assertValidWindow,
  assertReopenAllowed,
  ASSESSMENT_STATUSES,
} from "../state-machine.js";
import type { BoundaryRow } from "../state-machine.js";

// Boundary cron
import { processBoundariesForTenant } from "../boundaries.js";

// Token primitives
import { generateInvitationToken, hashInvitationToken } from "../tokens.js";

// Error codes
import { AL_ERROR_CODES } from "../types.js";
import type { AssessmentStatus } from "../types.js";

// 04-question-bank helpers for test setup
import {
  createPack,
  addLevel,
  createQuestion,
  publishPack,
} from "../../../04-question-bank/src/service.js";

import { ConflictError, NotFoundError, ValidationError } from "@assessiq/core";

// ---------------------------------------------------------------------------
// Path helper — strip Windows leading slash before drive letter.
// import.meta.url on Windows: file:///E:/code/...
// new URL('.', import.meta.url).pathname: /E:/code/.../src/__tests__/
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

const THIS_DIR = toFsPath(new URL(".", import.meta.url));
const AL_MODULE_ROOT = join(THIS_DIR, "..", "..");
const MODULES_ROOT = join(AL_MODULE_ROOT, "..");

const TENANCY_MIGRATIONS_DIR = join(MODULES_ROOT, "02-tenancy", "migrations");
const USERS_MIGRATIONS_DIR = join(MODULES_ROOT, "03-users", "migrations");
const QB_MIGRATIONS_DIR = join(MODULES_ROOT, "04-question-bank", "migrations");
const AL_MIGRATIONS_DIR = join(AL_MODULE_ROOT, "migrations");

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let container: StartedTestContainer;
let containerUrl: string;
let tenantA: string;
let tenantB: string;
let adminA: string;
let adminB: string;

// ---------------------------------------------------------------------------
// Setup helpers
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

async function insertTenant(client: Client, id: string, slug: string, name: string): Promise<void> {
  await client.query(
    `INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`,
    [id, slug, name],
  );
  await client.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
}

async function insertAdminUser(client: Client, id: string, tenantId: string, email: string): Promise<void> {
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
  name: string,
): Promise<void> {
  await client.query(
    `INSERT INTO users (id, tenant_id, email, name, role, status)
     VALUES ($1, $2, $3, $4, 'candidate', 'active')`,
    [id, tenantId, email, name],
  );
}

/** Build a published pack with N active mcq questions on a single level. */
async function buildPublishedPack(
  tenantId: string,
  adminId: string,
  questionCount: number,
): Promise<{ packId: string; levelId: string }> {
  const slug = `test-pack-${randomUUID().slice(0, 8)}`;
  const pack = await createPack(tenantId, { slug, name: "Test Pack", domain: "soc" }, adminId);
  const level = await addLevel(tenantId, pack.id, {
    position: 1,
    label: "L1",
    duration_minutes: 30,
    default_question_count: questionCount,
  });
  for (let i = 0; i < questionCount; i++) {
    await createQuestion(
      tenantId,
      {
        pack_id: pack.id,
        level_id: level.id,
        type: "mcq",
        topic: `q-topic-${i}`,
        points: 5,
        content: {
          question: `Test question ${i}?`,
          options: ["A", "B", "C", "D"],
          correct: 0,
          rationale: "A is correct.",
        },
      },
      adminId,
    );
  }
  await publishPack(tenantId, pack.id, adminId);

  // Flip all questions in this pack to status='active' so the assessment-
  // lifecycle pool-size pre-flight (which counts questions WHERE status='active')
  // can see them. Module 04's createQuestion defaults to status='draft' and
  // publishPack does NOT auto-flip questions — the admin workflow is to PATCH
  // each question to 'active' separately. This bulk SQL UPDATE through the
  // superuser client is a test-only shortcut for that workflow; the production
  // path is `service.updateQuestion(tenantId, qid, { status: 'active' }, ...)`.
  await withSuperClient(async (client) => {
    await client.query(
      `UPDATE questions SET status = 'active' WHERE pack_id = $1`,
      [pack.id],
    );
  });

  return { packId: pack.id, levelId: level.id };
}

// ---------------------------------------------------------------------------
// Global setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "test",
      POSTGRES_PASSWORD: "test",
      POSTGRES_DB: "aiq_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  containerUrl = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_test`;

  const [tenancyFiles, usersFiles, qbFiles, alFiles] = await Promise.all([
    readdir(TENANCY_MIGRATIONS_DIR),
    readdir(USERS_MIGRATIONS_DIR),
    readdir(QB_MIGRATIONS_DIR),
    readdir(AL_MIGRATIONS_DIR),
  ]);

  // All tenancy migrations (0001-0004, incl. smtp_config)
  const tenancySorted = tenancyFiles
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ dir: TENANCY_MIGRATIONS_DIR, file: f }));

  // Only 020_users.sql — skip 021_user_invitations.sql
  const usersSorted = usersFiles
    .filter((f) => f.endsWith(".sql") && f.startsWith("020_"))
    .sort()
    .map((f) => ({ dir: USERS_MIGRATIONS_DIR, file: f }));

  // All QB migrations (0010-0015)
  const qbSorted = qbFiles
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ dir: QB_MIGRATIONS_DIR, file: f }));

  // All AL migrations (0020-0022)
  const alSorted = alFiles
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ dir: AL_MIGRATIONS_DIR, file: f }));

  await withSuperClient(async (client) => {
    for (const { dir, file } of [...tenancySorted, ...usersSorted, ...qbSorted, ...alSorted]) {
      const sql = await readFile(join(dir, file), "utf-8");
      await client.query(sql);
    }
  });

  await setPoolForTesting(containerUrl);

  tenantA = randomUUID();
  tenantB = randomUUID();
  adminA = randomUUID();
  adminB = randomUUID();

  await withSuperClient(async (client) => {
    await insertTenant(client, tenantA, "tenant-a", "Tenant A");
    await insertTenant(client, tenantB, "tenant-b", "Tenant B");
    await insertAdminUser(client, adminA, tenantA, "admin-a@example.com");
    await insertAdminUser(client, adminB, tenantB, "admin-b@example.com");
  });
}, 90_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) {
    await container.stop();
  }
});

// ===========================================================================
// 1. State machine pure-function tests (no testcontainer required)
// ===========================================================================

describe("State machine — canTransition legal edges", () => {
  it("draft → published is legal", () => {
    expect(canTransition("draft", "published")).toBe(true);
  });

  it("draft → cancelled is legal", () => {
    expect(canTransition("draft", "cancelled")).toBe(true);
  });

  it("published → draft is legal (unpublish)", () => {
    expect(canTransition("published", "draft")).toBe(true);
  });

  it("published → active is legal", () => {
    expect(canTransition("published", "active")).toBe(true);
  });

  it("published → cancelled is legal", () => {
    expect(canTransition("published", "cancelled")).toBe(true);
  });

  it("active → closed is legal", () => {
    expect(canTransition("active", "closed")).toBe(true);
  });

  it("closed → published is legal (reopen)", () => {
    expect(canTransition("closed", "published")).toBe(true);
  });
});

describe("State machine — canTransition illegal edges", () => {
  const legalSet = new Set<string>([
    "draft->published",
    "draft->cancelled",
    "published->draft",
    "published->active",
    "published->cancelled",
    "active->closed",
    "closed->published",
  ]);

  const illegalCases: Array<[AssessmentStatus, AssessmentStatus]> = [];
  for (const from of ASSESSMENT_STATUSES) {
    for (const to of ASSESSMENT_STATUSES) {
      if (from !== to && !legalSet.has(`${from}->${to}`)) {
        illegalCases.push([from, to]);
      }
    }
  }

  // Self-transitions are always illegal
  for (const s of ASSESSMENT_STATUSES) {
    illegalCases.push([s, s]);
  }

  // Exhaustive cases — explicitly call out the spec-required 10+ pairs
  it("closed → draft is illegal", () => {
    expect(canTransition("closed", "draft")).toBe(false);
  });

  it("cancelled → published is illegal", () => {
    expect(canTransition("cancelled", "published")).toBe(false);
  });

  it("active → draft is illegal", () => {
    expect(canTransition("active", "draft")).toBe(false);
  });

  it("draft → active is illegal", () => {
    expect(canTransition("draft", "active")).toBe(false);
  });

  it("draft → closed is illegal", () => {
    expect(canTransition("draft", "closed")).toBe(false);
  });

  it("closed → active is illegal", () => {
    expect(canTransition("closed", "active")).toBe(false);
  });

  it("closed → cancelled is illegal", () => {
    expect(canTransition("closed", "cancelled")).toBe(false);
  });

  it("cancelled → draft is illegal", () => {
    expect(canTransition("cancelled", "draft")).toBe(false);
  });

  it("active → published is illegal", () => {
    expect(canTransition("active", "published")).toBe(false);
  });

  it("active → cancelled is illegal", () => {
    expect(canTransition("active", "cancelled")).toBe(false);
  });

  it("cancelled → active is illegal", () => {
    expect(canTransition("cancelled", "active")).toBe(false);
  });

  it("cancelled → closed is illegal", () => {
    expect(canTransition("cancelled", "closed")).toBe(false);
  });

  it("all remaining illegal pairs return false (exhaustive)", () => {
    for (const [from, to] of illegalCases) {
      expect(canTransition(from, to), `${from} → ${to} should be illegal`).toBe(false);
    }
  });
});

describe("State machine — nextStateOnTimeBoundary", () => {
  const past5m = () => new Date(Date.now() - 5 * 60_000);
  const past2h = () => new Date(Date.now() - 2 * 60 * 60_000);
  const future1h = () => new Date(Date.now() + 60 * 60_000);
  const now = () => new Date();

  it("published + opens_at past, closes_at future → 'active'", () => {
    const row: BoundaryRow = { status: "published", opens_at: past5m(), closes_at: future1h() };
    expect(nextStateOnTimeBoundary(now(), row)).toBe("active");
  });

  it("active + closes_at past → 'closed'", () => {
    const row: BoundaryRow = { status: "active", opens_at: past2h(), closes_at: past5m() };
    expect(nextStateOnTimeBoundary(now(), row)).toBe("closed");
  });

  it("published + opens_at and closes_at both past → 'closed' (skips active)", () => {
    const row: BoundaryRow = { status: "published", opens_at: past2h(), closes_at: past5m() };
    expect(nextStateOnTimeBoundary(now(), row)).toBe("closed");
  });

  it("published + opens_at future → 'published' (no change)", () => {
    const row: BoundaryRow = { status: "published", opens_at: future1h(), closes_at: null };
    expect(nextStateOnTimeBoundary(now(), row)).toBe("published");
  });

  it("active + closes_at future → 'active' (no change)", () => {
    const row: BoundaryRow = { status: "active", opens_at: past5m(), closes_at: future1h() };
    expect(nextStateOnTimeBoundary(now(), row)).toBe("active");
  });

  it("draft + any time → 'draft' (cron never advances draft)", () => {
    const row: BoundaryRow = { status: "draft", opens_at: past5m(), closes_at: future1h() };
    expect(nextStateOnTimeBoundary(now(), row)).toBe("draft");
  });

  it("closed + any time → 'closed' (cron never rewinds closed)", () => {
    const row: BoundaryRow = { status: "closed", opens_at: past2h(), closes_at: past5m() };
    expect(nextStateOnTimeBoundary(now(), row)).toBe("closed");
  });

  it("cancelled + any time → 'cancelled' (terminal)", () => {
    const row: BoundaryRow = { status: "cancelled", opens_at: past5m(), closes_at: future1h() };
    expect(nextStateOnTimeBoundary(now(), row)).toBe("cancelled");
  });
});

describe("State machine — assertValidWindow", () => {
  it("opens_at === closes_at throws WINDOW_INVALID", () => {
    const t = new Date();
    let caught: unknown;
    try {
      assertValidWindow(t, t);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).details).toMatchObject({
      code: AL_ERROR_CODES.WINDOW_INVALID,
    });
  });

  it("opens_at > closes_at throws WINDOW_INVALID", () => {
    const opens = new Date(Date.now() + 60_000);
    const closes = new Date(Date.now() - 60_000);
    let caught: unknown;
    try {
      assertValidWindow(opens, closes);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).details).toMatchObject({
      code: AL_ERROR_CODES.WINDOW_INVALID,
    });
  });

  it("opens_at < closes_at does not throw", () => {
    const opens = new Date(Date.now() - 60_000);
    const closes = new Date(Date.now() + 60_000);
    expect(() => assertValidWindow(opens, closes)).not.toThrow();
  });

  it("opens_at NULL does not throw", () => {
    expect(() => assertValidWindow(null, new Date())).not.toThrow();
  });

  it("closes_at NULL does not throw", () => {
    expect(() => assertValidWindow(new Date(), null)).not.toThrow();
  });

  it("both NULL does not throw", () => {
    expect(() => assertValidWindow(null, null)).not.toThrow();
  });
});

describe("State machine — assertReopenAllowed", () => {
  it("closes_at in the past throws REOPEN_PAST_CLOSES_AT", () => {
    const past = new Date(Date.now() - 60_000);
    let caught: unknown;
    try {
      assertReopenAllowed(new Date(), past);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).details).toMatchObject({
      code: AL_ERROR_CODES.REOPEN_PAST_CLOSES_AT,
    });
  });

  it("closes_at in the future passes", () => {
    const future = new Date(Date.now() + 60 * 60_000);
    expect(() => assertReopenAllowed(new Date(), future)).not.toThrow();
  });

  it("closes_at NULL passes", () => {
    expect(() => assertReopenAllowed(new Date(), null)).not.toThrow();
  });
});

// ===========================================================================
// 2. createAssessment + lifecycle happy path (testcontainer)
// ===========================================================================

describe("createAssessment + lifecycle happy path", () => {
  let packId: string;
  let levelId: string;

  beforeAll(async () => {
    ({ packId, levelId } = await buildPublishedPack(tenantA, adminA, 3));
  });

  it("createAssessment returns Assessment with status='draft'", async () => {
    const assessment = await createAssessment(
      tenantA,
      { pack_id: packId, level_id: levelId, name: "My Assessment", question_count: 3 },
      adminA,
    );
    expect(assessment.status).toBe("draft");
    expect(assessment.pack_id).toBe(packId);
    expect(assessment.level_id).toBe(levelId);
    expect(assessment.tenant_id).toBe(tenantA);
  });

  it("createAssessment pack_version equals published pack version (2 after publishPack)", async () => {
    // publishPack bumps version from 1 to 2
    const assessment = await createAssessment(
      tenantA,
      { pack_id: packId, level_id: levelId, name: "Version Check", question_count: 3 },
      adminA,
    );
    expect(assessment.pack_version).toBe(2);
  });

  it("createAssessment against unpublished pack → ConflictError(PACK_NOT_PUBLISHED)", async () => {
    const slug = `draft-pack-${randomUUID().slice(0, 8)}`;
    const draftPack = await createPack(tenantA, { slug, name: "Draft Pack", domain: "soc" }, adminA);
    const draftLevel = await addLevel(tenantA, draftPack.id, {
      position: 1, label: "L1", duration_minutes: 30, default_question_count: 5,
    });

    await expect(
      createAssessment(
        tenantA,
        { pack_id: draftPack.id, level_id: draftLevel.id, name: "Unpub Test", question_count: 3 },
        adminA,
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConflictError &&
        (e.details as Record<string, unknown> | undefined)?.["code"] === AL_ERROR_CODES.PACK_NOT_PUBLISHED,
    );
  });

  it("createAssessment with cross-pack level → ValidationError(LEVEL_NOT_IN_PACK)", async () => {
    // packA already exists (packId / levelId from beforeAll).
    // Build packB (separate pack, no levels overlap).
    const slugB = `cross-pack-b-${randomUUID().slice(0, 8)}`;
    const { packId: packBId } = await buildPublishedPack(tenantA, adminA, 1);
    // levelId belongs to packId (packA); pass packBId as pack_id — should fail.
    await expect(
      createAssessment(
        tenantA,
        { pack_id: packBId, level_id: levelId, name: "Cross Pack", question_count: 1 },
        adminA,
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ValidationError &&
        (e.details as Record<string, unknown> | undefined)?.["code"] === AL_ERROR_CODES.LEVEL_NOT_IN_PACK,
    );
  });

  it("createAssessment with opens_at >= closes_at → ValidationError(WINDOW_INVALID)", async () => {
    const t = new Date();
    await expect(
      createAssessment(
        tenantA,
        {
          pack_id: packId,
          level_id: levelId,
          name: "Bad Window",
          question_count: 3,
          opens_at: t,
          closes_at: t,
        },
        adminA,
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ValidationError &&
        (e.details as Record<string, unknown> | undefined)?.["code"] === AL_ERROR_CODES.WINDOW_INVALID,
    );
  });
});

// ===========================================================================
// 3. publishAssessment pool-size pre-flight
// ===========================================================================

describe("publishAssessment pool-size pre-flight", () => {
  it("pack with 5 active questions, assessment with question_count=12 → ValidationError(POOL_TOO_SMALL)", async () => {
    const { packId, levelId } = await buildPublishedPack(tenantA, adminA, 5);
    const assessment = await createAssessment(
      tenantA,
      { pack_id: packId, level_id: levelId, name: "Pool Too Small", question_count: 12 },
      adminA,
    );

    await expect(publishAssessment(tenantA, assessment.id)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ValidationError &&
        (e.details as Record<string, unknown> | undefined)?.["code"] === AL_ERROR_CODES.POOL_TOO_SMALL &&
        (e.details as Record<string, unknown> | undefined)?.["available"] === 5 &&
        (e.details as Record<string, unknown> | undefined)?.["required"] === 12,
    );
  });

  it("pack with 5 active questions, assessment with question_count=5 → publish succeeds, status='published'", async () => {
    const { packId, levelId } = await buildPublishedPack(tenantA, adminA, 5);
    const assessment = await createAssessment(
      tenantA,
      { pack_id: packId, level_id: levelId, name: "Exact Pool", question_count: 5 },
      adminA,
    );

    const published = await publishAssessment(tenantA, assessment.id);
    expect(published.status).toBe("published");
  });
});

// ===========================================================================
// 4. State machine integration via service
// ===========================================================================

describe("State machine integration via service", () => {
  let packId: string;
  let levelId: string;

  beforeAll(async () => {
    ({ packId, levelId } = await buildPublishedPack(tenantA, adminA, 5));
  });

  it("closeAssessment on a draft assessment → ValidationError(INVALID_STATE_TRANSITION)", async () => {
    const assessment = await createAssessment(
      tenantA,
      { pack_id: packId, level_id: levelId, name: "Close Draft", question_count: 5 },
      adminA,
    );
    // draft → closed is illegal
    await expect(closeAssessment(tenantA, assessment.id)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ValidationError &&
        (e.details as Record<string, unknown> | undefined)?.["code"] === AL_ERROR_CODES.INVALID_STATE_TRANSITION,
    );
  });

  it("closeAssessment on an active assessment → status='closed'", async () => {
    const assessment = await createAssessment(
      tenantA,
      { pack_id: packId, level_id: levelId, name: "Close Active", question_count: 5 },
      adminA,
    );
    await publishAssessment(tenantA, assessment.id);

    // Directly advance to 'active' via repo (bypasses the service to skip time dependency)
    await withSuperClient(async (client) => {
      await client.query(
        `UPDATE assessments SET status = 'active' WHERE id = $1`,
        [assessment.id],
      );
    });

    const closed = await closeAssessment(tenantA, assessment.id);
    expect(closed.status).toBe("closed");
  });

  it("reopenAssessment on a closed assessment with closes_at 1h in the future → status='published'", async () => {
    const assessment = await createAssessment(
      tenantA,
      {
        pack_id: packId,
        level_id: levelId,
        name: "Reopen Future",
        question_count: 5,
        closes_at: new Date(Date.now() + 60 * 60_000),
      },
      adminA,
    );
    await publishAssessment(tenantA, assessment.id);
    // Force to closed
    await withSuperClient(async (client) => {
      await client.query(
        `UPDATE assessments SET status = 'closed' WHERE id = $1`,
        [assessment.id],
      );
    });

    const reopened = await reopenAssessment(tenantA, assessment.id);
    expect(reopened.status).toBe("published");
  });

  it("reopenAssessment on a closed assessment with closes_at 1h in the PAST → ValidationError(REOPEN_PAST_CLOSES_AT)", async () => {
    const assessment = await createAssessment(
      tenantA,
      {
        pack_id: packId,
        level_id: levelId,
        name: "Reopen Past",
        question_count: 5,
        opens_at: new Date(Date.now() - 2 * 60 * 60_000),
        closes_at: new Date(Date.now() - 60 * 60_000),
      },
      adminA,
    );
    await publishAssessment(tenantA, assessment.id);
    await withSuperClient(async (client) => {
      await client.query(
        `UPDATE assessments SET status = 'closed' WHERE id = $1`,
        [assessment.id],
      );
    });

    await expect(reopenAssessment(tenantA, assessment.id)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ValidationError &&
        (e.details as Record<string, unknown> | undefined)?.["code"] === AL_ERROR_CODES.REOPEN_PAST_CLOSES_AT,
    );
  });

  it("publishAssessment on already-published → ValidationError(INVALID_STATE_TRANSITION)", async () => {
    const assessment = await createAssessment(
      tenantA,
      { pack_id: packId, level_id: levelId, name: "Re-publish Test", question_count: 5 },
      adminA,
    );
    await publishAssessment(tenantA, assessment.id);

    // Attempt to publish again — published → published is a self-transition, illegal
    await expect(publishAssessment(tenantA, assessment.id)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ValidationError &&
        (e.details as Record<string, unknown> | undefined)?.["code"] === AL_ERROR_CODES.INVALID_STATE_TRANSITION,
    );
  });
});

// ===========================================================================
// 5. Boundary cron — processBoundariesForTenant
// ===========================================================================

describe("Boundary cron — processBoundariesForTenant", () => {
  let packId: string;
  let levelId: string;

  beforeAll(async () => {
    ({ packId, levelId } = await buildPublishedPack(tenantA, adminA, 5));
  });

  it("published + opens_at past → activated=1; re-fetch shows status='active'", async () => {
    const assessment = await createAssessment(
      tenantA,
      {
        pack_id: packId,
        level_id: levelId,
        name: "Boundary Activate",
        question_count: 5,
        opens_at: new Date(Date.now() - 5 * 60_000),
        closes_at: new Date(Date.now() + 60 * 60_000),
      },
      adminA,
    );
    await publishAssessment(tenantA, assessment.id);

    const result = await processBoundariesForTenant(tenantA, new Date());
    expect(result.activated).toBeGreaterThanOrEqual(1);
    expect(result.closed).toBe(0);

    const refetched = await getAssessment(tenantA, assessment.id);
    expect(refetched.status).toBe("active");
  });

  it("active + closes_at past → closed=1; re-fetch shows status='closed'", async () => {
    const assessment = await createAssessment(
      tenantA,
      {
        pack_id: packId,
        level_id: levelId,
        name: "Boundary Close",
        question_count: 5,
        opens_at: new Date(Date.now() - 2 * 60 * 60_000),
        closes_at: new Date(Date.now() - 5 * 60_000),
      },
      adminA,
    );
    await publishAssessment(tenantA, assessment.id);
    // Force status to active directly
    await withSuperClient(async (client) => {
      await client.query(
        `UPDATE assessments SET status = 'active' WHERE id = $1`,
        [assessment.id],
      );
    });

    const result = await processBoundariesForTenant(tenantA, new Date());
    expect(result.closed).toBeGreaterThanOrEqual(1);

    const refetched = await getAssessment(tenantA, assessment.id);
    expect(refetched.status).toBe("closed");
  });

  it("idempotency: second call with same now returns { activated: 0, closed: 0 }", async () => {
    // Use a fixed past time so no further rows match the second call
    const assessment = await createAssessment(
      tenantA,
      {
        pack_id: packId,
        level_id: levelId,
        name: "Boundary Idem",
        question_count: 5,
        opens_at: new Date(Date.now() - 5 * 60_000),
        closes_at: new Date(Date.now() + 60 * 60_000),
      },
      adminA,
    );
    await publishAssessment(tenantA, assessment.id);

    const pinned = new Date();
    await processBoundariesForTenant(tenantA, pinned);

    // Second call at the same instant — no new rows to advance
    const second = await processBoundariesForTenant(tenantA, pinned);
    expect(second.activated).toBe(0);
    expect(second.closed).toBe(0);
  });

  it("stale window (both opens_at and closes_at past): published → closed directly", async () => {
    const assessment = await createAssessment(
      tenantA,
      {
        pack_id: packId,
        level_id: levelId,
        name: "Stale Window",
        question_count: 5,
        opens_at: new Date(Date.now() - 2 * 60 * 60_000),
        closes_at: new Date(Date.now() - 60 * 60_000),
      },
      adminA,
    );
    await publishAssessment(tenantA, assessment.id);

    await processBoundariesForTenant(tenantA, new Date());

    const refetched = await getAssessment(tenantA, assessment.id);
    expect(refetched.status).toBe("closed");
  });

  it("draft and cancelled assessments are NEVER touched by boundary call", async () => {
    const draftAssessment = await createAssessment(
      tenantA,
      {
        pack_id: packId,
        level_id: levelId,
        name: "Draft Untouched",
        question_count: 5,
        opens_at: new Date(Date.now() - 5 * 60_000),
        closes_at: new Date(Date.now() + 60 * 60_000),
      },
      adminA,
    );
    // Leave it in draft — do NOT publish

    // Create a cancelled assessment via direct SQL (service has no cancelAssessment in v1)
    const cancelledAssessment = await createAssessment(
      tenantA,
      {
        pack_id: packId,
        level_id: levelId,
        name: "Cancelled Untouched",
        question_count: 5,
        opens_at: new Date(Date.now() - 5 * 60_000),
        closes_at: new Date(Date.now() + 60 * 60_000),
      },
      adminA,
    );
    await withSuperClient(async (client) => {
      await client.query(
        `UPDATE assessments SET status = 'cancelled' WHERE id = $1`,
        [cancelledAssessment.id],
      );
    });

    await processBoundariesForTenant(tenantA, new Date());

    const refetchedDraft = await getAssessment(tenantA, draftAssessment.id);
    expect(refetchedDraft.status).toBe("draft");

    const refetchedCancelled = await getAssessment(tenantA, cancelledAssessment.id);
    expect(refetchedCancelled.status).toBe("cancelled");
  });
});

// ===========================================================================
// 6. Invitation flow
// ===========================================================================

describe("Invitation flow", () => {
  let packId: string;
  let levelId: string;
  let assessmentId: string;
  let candidateU1: string;
  let candidateU2: string;
  let candidateEmail1: string;

  beforeAll(async () => {
    ({ packId, levelId } = await buildPublishedPack(tenantA, adminA, 5));
    const assessment = await createAssessment(
      tenantA,
      { pack_id: packId, level_id: levelId, name: "Invite Test Assessment", question_count: 5 },
      adminA,
    );
    await publishAssessment(tenantA, assessment.id);
    assessmentId = assessment.id;

    candidateU1 = randomUUID();
    candidateU2 = randomUUID();
    candidateEmail1 = `cand1-${randomUUID().slice(0, 8)}@example.com`;
    const candidateEmail2 = `cand2-${randomUUID().slice(0, 8)}@example.com`;

    await withSuperClient(async (client) => {
      await insertCandidateUser(client, candidateU1, tenantA, candidateEmail1, "Candidate One");
      await insertCandidateUser(client, candidateU2, tenantA, candidateEmail2, "Candidate Two");
    });
  });

  it("inviteUsers([u1, u2]) → invited.length=2, skipped is empty, both pending", async () => {
    const result = await inviteUsers(tenantA, assessmentId, [candidateU1, candidateU2], adminA);
    expect(result.invited).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
    for (const inv of result.invited) {
      expect(inv.status).toBe("pending");
    }
  });

  it("invited invitations have distinct token_hash values", async () => {
    const rows = await withSuperClient(async (client) => {
      const r = await client.query<{ token_hash: string }>(
        `SELECT token_hash FROM assessment_invitations WHERE assessment_id = $1 ORDER BY created_at`,
        [assessmentId],
      );
      return r.rows;
    });
    const hashes = rows.map((r) => r.token_hash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("re-inviteUsers([u1]) → invited=0, skipped=1 with reason INVITATION_EXISTS", async () => {
    const result = await inviteUsers(tenantA, assessmentId, [candidateU1], adminA);
    expect(result.invited).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe("INVITATION_EXISTS");
  });

  it("inviteUsers with non-existent user_id → skipped with reason USER_NOT_FOUND", async () => {
    const ghost = randomUUID();
    const result = await inviteUsers(tenantA, assessmentId, [ghost], adminA);
    expect(result.invited).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe("USER_NOT_FOUND");
  });

  it("inviteUsers with admin user → skipped with reason USER_NOT_CANDIDATE", async () => {
    const result = await inviteUsers(tenantA, assessmentId, [adminA], adminA);
    expect(result.invited).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe("USER_NOT_CANDIDATE");
  });

  it("inviteUsers against a draft assessment → ConflictError(INVALID_STATE_TRANSITION)", async () => {
    const draftAssessment = await createAssessment(
      tenantA,
      { pack_id: packId, level_id: levelId, name: "Draft Invite", question_count: 5 },
      adminA,
    );
    await expect(
      inviteUsers(tenantA, draftAssessment.id, [candidateU1], adminA),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConflictError &&
        (e.details as Record<string, unknown> | undefined)?.["code"] === AL_ERROR_CODES.INVALID_STATE_TRANSITION,
    );
  });

  it("revokeInvitation → status='expired'; listInvitations({status:'expired'}) sees the row", async () => {
    // Build a fresh assessment + fresh candidate so we have a pending invitation to revoke
    const { packId: p2, levelId: l2 } = await buildPublishedPack(tenantA, adminA, 5);
    const a2 = await createAssessment(
      tenantA,
      { pack_id: p2, level_id: l2, name: "Revoke Test", question_count: 5 },
      adminA,
    );
    await publishAssessment(tenantA, a2.id);

    const c3 = randomUUID();
    await withSuperClient(async (client) => {
      await insertCandidateUser(client, c3, tenantA, `revoke-${randomUUID().slice(0, 8)}@example.com`, "Revoke Cand");
    });

    const inviteResult = await inviteUsers(tenantA, a2.id, [c3], adminA);
    const invitationId = inviteResult.invited[0]!.id;

    await revokeInvitation(tenantA, invitationId);

    const { items } = await listInvitations(tenantA, a2.id, { status: "expired" });
    const ids = items.map((i) => i.id);
    expect(ids).toContain(invitationId);
  });

  it("revokeInvitation twice on same id is a no-op — does NOT throw", async () => {
    const { packId: p3, levelId: l3 } = await buildPublishedPack(tenantA, adminA, 5);
    const a3 = await createAssessment(
      tenantA,
      { pack_id: p3, level_id: l3, name: "Double Revoke", question_count: 5 },
      adminA,
    );
    await publishAssessment(tenantA, a3.id);

    const c4 = randomUUID();
    await withSuperClient(async (client) => {
      await insertCandidateUser(client, c4, tenantA, `double-${randomUUID().slice(0, 8)}@example.com`, "Double Cand");
    });

    const invResult = await inviteUsers(tenantA, a3.id, [c4], adminA);
    const invId = invResult.invited[0]!.id;

    await revokeInvitation(tenantA, invId);
    await expect(revokeInvitation(tenantA, invId)).resolves.toBeUndefined();
  });

  it("token hashing: generated invitation has token_hash === sha256(plaintext)", () => {
    const { plaintext, hash } = generateInvitationToken();
    const recomputed = hashInvitationToken(plaintext);
    expect(recomputed).toBe(hash);
    // sha256 hex output is 64 chars
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
  });
});

// ===========================================================================
// 7. Cross-tenant RLS
// ===========================================================================

describe("Cross-tenant RLS isolation", () => {
  let assessmentIdA: string;

  beforeAll(async () => {
    const { packId, levelId } = await buildPublishedPack(tenantA, adminA, 3);
    const assessment = await createAssessment(
      tenantA,
      { pack_id: packId, level_id: levelId, name: "RLS Test A", question_count: 3 },
      adminA,
    );
    assessmentIdA = assessment.id;
  });

  it("tenantB.listAssessments() does NOT include tenantA's assessment", async () => {
    const { items } = await listAssessments(tenantB);
    const ids = items.map((a) => a.id);
    expect(ids).not.toContain(assessmentIdA);
  });

  it("tenantB.getAssessment(tenantA assessmentId) throws NotFoundError (RLS makes it invisible)", async () => {
    await expect(getAssessment(tenantB, assessmentIdA)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("direct SQL with assessiq_app role + tenantB GUC returns 0 rows for tenantA assessment_invitations", async () => {
    // Seed a candidate and invite them so there is at least one invitation row for assessmentIdA
    const { packId: pA, levelId: lA } = await buildPublishedPack(tenantA, adminA, 3);
    const aA2 = await createAssessment(
      tenantA,
      { pack_id: pA, level_id: lA, name: "RLS Invite A", question_count: 3 },
      adminA,
    );
    await publishAssessment(tenantA, aA2.id);

    const cRls = randomUUID();
    await withSuperClient(async (client) => {
      await insertCandidateUser(client, cRls, tenantA, `rls-${randomUUID().slice(0, 8)}@example.com`, "RLS Cand");
    });
    await inviteUsers(tenantA, aA2.id, [cRls], adminA);

    // Now query as tenantB — JOIN-based RLS must return 0 rows
    const rows = await withSuperClient(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE assessiq_app");
        await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenantB]);
        const r = await client.query(
          `SELECT id FROM assessment_invitations WHERE assessment_id = $1`,
          [aA2.id],
        );
        await client.query("COMMIT");
        return r.rows;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    });
    expect(rows).toHaveLength(0);
  });
});

// ===========================================================================
// 8. Dev-email log assertion
// ===========================================================================

describe("Dev-email log — invitation.assessment template written to stub", () => {
  let savedEnv: string | undefined;
  let logPath: string;
  let packId: string;
  let levelId: string;
  let candidateEmail: string;
  let assessmentId: string;

  beforeAll(async () => {
    // Pin ASSESSIQ_DEV_EMAILS_LOG to a temp file before inviteUsers is called
    logPath = join(os.tmpdir(), `aiq-test-emails-${randomUUID()}.log`);
    savedEnv = process.env["ASSESSIQ_DEV_EMAILS_LOG"];
    process.env["ASSESSIQ_DEV_EMAILS_LOG"] = logPath;

    // Build pack + assessment
    ({ packId, levelId } = await buildPublishedPack(tenantA, adminA, 5));
    const assessment = await createAssessment(
      tenantA,
      { pack_id: packId, level_id: levelId, name: "Email Log Test", question_count: 5 },
      adminA,
    );
    await publishAssessment(tenantA, assessment.id);
    assessmentId = assessment.id;

    // Seed a candidate user
    const candidateId = randomUUID();
    candidateEmail = `email-log-${randomUUID().slice(0, 8)}@example.com`;
    await withSuperClient(async (client) => {
      await insertCandidateUser(client, candidateId, tenantA, candidateEmail, "Email Log Cand");
    });

    // Invite — this triggers sendAssessmentInvitationEmail → dev-emails stub
    await inviteUsers(tenantA, assessmentId, [candidateId], adminA);
  });

  afterAll(() => {
    // Restore env var
    if (savedEnv === undefined) {
      delete process.env["ASSESSIQ_DEV_EMAILS_LOG"];
    } else {
      process.env["ASSESSIQ_DEV_EMAILS_LOG"] = savedEnv;
    }
  });

  it("dev-emails.log has at least one record with template_id === 'invitation.assessment'", async () => {
    const raw = await readFile(logPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const records = lines.map((l) => JSON.parse(l) as {
      ts: string;
      to: string;
      subject: string;
      body: string;
      template_id: string;
    });

    const match = records.find((r) => r.template_id === "invitation.assessment");
    expect(match).toBeDefined();
    expect(match!.to).toBe(candidateEmail);
  });

  it("the matching record has the invitation link (with plaintext token) inside body only", async () => {
    const raw = await readFile(logPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const records = lines.map((l) => JSON.parse(l) as {
      ts: string;
      to: string;
      subject: string;
      body: string;
      template_id: string;
    });

    const match = records.find(
      (r) => r.template_id === "invitation.assessment" && r.to === candidateEmail,
    );
    expect(match).toBeDefined();

    // body must contain /invite/ (the invitation link path)
    expect(match!.body).toContain("/invite/");

    // The token must NOT appear in to, subject, template_id, or ts
    // (we verify by checking the body has the link but other fields are clean)
    const tokenInBody = match!.body.match(/\/invite\/([A-Za-z0-9_-]+)/)?.[1];
    expect(tokenInBody).toBeDefined();
    expect(match!.to).not.toContain(tokenInBody!);
    expect(match!.subject).not.toContain(tokenInBody!);
    expect(match!.template_id).not.toContain(tokenInBody!);
  });
});

// ===========================================================================
// Bonus: previewAssessment smoke test
// ===========================================================================

describe("previewAssessment smoke test", () => {
  it("pack with 7 active questions, assessment with question_count=5 → pool_size=7, questions.length=5", async () => {
    const { packId, levelId } = await buildPublishedPack(tenantA, adminA, 7);
    const assessment = await createAssessment(
      tenantA,
      { pack_id: packId, level_id: levelId, name: "Preview Smoke", question_count: 5 },
      adminA,
    );

    const preview = await previewAssessment(tenantA, assessment.id);
    expect(preview.pool_size).toBe(7);
    expect(preview.question_count).toBe(5);
    expect(preview.questions).toHaveLength(5);
    expect(preview.assessment_id).toBe(assessment.id);
    expect(preview.pack_id).toBe(packId);
  });
});
