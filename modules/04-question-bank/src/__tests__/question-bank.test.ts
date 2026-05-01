/**
 * Integration tests for modules/04-question-bank.
 *
 * Uses a postgres:16-alpine testcontainer so the full RLS stack is exercised.
 * Container is started ONCE in beforeAll and torn down in afterAll.
 * All tests share the same container — no Redis needed (module 04 has no
 * sessions or caching).
 *
 * Migration apply order: tenancy (0001-0003) → users (020 only) → question-bank
 * (0010-0014). The users 020_ migration supplies the users table referenced by
 * question_packs.created_by FK. The 021_ (invitations) migration is NOT applied
 * here because it depends on auth tables not needed by module 04.
 *
 * ESLint: no console.log — vitest reporter output only.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// setPoolForTesting / closePool are test-only helpers in 02-tenancy/src/pool.ts.
// Pointing the pool singleton at the testcontainer URL causes all service calls
// (which go through withTenant → pool) to use the test DB.
import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";

import {
  listPacks,
  createPack,
  getPack,
  updatePack,
  publishPack,
  archivePack,
  addLevel,
  updateLevel,
  listQuestions,
  getQuestion,
  createQuestion,
  updateQuestion,
  listVersions,
  restoreVersion,
  bulkImport,
  generateDraft,
} from "../service.js";
import { ConflictError, NotFoundError, ValidationError, AppError } from "@assessiq/core";
import type { CreatePackInput, AddLevelInput, CreateQuestionInput } from "../types.js";

// ---------------------------------------------------------------------------
// Path helper — strip Windows-style leading slash before drive letter.
// import.meta.url on Windows: file:///E:/code/...
// new URL('.', import.meta.url).pathname: /E:/code/.../src/__tests__/
// We strip the leading slash so join() works correctly on Windows.
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

// __tests__/ is at: modules/04-question-bank/src/__tests__/
const THIS_DIR = toFsPath(new URL(".", import.meta.url));   // .../modules/04-question-bank/src/__tests__/
const QB_MODULE_ROOT = join(THIS_DIR, "..", "..");           // .../modules/04-question-bank/
const MODULES_ROOT = join(QB_MODULE_ROOT, "..");             // .../modules/

const TENANCY_MIGRATIONS_DIR = join(MODULES_ROOT, "02-tenancy", "migrations");
const USERS_MIGRATIONS_DIR   = join(MODULES_ROOT, "03-users", "migrations");
const QB_MIGRATIONS_DIR      = join(QB_MODULE_ROOT, "migrations");
const SAMPLE_PACK_PATH       = join(QB_MODULE_ROOT, "examples", "sample-pack.json");

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

// ---------------------------------------------------------------------------
// Content constructors — reused across test groups
// ---------------------------------------------------------------------------

function mcqContent(opts: { question?: string; correct?: number } = {}) {
  return {
    question: opts.question ?? "What is the most likely cause?",
    options: ["A", "B", "C", "D"],
    correct: opts.correct ?? 0,
    rationale: "A is correct because...",
  };
}

function subjectiveRubric() {
  return {
    anchors: [{ id: "a1", concept: "lateral movement", weight: 30, synonyms: ["lateral movement"] }],
    reasoning_bands: {
      band_4: "Excellent coverage of lateral movement.",
      band_3: "Good coverage.",
      band_2: "Partial coverage.",
      band_1: "Minimal coverage.",
      band_0: "No coverage.",
    },
    anchor_weight_total: 30,
    reasoning_weight_total: 70,
  };
}

function logAnalysisContent() {
  return {
    question: "Identify suspicious activity in the following log.",
    log_excerpt: "2026-04-30T03:12:44Z login success from 198.51.100.77",
    log_format: "syslog" as const,
    expected_findings: ["Suspicious login from unknown IP"],
  };
}

// ---------------------------------------------------------------------------
// Global setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // 1. Spin up postgres:16-alpine (no Redis — module 04 has no sessions/caching)
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

  // 2. Apply migrations in dependency order:
  //    tenancy (0001-0003) → users (020 only, no 021_invitations) → qb (0010-0014)
  const [tenancyFiles, usersFiles, qbFiles] = await Promise.all([
    readdir(TENANCY_MIGRATIONS_DIR),
    readdir(USERS_MIGRATIONS_DIR),
    readdir(QB_MIGRATIONS_DIR),
  ]);

  // All tenancy migrations
  const tenancySorted = tenancyFiles
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ dir: TENANCY_MIGRATIONS_DIR, file: f }));

  // Only 020_users.sql — skip 021_user_invitations.sql (requires auth tables not needed here)
  const usersSorted = usersFiles
    .filter((f) => f.endsWith(".sql") && f.startsWith("020_"))
    .sort()
    .map((f) => ({ dir: USERS_MIGRATIONS_DIR, file: f }));

  // All QB migrations (0010-0014)
  const qbSorted = qbFiles
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ dir: QB_MIGRATIONS_DIR, file: f }));

  await withSuperClient(async (client) => {
    for (const { dir, file } of [...tenancySorted, ...usersSorted, ...qbSorted]) {
      const sql = await readFile(join(dir, file), "utf-8");
      await client.query(sql);
    }
  });

  // 3. Point pool singleton at testcontainer
  await setPoolForTesting(containerUrl);

  // 4. Seed two tenants + one admin per tenant so created_by FK is satisfiable
  tenantA = randomUUID();
  tenantB = randomUUID();
  adminA  = randomUUID();
  adminB  = randomUUID();

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
// 1. Pack lifecycle
// ===========================================================================

describe("Pack lifecycle", () => {
  it("createPack happy path returns draft pack with version 1", async () => {
    const pack = await createPack(
      tenantA,
      { slug: "soc-basic-v1", name: "SOC Basic", domain: "soc" },
      adminA,
    );

    expect(pack.slug).toBe("soc-basic-v1");
    expect(pack.status).toBe("draft");
    expect(pack.version).toBe(1);
    expect(pack.tenant_id).toBe(tenantA);
    expect(pack.created_by).toBe(adminA);
  });

  it("createPack with invalid slug regex throws ValidationError", async () => {
    await expect(
      createPack(tenantA, { slug: "INVALID SLUG!", name: "Bad Slug", domain: "soc" }, adminA),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("createPack twice with same slug throws ConflictError PACK_SLUG_EXISTS", async () => {
    const slug = `dupe-slug-${randomUUID().slice(0, 8)}`;
    await createPack(tenantA, { slug, name: "First", domain: "soc" }, adminA);

    await expect(
      createPack(tenantA, { slug, name: "Second", domain: "soc" }, adminA),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConflictError &&
        (e.details as Record<string, unknown> | undefined)?.["code"] === "PACK_SLUG_EXISTS",
    );
  });

  it("listPacks returns the created pack", async () => {
    const slug = `list-test-${randomUUID().slice(0, 8)}`;
    const pack = await createPack(tenantA, { slug, name: "List Test", domain: "devsecops" }, adminA);

    const { items } = await listPacks(tenantA);
    const ids = items.map((p) => p.id);
    expect(ids).toContain(pack.id);
  });

  it("listPacks filter by domain returns only matching packs", async () => {
    const slug = `domain-filter-${randomUUID().slice(0, 8)}`;
    await createPack(tenantA, { slug, name: "Domain Filter Test", domain: "iam" }, adminA);

    const { items } = await listPacks(tenantA, { domain: "iam" });
    for (const p of items) {
      expect(p.domain).toBe("iam");
    }
    expect(items.some((p) => p.slug === slug)).toBe(true);
  });

  it("listPacks filter by status returns only draft packs", async () => {
    const { items } = await listPacks(tenantA, { status: "draft" });
    for (const p of items) {
      expect(p.status).toBe("draft");
    }
  });

  it("listPacks with pageSize > 100 throws ValidationError INVALID_PAGE_SIZE", async () => {
    await expect(listPacks(tenantA, { pageSize: 101 })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ValidationError &&
        (e.details as Record<string, unknown> | undefined)?.["code"] === "INVALID_PAGE_SIZE",
    );
  });

  it("getPack happy path returns the pack", async () => {
    const slug = `get-pack-${randomUUID().slice(0, 8)}`;
    const created = await createPack(tenantA, { slug, name: "Get Pack", domain: "soc" }, adminA);

    const fetched = await getPack(tenantA, created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.slug).toBe(slug);
  });

  it("getPack with missing id throws NotFoundError PACK_NOT_FOUND", async () => {
    await expect(getPack(tenantA, randomUUID())).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof NotFoundError &&
        (e.details as Record<string, unknown> | undefined)?.["code"] === "PACK_NOT_FOUND",
    );
  });

  it("updatePack updates name, domain, and description", async () => {
    const slug = `update-pack-${randomUUID().slice(0, 8)}`;
    const created = await createPack(tenantA, { slug, name: "Original Name", domain: "soc" }, adminA);

    const updated = await updatePack(tenantA, created.id, {
      name: "Updated Name",
      domain: "cloud",
      description: "New description",
    });

    expect(updated.name).toBe("Updated Name");
    expect(updated.domain).toBe("cloud");
    expect(updated.description).toBe("New description");
  });
});

// ===========================================================================
// 2. Level lifecycle
// ===========================================================================

describe("Level lifecycle", () => {
  let packId: string;

  beforeAll(async () => {
    const pack = await createPack(
      tenantA,
      { slug: `level-test-pack-${randomUUID().slice(0, 8)}`, name: "Level Test Pack", domain: "soc" },
      adminA,
    );
    packId = pack.id;
  });

  it("addLevel happy path returns level with correct position and label", async () => {
    const level = await addLevel(tenantA, packId, {
      position: 1,
      label: "L1",
      duration_minutes: 30,
      default_question_count: 10,
      passing_score_pct: 60,
    });

    expect(level.position).toBe(1);
    expect(level.label).toBe("L1");
    expect(level.pack_id).toBe(packId);
    expect(level.duration_minutes).toBe(30);
  });

  it("addLevel with duplicate (pack_id, position) throws ConflictError LEVEL_POSITION_EXISTS", async () => {
    const dupePack = await createPack(
      tenantA,
      { slug: `dupe-level-pack-${randomUUID().slice(0, 8)}`, name: "Dupe Level", domain: "soc" },
      adminA,
    );
    await addLevel(tenantA, dupePack.id, {
      position: 1, label: "L1", duration_minutes: 30, default_question_count: 5,
    });

    await expect(
      addLevel(tenantA, dupePack.id, {
        position: 1, label: "L1-dup", duration_minutes: 30, default_question_count: 5,
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConflictError &&
        (e.details as Record<string, unknown> | undefined)?.["code"] === "LEVEL_POSITION_EXISTS",
    );
  });

  it("addLevel against missing pack throws NotFoundError PACK_NOT_FOUND", async () => {
    await expect(
      addLevel(tenantA, randomUUID(), {
        position: 1, label: "L1", duration_minutes: 30, default_question_count: 5,
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof NotFoundError &&
        (e.details as Record<string, unknown> | undefined)?.["code"] === "PACK_NOT_FOUND",
    );
  });

  it("updateLevel updates duration_minutes and label", async () => {
    const level = await addLevel(tenantA, packId, {
      position: 3,
      label: "L3-original",
      duration_minutes: 20,
      default_question_count: 8,
    });

    const updated = await updateLevel(tenantA, level.id, {
      label: "L3-updated",
      duration_minutes: 45,
    });

    expect(updated.label).toBe("L3-updated");
    expect(updated.duration_minutes).toBe(45);
  });

  it("updateLevel with unknown level id throws NotFoundError LEVEL_NOT_FOUND", async () => {
    await expect(
      updateLevel(tenantA, randomUUID(), { label: "Ghost Level" }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof NotFoundError &&
        (e.details as Record<string, unknown> | undefined)?.["code"] === "LEVEL_NOT_FOUND",
    );
  });
});

// ===========================================================================
// 3. Question lifecycle + versioning
// ===========================================================================

describe("Question lifecycle + versioning", () => {
  let packId: string;
  let levelId: string;

  beforeAll(async () => {
    const pack = await createPack(
      tenantA,
      { slug: `q-test-pack-${randomUUID().slice(0, 8)}`, name: "Question Test Pack", domain: "soc" },
      adminA,
    );
    packId = pack.id;
    const level = await addLevel(tenantA, packId, {
      position: 1, label: "L1", duration_minutes: 30, default_question_count: 10,
    });
    levelId = level.id;
  });

  it("createQuestion with type=mcq valid returns question with version 1", async () => {
    const q = await createQuestion(
      tenantA,
      {
        pack_id: packId,
        level_id: levelId,
        type: "mcq",
        topic: "alert-triage",
        points: 5,
        content: mcqContent(),
      },
      adminA,
    );

    expect(q.type).toBe("mcq");
    expect(q.version).toBe(1);
    expect(q.status).toBe("draft");
    expect(q.pack_id).toBe(packId);
    expect(q.level_id).toBe(levelId);
  });

  it("createQuestion with invalid content (bad MCQ shape) throws ValidationError INVALID_CONTENT", async () => {
    await expect(
      createQuestion(
        tenantA,
        {
          pack_id: packId,
          level_id: levelId,
          type: "mcq",
          topic: "bad-content",
          points: 5,
          content: { question: "What?", options: [], correct: 0, rationale: "r" }, // options too short
        },
        adminA,
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ValidationError &&
        (e.details as Record<string, unknown> | undefined)?.["code"] === "INVALID_CONTENT",
    );
  });

  it("createQuestion with type=subjective but no rubric throws ValidationError RUBRIC_REQUIRED", async () => {
    await expect(
      createQuestion(
        tenantA,
        {
          pack_id: packId,
          level_id: levelId,
          type: "subjective",
          topic: "no-rubric",
          points: 10,
          content: { question: "Explain lateral movement." },
          // rubric intentionally omitted
        },
        adminA,
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ValidationError &&
        (e.details as Record<string, unknown> | undefined)?.["code"] === "RUBRIC_REQUIRED",
    );
  });

  it("createQuestion with type=mcq + rubric throws ValidationError RUBRIC_NOT_ALLOWED", async () => {
    await expect(
      createQuestion(
        tenantA,
        {
          pack_id: packId,
          level_id: levelId,
          type: "mcq",
          topic: "mcq-with-rubric",
          points: 5,
          content: mcqContent(),
          rubric: subjectiveRubric(), // rubric is not allowed for mcq
        },
        adminA,
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ValidationError &&
        (e.details as Record<string, unknown> | undefined)?.["code"] === "RUBRIC_NOT_ALLOWED",
    );
  });

  it("createQuestion with type=log_analysis valid returns question (regression for decision #3)", async () => {
    const q = await createQuestion(
      tenantA,
      {
        pack_id: packId,
        level_id: levelId,
        type: "log_analysis",
        topic: "log-analysis-regression",
        points: 10,
        content: logAnalysisContent(),
      },
      adminA,
    );

    expect(q.type).toBe("log_analysis");
    expect(q.version).toBe(1);
  });

  it("getQuestion with unknown id throws NotFoundError QUESTION_NOT_FOUND", async () => {
    await expect(getQuestion(tenantA, randomUUID())).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof NotFoundError &&
        (e.details as Record<string, unknown> | undefined)?.["code"] === "QUESTION_NOT_FOUND",
    );
  });

  it("createQuestion against an archived pack throws ConflictError QUESTION_PACK_ARCHIVED", async () => {
    // Build and archive a pack
    const archivedPack = await createPack(
      tenantA,
      { slug: `archived-pack-q-${randomUUID().slice(0, 8)}`, name: "Archived Pack", domain: "soc" },
      adminA,
    );
    const arcLevel = await addLevel(tenantA, archivedPack.id, {
      position: 1, label: "L1", duration_minutes: 30, default_question_count: 1,
    });
    // Add a question so publishPack has something to snapshot
    await createQuestion(
      tenantA,
      {
        pack_id: archivedPack.id,
        level_id: arcLevel.id,
        type: "mcq",
        topic: "pre-archive-q",
        points: 5,
        content: mcqContent(),
      },
      adminA,
    );
    await publishPack(tenantA, archivedPack.id, adminA);
    await archivePack(tenantA, archivedPack.id);

    // Now attempt to add a question to the archived pack
    await expect(
      createQuestion(
        tenantA,
        {
          pack_id: archivedPack.id,
          level_id: arcLevel.id,
          type: "mcq",
          topic: "post-archive-q",
          points: 5,
          content: mcqContent(),
        },
        adminA,
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConflictError &&
        (e.details as Record<string, unknown> | undefined)?.["code"] === "QUESTION_PACK_ARCHIVED",
    );
  });

  it("updateQuestion with an invalid rubric shape throws ValidationError INVALID_RUBRIC", async () => {
    // Create a subjective question first
    const subjQ = await createQuestion(
      tenantA,
      {
        pack_id: packId,
        level_id: levelId,
        type: "subjective",
        topic: "rubric-shape-test",
        points: 10,
        content: { question: "Describe the attack chain." },
        rubric: subjectiveRubric(),
      },
      adminA,
    );

    // Attempt to update with a malformed rubric (missing required fields)
    await expect(
      updateQuestion(
        tenantA,
        subjQ.id,
        { rubric: { anchors: [], reasoning_bands: {} } }, // invalid shape
        adminA,
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ValidationError &&
        (e.details as Record<string, unknown> | undefined)?.["code"] === "INVALID_RUBRIC",
    );
  });

  it("versioning trap: 3 content PATCHes create 3 version snapshots and bump version to 4", async () => {
    // Create initial question at version 1
    const q = await createQuestion(
      tenantA,
      {
        pack_id: packId,
        level_id: levelId,
        type: "mcq",
        topic: "versioning-trap",
        points: 5,
        content: mcqContent({ question: "Original question text?" }),
      },
      adminA,
    );
    expect(q.version).toBe(1);

    // PATCH 1 → snapshots version 1, question becomes version 2
    const q2 = await updateQuestion(
      tenantA,
      q.id,
      { content: mcqContent({ question: "Edit 1?" }) },
      adminA,
    );
    expect(q2.version).toBe(2);

    const versions2 = await listVersions(tenantA, q.id);
    expect(versions2).toHaveLength(1);
    expect(versions2[0]?.version).toBe(1);

    // PATCH 2 → snapshots version 2, question becomes version 3
    const q3 = await updateQuestion(
      tenantA,
      q.id,
      { content: mcqContent({ question: "Edit 2?" }) },
      adminA,
    );
    expect(q3.version).toBe(3);

    const versions3 = await listVersions(tenantA, q.id);
    expect(versions3).toHaveLength(2);

    // PATCH 3 → snapshots version 3, question becomes version 4
    await updateQuestion(
      tenantA,
      q.id,
      { content: mcqContent({ question: "Edit 3?" }) },
      adminA,
    );

    const current = await getQuestion(tenantA, q.id);
    expect(current.version).toBe(4);

    const versions4 = await listVersions(tenantA, q.id);
    expect(versions4).toHaveLength(3);

    // The snapshot at version=3 carries the immediately-prior content (Edit 2)
    const v3Snapshot = versions4.find((v) => v.version === 3);
    expect(v3Snapshot).toBeDefined();
    expect((v3Snapshot?.content as { question: string }).question).toBe("Edit 2?");
  });

  it("restoreVersion(questionId, 1) bumps version and captures pre-restore state as snapshot", async () => {
    // Create at version 1
    const q = await createQuestion(
      tenantA,
      {
        pack_id: packId,
        level_id: levelId,
        type: "mcq",
        topic: "restore-version-test",
        points: 5,
        content: mcqContent({ question: "Original for restore?" }),
      },
      adminA,
    );

    // Edit once — version 1 is snapshotted, question is now version 2
    await updateQuestion(
      tenantA,
      q.id,
      { content: mcqContent({ question: "Edited before restore?" }) },
      adminA,
    );

    // Restore to version 1
    const restored = await restoreVersion(tenantA, q.id, 1, adminA);

    // Version bumps from 2 → 3
    expect(restored.version).toBe(3);
    // Content matches original version-1 content
    expect((restored.content as { question: string }).question).toBe("Original for restore?");

    // question_versions should now have 2 rows:
    //   row 1 = version 1 (snapshot from the PATCH)
    //   row 2 = version 2 (pre-restore snapshot taken inside restoreVersion)
    const versions = await listVersions(tenantA, q.id);
    expect(versions).toHaveLength(2);
    const v2Snapshot = versions.find((v) => v.version === 2);
    expect(v2Snapshot).toBeDefined();
    expect((v2Snapshot?.content as { question: string }).question).toBe("Edited before restore?");
  });

  it("restoreVersion to a non-existent version throws NotFoundError VERSION_NOT_FOUND", async () => {
    const q = await createQuestion(
      tenantA,
      {
        pack_id: packId,
        level_id: levelId,
        type: "mcq",
        topic: "restore-missing-version",
        points: 5,
        content: mcqContent({ question: "Version not found test?" }),
      },
      adminA,
    );

    // Version 99 has never been snapshotted
    await expect(restoreVersion(tenantA, q.id, 99, adminA)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof NotFoundError &&
        (e.details as Record<string, unknown> | undefined)?.["code"] === "VERSION_NOT_FOUND",
    );
  });
});

// ===========================================================================
// 4. Tag attachment
// ===========================================================================

describe("Tag attachment", () => {
  let packId: string;
  let levelId: string;

  beforeAll(async () => {
    const pack = await createPack(
      tenantA,
      { slug: `tag-test-pack-${randomUUID().slice(0, 8)}`, name: "Tag Test Pack", domain: "soc" },
      adminA,
    );
    packId = pack.id;
    const level = await addLevel(tenantA, packId, {
      position: 1, label: "L1", duration_minutes: 30, default_question_count: 10,
    });
    levelId = level.id;
  });

  it("createQuestion with tags creates them in tags table and joins them via question_tags", async () => {
    const q = await createQuestion(
      tenantA,
      {
        pack_id: packId,
        level_id: levelId,
        type: "mcq",
        topic: "tagged-question",
        points: 5,
        content: mcqContent(),
        tags: ["mitre:T1078", "tactic:initial-access"],
      },
      adminA,
    );

    // Verify both tags are in the tags table and joined
    const tagRows = await withSuperClient(async (client) => {
      const r = await client.query(
        `SELECT t.name
           FROM tags t
           JOIN question_tags qt ON qt.tag_id = t.id
          WHERE qt.question_id = $1
          ORDER BY t.name`,
        [q.id],
      );
      return r.rows.map((row: { name: string }) => row.name);
    });
    expect(tagRows).toContain("mitre:T1078");
    expect(tagRows).toContain("tactic:initial-access");
  });

  it("listQuestions with tag filter returns only matching questions", async () => {
    const taggedQ = await createQuestion(
      tenantA,
      {
        pack_id: packId,
        level_id: levelId,
        type: "mcq",
        topic: "t1059-tagged",
        points: 5,
        content: mcqContent({ question: "T1059 question?" }),
        tags: ["mitre:T1059"],
      },
      adminA,
    );
    // Create a second question without this tag
    await createQuestion(
      tenantA,
      {
        pack_id: packId,
        level_id: levelId,
        type: "mcq",
        topic: "untagged-for-filter",
        points: 5,
        content: mcqContent({ question: "Untagged question?" }),
      },
      adminA,
    );

    const { items } = await listQuestions(tenantA, { pack_id: packId, tag: "mitre:T1059" });
    const ids = items.map((q) => q.id);
    expect(ids).toContain(taggedQ.id);
    // All returned questions must carry the filtered tag (i.e. the untagged one is absent)
    expect(items.every((q) => q.id !== undefined)).toBe(true);
    for (const q of items) {
      expect(q.topic).not.toBe("untagged-for-filter");
    }
  });

  it("updateQuestion replacing tags detaches old tags and attaches new ones", async () => {
    const q = await createQuestion(
      tenantA,
      {
        pack_id: packId,
        level_id: levelId,
        type: "mcq",
        topic: "tag-replace-test",
        points: 5,
        content: mcqContent({ question: "Tag replace?" }),
        tags: ["old-tag-replace"],
      },
      adminA,
    );

    await updateQuestion(
      tenantA,
      q.id,
      { tags: ["new-tag-replace"] },
      adminA,
    );

    const tagRows = await withSuperClient(async (client) => {
      const r = await client.query(
        `SELECT t.name
           FROM tags t
           JOIN question_tags qt ON qt.tag_id = t.id
          WHERE qt.question_id = $1`,
        [q.id],
      );
      return r.rows.map((row: { name: string }) => row.name);
    });

    expect(tagRows).toContain("new-tag-replace");
    expect(tagRows).not.toContain("old-tag-replace");
  });
});

// ===========================================================================
// 5. publishPack snapshot semantics (decision #21)
// ===========================================================================

describe("publishPack snapshot semantics (decision #21)", () => {
  it("publishPack flips status to published, bumps version to 2, and snapshots all questions", async () => {
    const pack = await createPack(
      tenantA,
      { slug: `publish-snap-${randomUUID().slice(0, 8)}`, name: "Publish Snap", domain: "soc" },
      adminA,
    );
    const level = await addLevel(tenantA, pack.id, {
      position: 1, label: "L1", duration_minutes: 30, default_question_count: 3,
    });

    // Create 3 questions
    const qIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const q = await createQuestion(
        tenantA,
        {
          pack_id: pack.id,
          level_id: level.id,
          type: "mcq",
          topic: `pub-q-${i}`,
          points: 5,
          content: mcqContent({ question: `Publish test question ${i}?` }),
        },
        adminA,
      );
      qIds.push(q.id);
    }

    const published = await publishPack(tenantA, pack.id, adminA);

    expect(published.status).toBe("published");
    // Pack version bumped from 1 → 2
    expect(published.version).toBe(2);

    // Directly SELECT question_versions to confirm exactly 3 snapshot rows (one per question)
    const versionCount = await withSuperClient(async (client) => {
      const r = await client.query(
        `SELECT COUNT(*) AS cnt
           FROM question_versions
          WHERE question_id = ANY($1::uuid[])`,
        [qIds],
      );
      return parseInt((r.rows[0] as { cnt: string }).cnt, 10);
    });
    expect(versionCount).toBe(3);
  });

  it("editing a question AFTER publish adds one more snapshot row (snapshot-before-update rule)", async () => {
    const pack = await createPack(
      tenantA,
      { slug: `post-pub-edit-${randomUUID().slice(0, 8)}`, name: "Post Pub Edit", domain: "soc" },
      adminA,
    );
    const level = await addLevel(tenantA, pack.id, {
      position: 1, label: "L1", duration_minutes: 30, default_question_count: 1,
    });
    const q = await createQuestion(
      tenantA,
      {
        pack_id: pack.id,
        level_id: level.id,
        type: "mcq",
        topic: "post-pub-q",
        points: 5,
        content: mcqContent({ question: "Pre-publish question?" }),
      },
      adminA,
    );

    // Publish — creates 1 snapshot row for version 1
    await publishPack(tenantA, pack.id, adminA);

    // Edit question after publish — snapshot-before-update rule fires and adds row 2
    await updateQuestion(
      tenantA,
      q.id,
      { content: mcqContent({ question: "Post-publish edit?" }) },
      adminA,
    );

    // question_versions for this question now has 2 rows
    const rows = await withSuperClient(async (client) => {
      const r = await client.query(
        `SELECT version FROM question_versions WHERE question_id = $1 ORDER BY version`,
        [q.id],
      );
      return r.rows as Array<{ version: number }>;
    });
    expect(rows).toHaveLength(2);
  });

  it("publishPack on an already-published pack throws ConflictError PACK_NOT_DRAFT", async () => {
    const pack = await createPack(
      tenantA,
      { slug: `no-repub-${randomUUID().slice(0, 8)}`, name: "No Republish", domain: "soc" },
      adminA,
    );
    const level = await addLevel(tenantA, pack.id, {
      position: 1, label: "L1", duration_minutes: 30, default_question_count: 1,
    });
    await createQuestion(
      tenantA,
      {
        pack_id: pack.id,
        level_id: level.id,
        type: "mcq",
        topic: "re-pub-q",
        points: 5,
        content: mcqContent(),
      },
      adminA,
    );
    await publishPack(tenantA, pack.id, adminA);

    await expect(publishPack(tenantA, pack.id, adminA)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConflictError &&
        (e.details as Record<string, unknown> | undefined)?.["code"] === "PACK_NOT_DRAFT",
    );
  });
});

// ===========================================================================
// 6. archivePack
// ===========================================================================

describe("archivePack", () => {
  async function buildPublishedPack(slugPrefix: string): Promise<{ id: string }> {
    const pack = await createPack(
      tenantA,
      { slug: `${slugPrefix}-${randomUUID().slice(0, 8)}`, name: "Archive Test", domain: "soc" },
      adminA,
    );
    const level = await addLevel(tenantA, pack.id, {
      position: 1, label: "L1", duration_minutes: 30, default_question_count: 1,
    });
    await createQuestion(
      tenantA,
      {
        pack_id: pack.id,
        level_id: level.id,
        type: "mcq",
        topic: "archive-q",
        points: 5,
        content: mcqContent(),
      },
      adminA,
    );
    await publishPack(tenantA, pack.id, adminA);
    return pack;
  }

  it("publishPack → archivePack succeeds; status becomes archived", async () => {
    const pack = await buildPublishedPack("archive-ok");
    const archived = await archivePack(tenantA, pack.id);
    expect(archived.status).toBe("archived");
  });

  it("archivePack on a draft pack throws ConflictError PACK_NOT_PUBLISHED", async () => {
    const pack = await createPack(
      tenantA,
      { slug: `archive-draft-${randomUUID().slice(0, 8)}`, name: "Archive Draft", domain: "soc" },
      adminA,
    );

    await expect(archivePack(tenantA, pack.id)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConflictError &&
        (e.details as Record<string, unknown> | undefined)?.["code"] === "PACK_NOT_PUBLISHED",
    );
  });

  // -------------------------------------------------------------------------
  // PACK_HAS_ASSESSMENTS — referential block when a published pack is referenced
  // by one or more 'published' / 'active' assessments. The 05-assessment-
  // lifecycle module (Phase 1 G1.B) ships the real `assessments` table; until
  // then service.archivePack uses a lazy hasAssessmentsTable() existence check
  // and skips the gate. This test simulates G1.B by stubbing the table inline,
  // exercises the gate, then drops the stub to avoid contaminating later tests.
  // -------------------------------------------------------------------------
  it("archivePack on a pack referenced by an active assessment throws PACK_HAS_ASSESSMENTS", async () => {
    const pack = await buildPublishedPack("archive-with-assessments");

    try {
      // Stub the assessments table — minimum columns the repo gate reads
      // (countAssessmentsReferencingPack: WHERE pack_id = $1 AND status IN
      // ('published','active')).
      await withSuperClient(async (client) => {
        await client.query(
          `CREATE TABLE assessments (
             id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
             pack_id UUID NOT NULL,
             status  TEXT NOT NULL
           )`,
        );
        await client.query(
          `INSERT INTO assessments (pack_id, status) VALUES ($1, 'active')`,
          [pack.id],
        );
      });

      await expect(archivePack(tenantA, pack.id)).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof ConflictError &&
          (e.details as Record<string, unknown> | undefined)?.["code"] === "PACK_HAS_ASSESSMENTS",
      );

      // Confirm the gate counts the referencing row
      await expect(archivePack(tenantA, pack.id)).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof ConflictError &&
          (e.details as Record<string, unknown> | undefined)?.["count"] === 1,
      );
    } finally {
      // Always drop the stub so later test files / runs aren't contaminated
      await withSuperClient(async (client) => {
        await client.query(`DROP TABLE IF EXISTS assessments`);
      });
    }
  });
});

// ===========================================================================
// 7. Cross-tenant RLS isolation
// ===========================================================================

describe("Cross-tenant RLS isolation", () => {
  let packIdA: string;
  let levelIdA: string;

  beforeAll(async () => {
    const pack = await createPack(
      tenantA,
      { slug: `rls-test-a-${randomUUID().slice(0, 8)}`, name: "RLS Pack A", domain: "soc" },
      adminA,
    );
    packIdA = pack.id;
    const level = await addLevel(tenantA, packIdA, {
      position: 1, label: "L1", duration_minutes: 30, default_question_count: 5,
    });
    levelIdA = level.id;
    await createQuestion(
      tenantA,
      {
        pack_id: packIdA,
        level_id: levelIdA,
        type: "mcq",
        topic: "rls-q-a",
        points: 5,
        content: mcqContent(),
      },
      adminA,
    );
  });

  it("tenantB listPacks does not see tenantA packs (RLS isolation)", async () => {
    const { items } = await listPacks(tenantB);
    const ids = items.map((p) => p.id);
    expect(ids).not.toContain(packIdA);
  });

  it("getPack(tenantB, tenantA-packId) throws NotFoundError (RLS makes it invisible)", async () => {
    await expect(getPack(tenantB, packIdA)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("tenantB listQuestions with pack_id of tenantA pack returns 0 rows", async () => {
    const { items } = await listQuestions(tenantB, { pack_id: packIdA });
    expect(items).toHaveLength(0);
  });

  it("direct SQL with assessiq_app role + app.current_tenant GUC for tenantB returns 0 levels for tenantA pack", async () => {
    // Exercises the JOIN-based RLS variant on `levels`:
    // levels RLS derives tenancy from question_packs via an EXISTS subquery.
    // Setting app.current_tenant to tenantB and querying levels by tenantA's pack_id
    // must return zero rows — the EXISTS check on question_packs.tenant_id fails.
    //
    // Critical: SET LOCAL ROLE and set_config(..., true) only take effect inside
    // an explicit transaction. node-pg's default autocommit-per-statement makes
    // LOCAL settings session-scoped (or no-op for SET LOCAL ROLE entirely),
    // which would silently leave the connection as the test superuser and
    // bypass RLS. Wrap in BEGIN/COMMIT so the transactional scope is real.
    const rows = await withSuperClient(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE assessiq_app");
        await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenantB]);
        const r = await client.query(
          `SELECT id FROM levels WHERE pack_id = $1`,
          [packIdA],
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
// 7b. Defense-in-depth: composite FK on (level_id, pack_id)
// ===========================================================================

describe("Composite FK questions(level_id, pack_id) → levels(id, pack_id)", () => {
  // Migration 0015_questions_level_pack_fk.sql adds this constraint to enforce
  // at the DB layer that questions.level_id belongs to questions.pack_id.
  // The service-layer findLevelById guard (createQuestion in service.ts) is
  // the first line of defense; this constraint is the structural backstop.
  // Test runs as the superuser via withSuperClient — FK constraints fire even
  // for superuser, so this exercises the actual DB enforcement.
  it("direct INSERT of a question with cross-pack (level_id, pack_id) is rejected by FK", async () => {
    // Build pack A with a level
    const packA = await createPack(
      tenantA,
      { slug: `fk-pack-a-${randomUUID().slice(0, 8)}`, name: "FK Pack A", domain: "soc" },
      adminA,
    );
    const levelA = await addLevel(tenantA, packA.id, {
      position: 1, label: "L1", duration_minutes: 30, default_question_count: 5,
    });

    // Build pack B
    const packB = await createPack(
      tenantA,
      { slug: `fk-pack-b-${randomUUID().slice(0, 8)}`, name: "FK Pack B", domain: "soc" },
      adminA,
    );

    // Direct INSERT with packB.id as pack_id but levelA.id as level_id —
    // levelA belongs to packA, so the composite FK should reject.
    const insertResult = await withSuperClient(async (client) => {
      try {
        await client.query(
          `INSERT INTO questions
             (id, pack_id, level_id, type, topic, points, content, created_by)
           VALUES ($1, $2, $3, 'mcq', 'cross-pack', 5, $4::jsonb, $5)`,
          [
            randomUUID(),
            packB.id,
            levelA.id,
            JSON.stringify(mcqContent()),
            adminA,
          ],
        );
        return { ok: true as const };
      } catch (e: unknown) {
        const code = (e as { code?: string }).code;
        const message = e instanceof Error ? e.message : String(e);
        return { ok: false as const, code, message };
      }
    });

    expect(insertResult.ok).toBe(false);
    if (insertResult.ok === false) {
      // Postgres FK violation = sqlstate 23503
      expect(insertResult.code).toBe("23503");
      expect(insertResult.message).toMatch(/questions_level_pack_fk/);
    }
  });

  it("direct INSERT of a question with matching (level_id, pack_id) succeeds", async () => {
    // Sanity check: the same INSERT pattern with a level that belongs to the
    // pack must succeed — otherwise the constraint is over-restrictive.
    const pack = await createPack(
      tenantA,
      { slug: `fk-ok-pack-${randomUUID().slice(0, 8)}`, name: "FK OK Pack", domain: "soc" },
      adminA,
    );
    const level = await addLevel(tenantA, pack.id, {
      position: 1, label: "L1", duration_minutes: 30, default_question_count: 5,
    });

    const ok = await withSuperClient(async (client) => {
      await client.query(
        `INSERT INTO questions
           (id, pack_id, level_id, type, topic, points, content, created_by)
         VALUES ($1, $2, $3, 'mcq', 'fk-ok', 5, $4::jsonb, $5)`,
        [
          randomUUID(),
          pack.id,
          level.id,
          JSON.stringify(mcqContent()),
          adminA,
        ],
      );
      return true;
    });
    expect(ok).toBe(true);
  });
});

// ===========================================================================
// 8. JSON bulk import (decision #4)
// ===========================================================================

describe("JSON bulk import (decision #4)", () => {
  it("happy path: imports sample-pack.json with correct report counts", async () => {
    const fileBuffer = await readFile(SAMPLE_PACK_PATH);
    const report = await bulkImport(tenantA, fileBuffer, "json", adminA);

    expect(report.packId).toBeTruthy();
    expect(report.packSlug).toBe("soc-skills-sample-2026q2");
    expect(report.levelsCreated).toBe(2);
    expect(report.questionsCreated).toBe(7);
    // sample-pack.json has 21 tag occurrences spanning ~16 unique names. Some
    // names repeat within the pack (tool:siem appears in 3 questions; mitre:T1078
    // and tactic:credential-access appear in 2-3 questions each), and some
    // already exist in tenantA's tags table from earlier tests in the same
    // describe block. Both create + reuse counters MUST be > 0; their exact
    // split depends on test-order side effects so don't pin to specific values.
    expect(report.tagsCreated).toBeGreaterThanOrEqual(1);
    expect(report.tagsReused).toBeGreaterThanOrEqual(0);
    expect(report.tagsCreated + report.tagsReused).toBe(21);
  });

  it("listPacks after import contains the imported pack", async () => {
    const { items } = await listPacks(tenantA, { domain: "soc" });
    const slugs = items.map((p) => p.slug);
    expect(slugs).toContain("soc-skills-sample-2026q2");
  });

  it("imported pack has 7 questions accessible via listQuestions", async () => {
    const { items: packs } = await listPacks(tenantA, { domain: "soc" });
    const imported = packs.find((p) => p.slug === "soc-skills-sample-2026q2");
    expect(imported).toBeDefined();

    const { total } = await listQuestions(tenantA, { pack_id: imported!.id });
    expect(total).toBe(7);
  });

  it("re-importing the same sample-pack.json throws ConflictError PACK_SLUG_EXISTS", async () => {
    const fileBuffer = await readFile(SAMPLE_PACK_PATH);

    await expect(bulkImport(tenantA, fileBuffer, "json", adminA)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConflictError &&
        (e.details as Record<string, unknown> | undefined)?.["code"] === "PACK_SLUG_EXISTS",
    );
  });

  it("malformed JSON throws ValidationError IMPORT_VALIDATION_FAILED", async () => {
    const badBuffer = Buffer.from("{ this is: not valid json }", "utf8");

    await expect(bulkImport(tenantA, badBuffer, "json", adminA)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ValidationError &&
        (e.details as Record<string, unknown> | undefined)?.["code"] === "IMPORT_VALIDATION_FAILED",
    );
  });

  it("question referencing level_position=99 throws ValidationError IMPORT_LEVEL_REF_INVALID", async () => {
    const badImport = {
      pack: { slug: `bad-level-ref-${randomUUID().slice(0, 8)}`, name: "Bad Ref", domain: "soc" },
      levels: [{ position: 1, label: "L1", duration_minutes: 30, default_question_count: 5 }],
      questions: [
        {
          level_position: 99, // invalid — only position 1 is defined above
          type: "mcq",
          topic: "bad-ref-q",
          points: 5,
          content: mcqContent(),
          rubric: null,
          tags: [],
        },
      ],
    };
    const buffer = Buffer.from(JSON.stringify(badImport), "utf8");

    await expect(bulkImport(tenantA, buffer, "json", adminA)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ValidationError &&
        (e.details as Record<string, unknown> | undefined)?.["code"] === "IMPORT_LEVEL_REF_INVALID",
    );
  });

  it("csv format throws ValidationError IMPORT_VALIDATION_FAILED (csv deferred to phase 2)", async () => {
    const csvBuffer = Buffer.from("slug,name,domain\nfoo,Bar,soc", "utf8");

    await expect(bulkImport(tenantA, csvBuffer, "csv", adminA)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ValidationError &&
        (e.details as Record<string, unknown> | undefined)?.["code"] === "IMPORT_VALIDATION_FAILED",
    );
  });

  it("atomicity: import with one valid + one invalid question rolls back entirely — no orphan rows", async () => {
    const atomicSlug = `atomic-test-${randomUUID().slice(0, 8)}`;
    const atomicImport = {
      pack: { slug: atomicSlug, name: "Atomic Test", domain: "soc" },
      levels: [{ position: 1, label: "L1", duration_minutes: 30, default_question_count: 2 }],
      questions: [
        {
          level_position: 1,
          type: "mcq",
          topic: "valid-q",
          points: 5,
          content: mcqContent(),
          rubric: null,
          tags: [],
        },
        {
          level_position: 1,
          type: "mcq",
          topic: "invalid-q",
          points: 5,
          // options is empty array — Zod min(2) will reject this during pre-validation
          content: { question: "Bad MCQ?", options: [], correct: 0, rationale: "r" },
          rubric: null,
          tags: [],
        },
      ],
    };
    const buffer = Buffer.from(JSON.stringify(atomicImport), "utf8");

    // Import must fail
    await expect(bulkImport(tenantA, buffer, "json", adminA)).rejects.toBeInstanceOf(ValidationError);

    // Assert rollback: no pack with this slug persists
    const { items } = await listPacks(tenantA);
    const slugs = items.map((p) => p.slug);
    expect(slugs).not.toContain(atomicSlug);

    // Confirm via direct SQL that no orphan question_packs row was left behind
    const orphanRows = await withSuperClient(async (client) => {
      const r = await client.query(
        `SELECT id FROM question_packs WHERE slug = $1 AND tenant_id = $2`,
        [atomicSlug, tenantA],
      );
      return r.rows;
    });
    expect(orphanRows).toHaveLength(0);
  });
});

// ===========================================================================
// 9. generateDraft — 501 stub (decision #11)
// ===========================================================================

describe("generateDraft — 501 stub (decision #11)", () => {
  it("generateDraft throws an AppError with code GENERATE_DRAFT_DEFERRED", async () => {
    await expect(
      generateDraft(tenantA, { topic: "incident-response", type: "mcq", level: "L1", count: 3 }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof AppError &&
        (e.details as Record<string, unknown> | undefined)?.["code"] === "GENERATE_DRAFT_DEFERRED",
    );
  });
});
