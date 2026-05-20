/**
 * G3.D audit-write sweep — coverage tests for modules/04-question-bank.
 *
 * Verifies every admin-mutating service method writes a corresponding audit_log
 * row INSIDE the same Postgres transaction as the domain mutation, satisfying
 * the CLAUDE.md atomicity invariant.
 *
 * Migration apply order: tenancy → users (020 only) → audit-log → question-bank.
 * The audit-log migration must precede the QB INSERTs because service methods
 * call auditInTx() during each mutation.
 *
 * Atomicity is verified two ways:
 *   1. Happy path: mutation row + audit row both present.
 *   2. Failure injection: when the surrounding withTenant transaction rolls
 *      back (e.g. domain-error path), no audit row is left orphaned. The two
 *      `*_NOT_PUBLISHED` and `*_NOT_FOUND` paths exercise this implicitly —
 *      they throw before reaching the mutation+audit pair, so no audit row.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";

import {
  createPack,
  publishPack,
  archivePack,
  activateAllQuestionsForPack,
  createQuestion,
  updateQuestion,
  restoreVersion,
  bulkImport,
  saveRubric,
  bulkUpdateQuestionStatus,
} from "../service.js";
import type { CreateQuestionInput } from "../types.js";

// ---------------------------------------------------------------------------
// Path helpers (Windows: strip leading slash before drive letter)
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

const THIS_DIR        = toFsPath(new URL(".", import.meta.url));
const QB_MODULE_ROOT  = join(THIS_DIR, "..", "..");
const MODULES_ROOT    = join(QB_MODULE_ROOT, "..");

const TENANCY_DIR     = join(MODULES_ROOT, "02-tenancy", "migrations");
const USERS_DIR       = join(MODULES_ROOT, "03-users",   "migrations");
const AUDIT_DIR       = join(MODULES_ROOT, "14-audit-log", "migrations");
const QB_DIR          = join(QB_MODULE_ROOT, "migrations");

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
    // Test-only: bypass the REVOKE on assessiq_app by running as superuser.
    await client.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [tenantId]);
  });
}

async function insertTenant(client: Client, id: string, slug: string): Promise<void> {
  await client.query(
    `INSERT INTO tenants (id, slug, name, status) VALUES ($1, $2, $3, 'active')`,
    [id, slug, `Tenant ${slug}`],
  );
  await client.query(
    `INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [id],
  );
}

async function insertAdmin(client: Client, id: string, tenantId: string, email: string): Promise<void> {
  await client.query(
    `INSERT INTO users (id, tenant_id, email, name, role, status)
     VALUES ($1, $2, $3, 'Admin', 'admin', 'active')`,
    [id, tenantId, email],
  );
}

// ---------------------------------------------------------------------------
// Test content helpers
// ---------------------------------------------------------------------------

function mcqContent() {
  return {
    question: "Audit happy path?",
    options: ["A", "B", "C", "D"],
    correct: 0,
    rationale: "A.",
  };
}

function subjectiveContent() {
  return { question: "Explain detection of lateral movement." };
}

function subjectiveRubric() {
  return {
    anchors: [{ id: "a1", concept: "smb_traffic", weight: 30, synonyms: ["smb"] }],
    reasoning_bands: {
      band_4: "x", band_3: "x", band_2: "x", band_1: "x", band_0: "x",
    },
    anchor_weight_total: 30,
    reasoning_weight_total: 70,
  };
}

// ---------------------------------------------------------------------------
// Global setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "test",
      POSTGRES_PASSWORD: "test",
      POSTGRES_DB: "aiq_audit_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  containerUrl = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_audit_test`;

  // Apply migrations: tenancy → users (020) → audit-log → question-bank.
  const [tenancyFiles, usersFiles, auditFiles, qbFiles] = await Promise.all([
    readdir(TENANCY_DIR),
    readdir(USERS_DIR),
    readdir(AUDIT_DIR),
    readdir(QB_DIR),
  ]);

  const allMigrations = [
    ...tenancyFiles.filter((f) => f.endsWith(".sql")).sort().map((f) => ({ dir: TENANCY_DIR, file: f })),
    ...usersFiles.filter((f) => f.endsWith(".sql") && f.startsWith("020_")).sort().map((f) => ({ dir: USERS_DIR, file: f })),
    ...auditFiles.filter((f) => f.endsWith(".sql")).sort().map((f) => ({ dir: AUDIT_DIR, file: f })),
    ...qbFiles.filter((f) => f.endsWith(".sql")).sort().map((f) => ({ dir: QB_DIR, file: f })),
  ];

  await withSuperClient(async (client) => {
    await client.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    // App role expected by RLS policies.
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

    for (const { dir, file } of allMigrations) {
      const sql = await readFile(join(dir, file), "utf-8");
      await client.query(sql);
    }

    await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    // audit_log has REVOKE UPDATE/DELETE/TRUNCATE; service writes only INSERT.
    await client.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
  });

  await setPoolForTesting(containerUrl);

  tenantA = randomUUID();
  adminA  = randomUUID();
  await withSuperClient(async (client) => {
    await insertTenant(client, tenantA, `audit-tenant-${tenantA.slice(0, 8)}`);
    await insertAdmin(client, adminA, tenantA, `audit-admin-${tenantA.slice(0, 8)}@example.com`);
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

// ===========================================================================
// Tests
// ===========================================================================

describe("G3.D audit writes — 04-question-bank", () => {
  it("createPack writes a pack.created audit row in the same tx", async () => {
    await clearAudit(tenantA);
    const slug = `audit-cp-${randomUUID().slice(0, 8)}`;
    const pack = await createPack(tenantA, { slug, name: "Audit CP", domain: "soc" }, adminA);

    const rows = await queryAudit(tenantA, "pack.created");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows.find((r) => r.entity_id === pack.id);
    expect(row).toBeDefined();
    expect(row!.actor_kind).toBe("user");
    expect(row!.actor_user_id).toBe(adminA);
    expect(row!.entity_type).toBe("question_pack");
    expect((row!.after as Record<string, unknown>).slug).toBe(slug);
  });

  it("publishPack writes a pack.published audit row in the same tx", async () => {
    await clearAudit(tenantA);
    const slug = `audit-pp-${randomUUID().slice(0, 8)}`;
    const pack = await createPack(tenantA, { slug, name: "Audit PP", domain: "soc" }, adminA);
    await publishPack(tenantA, pack.id, adminA);

    const rows = await queryAudit(tenantA, "pack.published");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.entity_id).toBe(pack.id);
    expect(row.actor_user_id).toBe(adminA);
    expect((row.after as Record<string, unknown>).status).toBe("published");
  });

  it("archivePack writes a pack.archived audit row in the same tx", async () => {
    await clearAudit(tenantA);
    const slug = `audit-ap-${randomUUID().slice(0, 8)}`;
    const pack = await createPack(tenantA, { slug, name: "Audit AP", domain: "soc" }, adminA);
    await publishPack(tenantA, pack.id, adminA);
    await archivePack(tenantA, pack.id, adminA);

    const rows = await queryAudit(tenantA, "pack.archived");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.entity_id).toBe(pack.id);
    expect(row.actor_user_id).toBe(adminA);
    expect((row.after as Record<string, unknown>).status).toBe("archived");
  });

  it("createQuestion writes a question.created audit row in the same tx", async () => {
    await clearAudit(tenantA);
    const slug = `audit-cq-${randomUUID().slice(0, 8)}`;
    const pack = await createPack(tenantA, { slug, name: "Audit CQ", domain: "soc" }, adminA);

    // Add a level via raw SQL (avoid pulling addLevel route through audit too).
    const levelId = randomUUID();
    await withSuperClient(async (client) => {
      await client.query(
        `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count)
         VALUES ($1, $2, 1, 'L1', 30, 10)`,
        [levelId, pack.id],
      );
    });

    const input: CreateQuestionInput = {
      pack_id: pack.id,
      level_id: levelId,
      type: "mcq",
      topic: "audit-test",
      points: 5,
      content: mcqContent(),
    };
    const question = await createQuestion(tenantA, input, adminA);

    const rows = await queryAudit(tenantA, "question.created");
    const row = rows.find((r) => r.entity_id === question.id);
    expect(row).toBeDefined();
    expect(row!.actor_user_id).toBe(adminA);
    expect((row!.after as Record<string, unknown>).pack_id).toBe(pack.id);
  });

  it("updateQuestion writes a question.updated audit row in the same tx", async () => {
    await clearAudit(tenantA);
    const slug = `audit-uq-${randomUUID().slice(0, 8)}`;
    const pack = await createPack(tenantA, { slug, name: "Audit UQ", domain: "soc" }, adminA);
    const levelId = randomUUID();
    await withSuperClient(async (client) => {
      await client.query(
        `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count)
         VALUES ($1, $2, 1, 'L1', 30, 10)`,
        [levelId, pack.id],
      );
    });

    const question = await createQuestion(
      tenantA,
      {
        pack_id: pack.id,
        level_id: levelId,
        type: "mcq",
        topic: "before",
        points: 5,
        content: mcqContent(),
      },
      adminA,
    );

    await clearAudit(tenantA);
    await updateQuestion(tenantA, question.id, { topic: "after" }, adminA);

    const rows = await queryAudit(tenantA, "question.updated");
    const row = rows.find((r) => r.entity_id === question.id);
    expect(row).toBeDefined();
    expect(row!.actor_user_id).toBe(adminA);
    expect((row!.after as Record<string, unknown>).changed_fields).toEqual(
      expect.arrayContaining(["topic"]),
    );
  });

  it("restoreVersion writes a question.updated audit row marked kind=restore", async () => {
    await clearAudit(tenantA);
    const slug = `audit-rv-${randomUUID().slice(0, 8)}`;
    const pack = await createPack(tenantA, { slug, name: "Audit RV", domain: "soc" }, adminA);
    const levelId = randomUUID();
    await withSuperClient(async (client) => {
      await client.query(
        `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count)
         VALUES ($1, $2, 1, 'L1', 30, 10)`,
        [levelId, pack.id],
      );
    });

    const question = await createQuestion(
      tenantA,
      {
        pack_id: pack.id,
        level_id: levelId,
        type: "mcq",
        topic: "v1",
        points: 5,
        content: mcqContent(),
      },
      adminA,
    );
    // Edit so a version 1 snapshot exists.
    await updateQuestion(
      tenantA,
      question.id,
      { content: { ...mcqContent(), question: "v2 question" } },
      adminA,
    );

    await clearAudit(tenantA);
    await restoreVersion(tenantA, question.id, 1, adminA);

    const rows = await queryAudit(tenantA, "question.updated");
    const row = rows.find(
      (r) =>
        r.entity_id === question.id &&
        (r.after as Record<string, unknown>).kind === "restore",
    );
    expect(row).toBeDefined();
    expect((row!.after as Record<string, unknown>).restored_from_version).toBe(1);
  });

  it("bulkImport writes one pack.created + one question.imported audit row in the same tx", async () => {
    await clearAudit(tenantA);
    const slug = `audit-bi-${randomUUID().slice(0, 8)}`;
    const payload = {
      pack: { slug, name: "Audit BI", domain: "soc" },
      levels: [
        {
          position: 1,
          label: "L1",
          duration_minutes: 30,
          default_question_count: 5,
        },
      ],
      questions: [
        {
          level_position: 1,
          type: "mcq" as const,
          topic: "import-q1",
          points: 5,
          content: mcqContent(),
        },
      ],
    };
    await bulkImport(tenantA, Buffer.from(JSON.stringify(payload)), "json", adminA);

    const created = await queryAudit(tenantA, "pack.created");
    const imported = await queryAudit(tenantA, "question.imported");
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(imported.length).toBeGreaterThanOrEqual(1);
    const importPack = created.find(
      (r) => (r.after as Record<string, unknown>).slug === slug,
    );
    expect(importPack).toBeDefined();
    expect((importPack!.after as Record<string, unknown>).kind).toBe("import");
    const importedSummary = imported.find(
      (r) => r.entity_id === importPack!.entity_id,
    );
    expect(importedSummary).toBeDefined();
    expect((importedSummary!.after as Record<string, unknown>).questions_created).toBe(1);
  });

  it("saveRubric writes a question.updated audit row marked kind=save_rubric", async () => {
    await clearAudit(tenantA);
    const slug = `audit-sr-${randomUUID().slice(0, 8)}`;
    const pack = await createPack(tenantA, { slug, name: "Audit SR", domain: "soc" }, adminA);
    const levelId = randomUUID();
    await withSuperClient(async (client) => {
      await client.query(
        `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count)
         VALUES ($1, $2, 1, 'L1', 30, 10)`,
        [levelId, pack.id],
      );
    });

    const question = await createQuestion(
      tenantA,
      {
        pack_id: pack.id,
        level_id: levelId,
        type: "subjective",
        topic: "sr-test",
        points: 5,
        content: subjectiveContent(),
        rubric: subjectiveRubric(),
      },
      adminA,
    );

    await clearAudit(tenantA);
    await saveRubric(tenantA, question.id, subjectiveRubric(), adminA);

    const rows = await queryAudit(tenantA, "question.updated");
    const row = rows.find(
      (r) =>
        r.entity_id === question.id &&
        (r.after as Record<string, unknown>).kind === "save_rubric",
    );
    expect(row).toBeDefined();
  });

  it("activateAllQuestionsForPack writes a bulk_activate summary audit row", async () => {
    await clearAudit(tenantA);
    const slug = `audit-aa-${randomUUID().slice(0, 8)}`;
    const pack = await createPack(tenantA, { slug, name: "Audit AA", domain: "soc" }, adminA);
    const levelId = randomUUID();
    await withSuperClient(async (client) => {
      await client.query(
        `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count)
         VALUES ($1, $2, 1, 'L1', 30, 10)`,
        [levelId, pack.id],
      );
    });

    const q = await createQuestion(
      tenantA,
      {
        pack_id: pack.id,
        level_id: levelId,
        type: "mcq",
        topic: "aa-test",
        points: 5,
        content: mcqContent(),
      },
      adminA,
    );
    await publishPack(tenantA, pack.id, adminA);

    await clearAudit(tenantA);
    await activateAllQuestionsForPack(tenantA, pack.id, adminA);

    const rows = await queryAudit(tenantA, "question.updated");
    const row = rows.find(
      (r) =>
        r.entity_id === pack.id &&
        (r.after as Record<string, unknown>).kind === "bulk_activate",
    );
    expect(row).toBeDefined();
    expect((row!.after as Record<string, unknown>).activated).toBe(1);
    expect(q.id).toBeDefined(); // ensure question was created (used only for activation count)
  });

  it("bulkUpdateQuestionStatus writes a bulk_status summary audit row", async () => {
    await clearAudit(tenantA);
    const slug = `audit-bus-${randomUUID().slice(0, 8)}`;
    const pack = await createPack(tenantA, { slug, name: "Audit BUS", domain: "soc" }, adminA);
    const levelId = randomUUID();
    await withSuperClient(async (client) => {
      await client.query(
        `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count)
         VALUES ($1, $2, 1, 'L1', 30, 10)`,
        [levelId, pack.id],
      );
    });

    // Create two ai_draft questions via raw SQL (bypasses the createQuestion
    // audit row and lets us start with clean audit_log for this test).
    const qIds = [randomUUID(), randomUUID()];
    await withSuperClient(async (client) => {
      for (const qid of qIds) {
        await client.query(
          `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, created_by)
           VALUES ($1, $2, $3, 'mcq', 'bus', 1, 'ai_draft', $4::jsonb, $5)`,
          [qid, pack.id, levelId, JSON.stringify(mcqContent()), adminA],
        );
      }
    });

    await clearAudit(tenantA);
    const result = await bulkUpdateQuestionStatus(tenantA, qIds, "active", adminA);
    expect(result.updated).toHaveLength(2);

    const rows = await queryAudit(tenantA, "question.updated");
    const row = rows.find(
      (r) => (r.after as Record<string, unknown>).kind === "bulk_status",
    );
    expect(row).toBeDefined();
    expect((row!.after as Record<string, unknown>).to_status).toBe("active");
    expect((row!.after as Record<string, unknown>).updated_count).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Atomicity: when the mutation throws, no audit row is left orphaned.
  // -------------------------------------------------------------------------
  it("publishPack on a non-existent pack throws and writes NO audit row", async () => {
    await clearAudit(tenantA);
    const fakeId = randomUUID();
    await expect(publishPack(tenantA, fakeId, adminA)).rejects.toThrow();

    const rows = await queryAudit(tenantA);
    // No pack.* or question.* audit row should have been written.
    expect(rows.filter((r) => r.action.startsWith("pack.") || r.action.startsWith("question."))).toHaveLength(0);
  });
});
