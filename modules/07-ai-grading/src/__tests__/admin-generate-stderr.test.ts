/**
 * Per-chunk stderr_tail aggregation tests for handleAdminGenerate.
 *
 * Verifies that when sharded chunks fail with a non-zero exit code, the
 * generation_attempts.stderr_tail column is populated with a header-marked
 * concatenation of each failed chunk's stderr (last 1024 bytes of the join).
 *
 * Three scenarios:
 *   1. Partial failure (1 fulfilled, 1 rejected with stderrTail set):
 *      Row should have status='partial' and stderr_tail containing the
 *      chunk header + fake stderr.
 *   2. All-failed (0 fulfilled):
 *      Row should have status='failed', stderr_tail populated, and
 *      error_code matching the first chunk's AppError code.
 *   3. Empty-stderr path (rejected AppError without .details.stderrTail):
 *      Buffer entry writes "(none)" instead of crashing.
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

import { AppError } from "@assessiq/core";
import { AI_GRADING_ERROR_CODES } from "../types.js";
import type { GenerateQuestionsOutput } from "../types.js";

// ---------------------------------------------------------------------------
// Mock runtime-selector — no real claude subprocess is spawned.
// vi.mock() is hoisted by Vitest before imports.
// ---------------------------------------------------------------------------

vi.mock("../runtime-selector.js", () => ({
  generateQuestions: vi.fn(),
  generateQuestionsByType: vi.fn(),
}));

import { generateQuestionsByType } from "../runtime-selector.js";
const mockGenerateQuestionsByType = vi.mocked(generateQuestionsByType);

// ---------------------------------------------------------------------------
// Path helpers
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

/**
 * AppError with stderrTail in details — simulates a generation chunk that
 * exited non-zero and whose stderr was captured.
 */
function makeChunkError(stderrTail: string): AppError {
  return new AppError(
    "claude subprocess exited with code 1 (skill=generate-log-analysis)",
    AI_GRADING_ERROR_CODES.RUNTIME_FAILURE,
    503,
    { details: { skill: "generate-log-analysis", exitCode: 1, stderrTail } },
  );
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
  const slug = `pack-stderr-${randomUUID().slice(0, 8)}`;

  await client.query(
    `INSERT INTO question_packs
       (id, tenant_id, slug, name, domain, status, version, created_by)
     VALUES ($1, $2, $3, $4, 'soc', 'published', 2, $5)`,
    [packId, tenantId, slug, "Stderr Test Pack", adminId],
  );
  await client.query(
    `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count)
     VALUES ($1, $2, 1, 'L2', 30, 5)`,
    [levelId, packId],
  );
  return { packId, levelId };
}

interface AttemptRow {
  status: string;
  stderr_tail: string | null;
  error_code: string | null;
  chunks_failed: number | null;
}

async function readLastAttempt(packId: string, levelId: string): Promise<AttemptRow> {
  return withTenant(TENANT_ID, async (client) => {
    const r = await client.query(
      `SELECT status, stderr_tail, error_code, chunks_failed
       FROM generation_attempts
       WHERE pack_id = $1 AND level_id = $2
       ORDER BY started_at DESC LIMIT 1`,
      [packId, levelId],
    );
    return r.rows[0] as AttemptRow;
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
        [TENANT_ID, "stderr-tenant", "Stderr Test Tenant"],
      );
      await client.query(
        `INSERT INTO tenant_settings (tenant_id) VALUES ($1)`,
        [TENANT_ID],
      );
      await client.query(
        `INSERT INTO users (id, tenant_id, email, name, role, status)
         VALUES ($1, $2, $3, 'Admin', 'admin', 'active')`,
        [ADMIN_ID, TENANT_ID, "admin@stderr.test"],
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
 * Build a HandleAdminGenerateInput for count=2 at L2.
 * allocateByWeight(L2, 2) = { mcq:1, log_analysis:1, scenario:0, kql:0, subjective:0 }
 * so typeEntries = ["mcq", "log_analysis"] — two deterministic chunks.
 */
function makeInput(packId: string, levelId: string): HandleAdminGenerateInput {
  return {
    tenantId: TENANT_ID,
    userId: ADMIN_ID,
    packId,
    levelId,
    count: 2,
    socLevel: "L2",
    sources: TEST_SOURCES,
    existingTopics: [],
  };
}

/** Run the handler in sharded mode, restoring AI_GENERATE_MODE after. */
async function runSharded(
  packId: string,
  levelId: string,
): Promise<Awaited<ReturnType<typeof handleAdminGenerate>>> {
  const origMode = process.env["AI_GENERATE_MODE"];
  process.env["AI_GENERATE_MODE"] = "sharded";
  try {
    return await handleAdminGenerate(makeInput(packId, levelId));
  } finally {
    if (origMode === undefined) {
      delete process.env["AI_GENERATE_MODE"];
    } else {
      process.env["AI_GENERATE_MODE"] = origMode;
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleAdminGenerate — sharded per-chunk stderr_tail aggregation", () => {
  // ── Scenario 1: Partial failure ─────────────────────────────────────────
  it.skipIf(!dockerAvailable)(
    "partial failure: stderr_tail contains header-marked chunk stderr for the failing chunk",
    async () => {
      const { packId, levelId } = await withSuperClient((c) =>
        seedPack(c, TENANT_ID, ADMIN_ID),
      );

      // mcq (index 0) succeeds; log_analysis (index 1) fails with stderrTail
      mockGenerateQuestionsByType.mockResolvedValueOnce(makeSuccessOutput("mcq"));
      mockGenerateQuestionsByType.mockRejectedValueOnce(
        makeChunkError("fake stderr from claude\nexit 1"),
      );

      const result = await runSharded(packId, levelId);

      // At least one question inserted from the fulfilled mcq chunk
      expect(result.generated).toBeGreaterThanOrEqual(1);

      const row = await readLastAttempt(packId, levelId);

      expect(row.status).toBe("partial");
      expect(row.chunks_failed).toBe(1);
      // stderr_tail must contain the per-chunk header and the fake stderr
      expect(row.stderr_tail).not.toBeNull();
      expect(row.stderr_tail).toContain("--- chunk: log_analysis ---");
      expect(row.stderr_tail).toContain("fake stderr from claude");
    },
  );

  // ── Scenario 2: All-failed path ─────────────────────────────────────────
  it.skipIf(!dockerAvailable)(
    "all-failed: row status=failed, stderr_tail populated, error_code from first error",
    async () => {
      const { packId, levelId } = await withSuperClient((c) =>
        seedPack(c, TENANT_ID, ADMIN_ID),
      );

      // Both chunks fail with stderrTail
      mockGenerateQuestionsByType.mockRejectedValueOnce(
        makeChunkError("mcq stderr line 1\nfatal error"),
      );
      mockGenerateQuestionsByType.mockRejectedValueOnce(
        makeChunkError("log_analysis stderr line 1\nfatal error"),
      );

      // Handler throws when all chunks fail
      const origMode = process.env["AI_GENERATE_MODE"];
      process.env["AI_GENERATE_MODE"] = "sharded";
      let thrown: unknown;
      try {
        await handleAdminGenerate(makeInput(packId, levelId));
      } catch (err) {
        thrown = err;
      } finally {
        if (origMode === undefined) {
          delete process.env["AI_GENERATE_MODE"];
        } else {
          process.env["AI_GENERATE_MODE"] = origMode;
        }
      }

      expect(thrown).toBeDefined();

      const row = await readLastAttempt(packId, levelId);

      expect(row.status).toBe("failed");
      expect(row.error_code).toBe(AI_GRADING_ERROR_CODES.RUNTIME_FAILURE);
      expect(row.stderr_tail).not.toBeNull();
      // Both chunk headers present in the aggregated buffer
      expect(row.stderr_tail).toContain("--- chunk: mcq ---");
      expect(row.stderr_tail).toContain("--- chunk: log_analysis ---");
    },
  );

  // ── Scenario 3: Empty-stderr path ───────────────────────────────────────
  it.skipIf(!dockerAvailable)(
    "chunk error without stderrTail: buffer entry says (none) without crashing",
    async () => {
      const { packId, levelId } = await withSuperClient((c) =>
        seedPack(c, TENANT_ID, ADMIN_ID),
      );

      // mcq succeeds; log_analysis fails WITHOUT stderrTail in details
      mockGenerateQuestionsByType.mockResolvedValueOnce(makeSuccessOutput("mcq"));
      mockGenerateQuestionsByType.mockRejectedValueOnce(
        new AppError(
          "MCP rejection — no stderr captured",
          AI_GRADING_ERROR_CODES.SCHEMA_VIOLATION,
          503,
          // No stderrTail in details
          { details: { skill: "generate-log-analysis" } },
        ),
      );

      const result = await runSharded(packId, levelId);

      expect(result.generated).toBeGreaterThanOrEqual(1);

      const row = await readLastAttempt(packId, levelId);

      expect(row.status).toBe("partial");
      // Buffer entry should contain "(none)" rather than crashing or being null
      expect(row.stderr_tail).not.toBeNull();
      expect(row.stderr_tail).toContain("--- chunk: log_analysis ---");
      expect(row.stderr_tail).toContain("(none)");
    },
  );
});
