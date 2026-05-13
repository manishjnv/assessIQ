/**
 * Per-tenant ai_generate_mode precedence tests for handleAdminGenerate.
 *
 * Verifies that tenantSettings.ai_generate_mode takes precedence over the
 * global AI_GENERATE_MODE env var (Stage 3.0 requirement):
 *
 *   1. Tenant column = 'sharded', global env = 'omnibus'
 *      → handler dispatches via generateQuestionsByType (sharded path).
 *
 *   2. Tenant column = NULL, global env = 'omnibus'
 *      → handler dispatches via generateQuestions (omnibus path).
 *
 * DB container: uses testcontainers (postgres:16-alpine). Skipped when Docker
 * is not available.
 *
 * Lint-sentinel note: lint-no-ambient-claude.ts skips __tests__/ directories.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// G3.D: mock @assessiq/audit-log (testcontainer omits audit-log migrations).
vi.mock("@assessiq/audit-log", async () => {
  const actual =
    await vi.importActual<typeof import("@assessiq/audit-log")>("@assessiq/audit-log");
  return {
    ...actual,
    auditInTx: vi.fn(async () => undefined),
  };
});

import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { withTenant } from "../../../02-tenancy/src/with-tenant.js";

import { handleAdminGenerate } from "../handlers/admin-generate.js";
import type { HandleAdminGenerateInput, KbSourceRef } from "../handlers/admin-generate.js";

import type { GenerateQuestionsOutput } from "../types.js";

// ---------------------------------------------------------------------------
// Mock runtime-selector — no real claude subprocess is spawned.
// vi.mock() is hoisted by Vitest before imports.
// ---------------------------------------------------------------------------

vi.mock("../runtime-selector.js", () => ({
  generateQuestions: vi.fn(),
  generateQuestionsByType: vi.fn(),
}));

import { generateQuestions, generateQuestionsByType } from "../runtime-selector.js";
const mockGenerateQuestions = vi.mocked(generateQuestions);
const mockGenerateQuestionsByType = vi.mocked(generateQuestionsByType);

// ---------------------------------------------------------------------------
// Path helpers — mirrors the pattern in admin-generate-stderr.test.ts
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
const AI_MIGRATIONS_DIR = join(AI_MODULE_ROOT, "migrations");

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SRC_VALID = "src_l2_001";

const TEST_SOURCES: KbSourceRef[] = [
  {
    id: SRC_VALID,
    name: "Linux /etc/shadow Credential Access",
    citation: "NIST SP 800-123",
    url: "https://example.com/src_l2_001",
    level_fit: "L2",
    function: "Detect",
    description: "Detecting /etc/shadow reads",
    tags: ["linux", "credentials"],
    kb_version: "v1",
  },
];

/** Minimal fulfilled output — 1 valid question. */
function makeSuccessOutput(type: "mcq" | "log_analysis" = "mcq"): GenerateQuestionsOutput {
  return {
    questions: [
      {
        type,
        topic: `Valid-topic-${randomUUID().slice(0, 6)}`,
        points: 3,
        content: { question: "Q?", options: ["A", "B", "C", "D"], correct_index: 0 },
        rubric: null,
        knowledge_base_source_ids: [SRC_VALID],
        knowledgeBaseSources: [
          {
            id: SRC_VALID,
            name: "Linux /etc/shadow Credential Access",
            citation: "NIST SP 800-123",
            url: "https://example.com/src_l2_001",
            level_fit: "L2",
            function: "Detect",
            kb_version: "v1",
          },
        ],
      },
    ],
    skillSha: "aabbccdd",
    model: "claude-sonnet-4-6",
    wrongTypeDropped: 0,
  };
}

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let container: StartedTestContainer;
let containerUrl: string;
let TENANT_ID: string;
let ADMIN_ID: string;
let dockerAvailable = true;

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

async function seedPack(
  client: Client,
  tenantId: string,
  adminId: string,
): Promise<{ packId: string; levelId: string }> {
  const packId = randomUUID();
  const levelId = randomUUID();
  const slug = `pack-mode-${randomUUID().slice(0, 8)}`;

  await client.query(
    `INSERT INTO question_packs
       (id, tenant_id, slug, name, domain, status, version, created_by)
     VALUES ($1, $2, $3, $4, 'soc', 'published', 2, $5)`,
    [packId, tenantId, slug, "Mode Test Pack", adminId],
  );
  await client.query(
    `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count)
     VALUES ($1, $2, 1, 'L2', 30, 5)`,
    [levelId, packId],
  );
  return { packId, levelId };
}

/** Set ai_generate_mode on the tenant's settings row. */
async function setTenantGenerateMode(
  tenantId: string,
  mode: "omnibus" | "sharded" | null,
): Promise<void> {
  await withTenant(tenantId, async (client) => {
    await client.query(
      `UPDATE tenant_settings SET ai_generate_mode = $1 WHERE tenant_id = $2`,
      [mode, tenantId],
    );
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(
  async () => {
    try {
      container = await new GenericContainer("postgres:16-alpine")
        .withEnvironment({
          POSTGRES_USER: "test",
          POSTGRES_PASSWORD: "test",
          POSTGRES_DB: "testdb",
        })
        .withWaitStrategy(Wait.forListeningPorts())
        .withExposedPorts(5432)
        .start();
    } catch {
      dockerAvailable = false;
      return;
    }

    const host = container.getHost();
    const port = container.getMappedPort(5432);
    containerUrl = `postgresql://test:test@${host}:${port}/testdb`;

    await setPoolForTesting(containerUrl);

    TENANT_ID = randomUUID();
    ADMIN_ID = randomUUID();

    await withSuperClient(async (client) => {
      await applyMigrationsFromDir(client, TENANCY_MIGRATIONS_DIR);
      await applyMigrationsFromDir(client, USERS_MIGRATIONS_DIR, ["020_users.sql"]);
      await applyMigrationsFromDir(client, QB_MIGRATIONS_DIR);
      await applyMigrationsFromDir(client, AI_MIGRATIONS_DIR);

      await client.query(
        `INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`,
        [TENANT_ID, "mode-tenant", "Mode Test Tenant"],
      );
      await client.query(
        `INSERT INTO tenant_settings (tenant_id) VALUES ($1)`,
        [TENANT_ID],
      );
      await client.query(
        `INSERT INTO users (id, tenant_id, email, name, role, status)
         VALUES ($1, $2, $3, 'Admin', 'admin', 'active')`,
        [ADMIN_ID, TENANT_ID, "admin@mode.test"],
      );
    });
  },
  300_000,
);

afterAll(async () => {
  if (!dockerAvailable) return;
  await closePool();
  if (container) await container.stop();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a HandleAdminGenerateInput for count=1 at L2.
 * count=1 falls through to the single-call omnibus path OR the sharded path.
 * allocateByWeight(L2, 1) = { mcq:1, others:0 } — one deterministic shard chunk.
 */
function makeInput(packId: string, levelId: string): HandleAdminGenerateInput {
  return {
    tenantId: TENANT_ID,
    userId: ADMIN_ID,
    packId,
    levelId,
    count: 1,
    socLevel: "L2",
    sources: TEST_SOURCES,
    existingTopics: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleAdminGenerate — per-tenant ai_generate_mode precedence (Stage 3.0)", () => {
  // ── Scenario 1: tenant column='sharded', global env='omnibus' ────────────
  it.skipIf(!dockerAvailable)(
    "tenant ai_generate_mode='sharded' overrides global AI_GENERATE_MODE='omnibus' → dispatches sharded",
    async () => {
      const { packId, levelId } = await withSuperClient((c) =>
        seedPack(c, TENANT_ID, ADMIN_ID),
      );

      // Set tenant column to 'sharded' — global env remains 'omnibus' (default).
      await setTenantGenerateMode(TENANT_ID, "sharded");

      // Ensure global env is 'omnibus' for the duration of this test.
      const origMode = process.env["AI_GENERATE_MODE"];
      process.env["AI_GENERATE_MODE"] = "omnibus";

      mockGenerateQuestions.mockReset();
      mockGenerateQuestionsByType.mockReset();

      // count=1 at L2 allocates { mcq:1 } — one sharded chunk.
      mockGenerateQuestionsByType.mockResolvedValueOnce(makeSuccessOutput("mcq"));

      try {
        const result = await handleAdminGenerate(makeInput(packId, levelId));
        expect(result.generated).toBeGreaterThanOrEqual(1);
      } finally {
        if (origMode === undefined) {
          delete process.env["AI_GENERATE_MODE"];
        } else {
          process.env["AI_GENERATE_MODE"] = origMode;
        }
        // Restore to NULL so subsequent tests start clean.
        await setTenantGenerateMode(TENANT_ID, null);
      }

      // generateQuestionsByType must have been called (sharded path).
      expect(mockGenerateQuestionsByType).toHaveBeenCalled();
      // generateQuestions (omnibus path) must NOT have been called.
      expect(mockGenerateQuestions).not.toHaveBeenCalled();
    },
  );

  // ── Scenario 2: tenant column=NULL, global env='omnibus' ────────────────
  it.skipIf(!dockerAvailable)(
    "tenant ai_generate_mode=NULL falls back to global AI_GENERATE_MODE='omnibus' → dispatches omnibus",
    async () => {
      const { packId, levelId } = await withSuperClient((c) =>
        seedPack(c, TENANT_ID, ADMIN_ID),
      );

      // Ensure tenant column is NULL (default after INSERT or explicit reset).
      await setTenantGenerateMode(TENANT_ID, null);

      // Ensure global env is 'omnibus'.
      const origMode = process.env["AI_GENERATE_MODE"];
      process.env["AI_GENERATE_MODE"] = "omnibus";

      mockGenerateQuestions.mockReset();
      mockGenerateQuestionsByType.mockReset();

      // count=1 falls through to the single-call omnibus path.
      mockGenerateQuestions.mockResolvedValueOnce(makeSuccessOutput("mcq"));

      try {
        const result = await handleAdminGenerate(makeInput(packId, levelId));
        expect(result.generated).toBeGreaterThanOrEqual(1);
      } finally {
        if (origMode === undefined) {
          delete process.env["AI_GENERATE_MODE"];
        } else {
          process.env["AI_GENERATE_MODE"] = origMode;
        }
      }

      // generateQuestions (omnibus path) must have been called.
      expect(mockGenerateQuestions).toHaveBeenCalled();
      // generateQuestionsByType (sharded path) must NOT have been called.
      expect(mockGenerateQuestionsByType).not.toHaveBeenCalled();
    },
  );
});
