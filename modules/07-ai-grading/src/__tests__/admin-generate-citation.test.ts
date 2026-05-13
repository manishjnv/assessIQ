/**
 * Citation enforcement tests for handleAdminGenerate.
 *
 * Stage 1.5f — mechanical citation enforcement moves from prompt-level
 * (advisory, repeatedly ignored) to handler-level (authoritative).
 *
 * After generateQuestionsByType returns fulfilled outputs, filterByCitation()
 * drops any question whose knowledge_base_source_ids:
 *   - is empty ([]), OR
 *   - contains any value not present verbatim in input.sources[].id
 *
 * These tests exercise both the sharded path (AI_GENERATE_MODE=sharded) and
 * the omnibus paths via a fully-mocked runtime so no claude subprocess is
 * spawned.
 *
 * DB container: uses testcontainers (postgres:16-alpine).  If Docker is not
 * available in the current environment, the suite is skipped.
 *
 * Lint-sentinel note: lint-no-ambient-claude.ts skips __tests__/ directories.
 * The vi.mock() call here is safe from that gate.
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

// Handler under test
import { handleAdminGenerate } from "../handlers/admin-generate.js";
import type { HandleAdminGenerateInput, KbSourceRef } from "../handlers/admin-generate.js";

// Types
import type { GenerateQuestionsOutput, GeneratedQuestionDraft } from "../types.js";

// ---------------------------------------------------------------------------
// Mock runtime-selector — no real claude subprocess is spawned.
// vi.mock() is hoisted by Vitest before imports, so the mock is in place when
// admin-generate.ts first imports generateQuestionsByType / generateQuestions.
// ---------------------------------------------------------------------------

vi.mock("../runtime-selector.js", () => ({
  generateQuestions: vi.fn(),
  generateQuestionsByType: vi.fn(),
}));

import { generateQuestions, generateQuestionsByType } from "../runtime-selector.js";
const mockGenerateQuestionsByType = vi.mocked(generateQuestionsByType);
const mockGenerateQuestions = vi.mocked(generateQuestions);

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
const AI_MIGRATIONS_DIR = join(AI_MODULE_ROOT, "migrations");

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Valid source present in input.sources — ids the model SHOULD cite. */
const SRC_VALID_1 = "src_l2_001";
const SRC_VALID_2 = "src_l2_007";

/** Sources passed to the handler — the canonical allow-list for this run. */
const TEST_SOURCES: KbSourceRef[] = [
  {
    id: SRC_VALID_1,
    name: "Linux /etc/shadow Credential Access",
    citation: "NIST SP 800-123",
    url: "https://example.com/src_l2_001",
    level_fit: "L2",
    function: "Detect",
    description: "Detecting /etc/shadow reads",
    tags: ["linux", "credentials"],
    kb_version: "v1",
  },
  {
    id: SRC_VALID_2,
    name: "Kerberos TGS Ticket Request Analysis",
    citation: "NIST SP 800-123",
    url: "https://example.com/src_l2_007",
    level_fit: "L2",
    function: "Detect",
    description: "Kerberoasting detection patterns",
    tags: ["kerberos", "ad"],
    kb_version: "v1",
  },
];

/**
 * Build a GeneratedQuestionDraft with the given knowledge_base_source_ids.
 * knowledgeBaseSources is pre-resolved to whatever sources are valid in the
 * set — the citation filter tests only need knowledge_base_source_ids.
 */
function makeDraft(
  knowledge_base_source_ids: string[],
  type: GeneratedQuestionDraft["type"] = "mcq",
  topic = `Topic-${randomUUID().slice(0, 6)}`,
): GeneratedQuestionDraft {
  const sourceById = new Map(TEST_SOURCES.map((s) => [s.id, s]));
  return {
    type,
    topic,
    points: 3,
    content: { question: "Q?", options: ["A", "B", "C", "D"], correct_index: 0 },
    rubric: null,
    knowledge_base_source_ids,
    knowledgeBaseSources: knowledge_base_source_ids
      .map((id) => sourceById.get(id))
      .filter((s): s is KbSourceRef => s !== undefined)
      .map((s) => ({
        id: s.id,
        name: s.name,
        citation: s.citation,
        url: s.url,
        level_fit: s.level_fit,
        function: s.function,
        kb_version: s.kb_version,
      })),
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
  const slug = `pack-cite-${randomUUID().slice(0, 8)}`;

  await client.query(
    `INSERT INTO question_packs
       (id, tenant_id, slug, name, domain, status, version, created_by)
     VALUES ($1, $2, $3, $4, 'soc', 'published', 2, $5)`,
    [packId, tenantId, slug, "Citation Test Pack", adminId],
  );
  await client.query(
    `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count)
     VALUES ($1, $2, 1, 'L2', 30, 5)`,
    [levelId, packId],
  );
  return { packId, levelId };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(
  async () => {
    // Detect Docker availability before launching the container.
    // If Docker is absent, mark the flag and return — tests will be skipped.
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
      // Apply migrations in FK-safe order
      await applyMigrationsFromDir(client, TENANCY_MIGRATIONS_DIR);
      await applyMigrationsFromDir(client, USERS_MIGRATIONS_DIR, ["020_users.sql"]);
      await applyMigrationsFromDir(client, QB_MIGRATIONS_DIR);
      await applyMigrationsFromDir(client, AI_MIGRATIONS_DIR);

      // Seed tenant + admin
      await client.query(
        `INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`,
        [TENANT_ID, "cite-tenant", "Citation Test Tenant"],
      );
      await client.query(
        `INSERT INTO tenant_settings (tenant_id) VALUES ($1)`,
        [TENANT_ID],
      );
      await client.query(
        `INSERT INTO users (id, tenant_id, email, name, role, status)
         VALUES ($1, $2, $3, 'Admin', 'admin', 'active')`,
        [ADMIN_ID, TENANT_ID, "admin@cite.test"],
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
// Helper: build a minimal HandleAdminGenerateInput for the sharded path
// ---------------------------------------------------------------------------

function makeInput(
  packId: string,
  levelId: string,
  count = 4,
): HandleAdminGenerateInput {
  return {
    tenantId: TENANT_ID,
    userId: ADMIN_ID,
    packId,
    levelId,
    count,
    socLevel: "L2",
    sources: TEST_SOURCES,
    existingTopics: [],
  };
}

// ---------------------------------------------------------------------------
// Sharded path — citation filter tests
// ---------------------------------------------------------------------------

describe("handleAdminGenerate — sharded path citation enforcement", () => {
  it.skipIf(!dockerAvailable)(
    "drops invalid, empty, and mixed-citation questions; inserts only the valid one",
    async () => {
      const { packId, levelId } = await withSuperClient((client) =>
        seedPack(client, TENANT_ID, ADMIN_ID),
      );

      // The 4 test cases the task specifies:
      //   1. valid   — knowledge_base_source_ids=["src_l2_001"] → KEPT
      //   2. invalid — knowledge_base_source_ids=["mitre.t1558.003"] → DROP
      //   3. empty   — knowledge_base_source_ids=[] → DROP
      //   4. mixed   — knowledge_base_source_ids=["src_l2_007","T1003.001"] → DROP
      const validQ   = makeDraft([SRC_VALID_1], "mcq", "Valid-topic-cert");
      const invalidQ = makeDraft(["mitre.t1558.003"], "mcq", "Kerberos-Kerberoasting");
      const emptyQ   = makeDraft([], "mcq", "Empty-source-topic");
      const mixedQ   = makeDraft([SRC_VALID_2, "T1003.001"], "mcq", "Mixed-topic-os-cred");

      // Mock generateQuestionsByType — sharded path calls it once per type.
      // Return all 4 questions under a single type call for simplicity.
      // The allocation gives mcq=4 for count=4 at L2 … let the handler decide;
      // we only need it to see these 4 questions from fulfilled outputs.
      const mockOutput: GenerateQuestionsOutput = {
        questions: [validQ, invalidQ, emptyQ, mixedQ],
        skillSha: "aabbccdd",
        model: "claude-sonnet-4-6",
        wrongTypeDropped: 0,
      };
      mockGenerateQuestionsByType.mockResolvedValue(mockOutput);

      // Set environment for sharded path
      const origMode = process.env["AI_GENERATE_MODE"];
      process.env["AI_GENERATE_MODE"] = "sharded";

      try {
        const result = await handleAdminGenerate(makeInput(packId, levelId, 4));

        // Only the valid question should have been inserted
        expect(result.generated).toBe(1);
        expect(result.questionIds).toHaveLength(1);
      } finally {
        if (origMode === undefined) {
          delete process.env["AI_GENERATE_MODE"];
        } else {
          process.env["AI_GENERATE_MODE"] = origMode;
        }
      }

      // Verify the attempt row recorded citationDropped=3
      const attemptRow = await withTenant(TENANT_ID, async (client) => {
        const r = await client.query(
          `SELECT citation_dropped, count_inserted FROM generation_attempts
           WHERE pack_id = $1 AND level_id = $2
           ORDER BY started_at DESC LIMIT 1`,
          [packId, levelId],
        );
        return r.rows[0] as { citation_dropped: number; count_inserted: number };
      });

      expect(attemptRow.citation_dropped).toBe(3);
      expect(attemptRow.count_inserted).toBe(1);
    },
  );
});

// ---------------------------------------------------------------------------
// Omnibus single-call path — citation filter applied uniformly
// ---------------------------------------------------------------------------

describe("handleAdminGenerate — omnibus single-call path citation enforcement", () => {
  it.skipIf(!dockerAvailable)(
    "applies the same citation filter when count <= CHUNK_SIZE",
    async () => {
      const { packId, levelId } = await withSuperClient((client) =>
        seedPack(client, TENANT_ID, ADMIN_ID),
      );

      const validQ   = makeDraft([SRC_VALID_1], "mcq", "Omnibus-valid-topic");
      const invalidQ = makeDraft(["mitre.t1003"], "mcq", "Omnibus-invalid-topic");
      const emptyQ   = makeDraft([], "subjective", "Omnibus-empty-topic");

      const mockOutput: GenerateQuestionsOutput = {
        questions: [validQ, invalidQ, emptyQ],
        skillSha: "deadbeef",
        model: "claude-sonnet-4-6",
      };
      mockGenerateQuestions.mockResolvedValue(mockOutput);

      // Omnibus path: AI_GENERATE_MODE != 'sharded'
      const origMode = process.env["AI_GENERATE_MODE"];
      delete process.env["AI_GENERATE_MODE"];

      try {
        // count=3 <= CHUNK_SIZE=10 → single-call omnibus path
        const result = await handleAdminGenerate(makeInput(packId, levelId, 3));

        expect(result.generated).toBe(1);
        expect(result.questionIds).toHaveLength(1);
      } finally {
        if (origMode !== undefined) {
          process.env["AI_GENERATE_MODE"] = origMode;
        }
      }

      const attemptRow = await withTenant(TENANT_ID, async (client) => {
        const r = await client.query(
          `SELECT citation_dropped, count_inserted FROM generation_attempts
           WHERE pack_id = $1 AND level_id = $2
           ORDER BY started_at DESC LIMIT 1`,
          [packId, levelId],
        );
        return r.rows[0] as { citation_dropped: number; count_inserted: number };
      });

      expect(attemptRow.citation_dropped).toBe(2);
      expect(attemptRow.count_inserted).toBe(1);
    },
  );
});
