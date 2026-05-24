/**
 * Unit tests: clone-on-use engine (Step 2 — question-set sharing).
 *   - clonePackToTenant  (modules/04-question-bank/src/clone.ts)
 *   - materializeSetForTenant (transaction-owning wrapper)
 *
 * These guard the invariants behind the clone-on-grant design + the
 * 2026-05-23 RCA ("Duplicate question-set clones possible under concurrent
 * clone-on-use"):
 *
 *  (T1) IDEMPOTENCY — when a clone of the source already exists in the target
 *       tenant, return it and insert NOTHING. This is the application-layer half
 *       of "exactly one clone per (tenant, source)": after the advisory lock
 *       releases, the second caller's idempotency SELECT finds the first clone
 *       and returns early. (The 0085 partial UNIQUE index is the DB backstop —
 *       proven separately against a real Postgres; mocks can't enforce it.)
 *  (T2/T3/T5) GUARDS — source must be published, must live in the platform
 *       tenant, and a pack may never be cloned INTO the platform tenant.
 *  (T4) TAXONOMY REMAP (the decisive blocker, Agent-3 finding #1) — cloned
 *       questions are remapped to the TARGET tenant's domain/category by SLUG,
 *       never by the source UUID; a question whose taxonomy has no match in the
 *       target is SKIPPED + counted, never attached to a foreign-tenant UUID.
 *  (T6) materializeSetForTenant acquires the pg_advisory_xact_lock and writes
 *       NO audit row when an existing clone is reused.
 *
 * Does NOT require a database — the PoolClient + getPool + auditInTx are mocked,
 * query-call-by-call. Mirrors find-or-create-pack-for-domain.test.ts style.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ValidationError } from "@assessiq/core";

void ValidationError;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@assessiq/tenancy", () => ({
  getPool: vi.fn(),
}));

vi.mock("@assessiq/audit-log", () => ({
  auditInTx: vi.fn().mockResolvedValue({ id: "audit-row-1" }),
}));

vi.mock("@assessiq/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@assessiq/core")>();
  let n = 0;
  return {
    ...actual,
    // Deterministic, monotonically-increasing ids so assertions can pin them.
    uuidv7: vi.fn(() => `gen-${++n}`),
  };
});

import { clonePackToTenant, materializeSetForTenant } from "../clone.js";
import { getPool } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import { uuidv7 } from "@assessiq/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type QueryResponse = { rows: Record<string, unknown>[] };

/** A recording mock PoolClient that returns canned responses in call order. */
function makeClient(responses: QueryResponse[]): {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  let i = 0;
  return {
    query: vi.fn().mockImplementation(() => {
      const r = responses[i] ?? { rows: [] };
      i++;
      return Promise.resolve(r);
    }),
    release: vi.fn(),
  };
}

/** Find the first query call whose SQL contains `needle` and return its params. */
function paramsOf(
  client: { query: ReturnType<typeof vi.fn> },
  needle: string,
): unknown[] | undefined {
  const call = client.query.mock.calls.find(
    (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes(needle),
  );
  return call ? (call[1] as unknown[]) : undefined;
}

/** Count query calls whose SQL contains `needle`. */
function countCalls(client: { query: ReturnType<typeof vi.fn> }, needle: string): number {
  return client.query.mock.calls.filter(
    (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes(needle),
  ).length;
}

const PLATFORM = "platform-tenant-id";
const TARGET = "company-tenant-id";
const SOURCE = "source-pack-id";

function publishedPlatformPack(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: SOURCE,
    tenant_id: PLATFORM,
    slug: "soc-pack",
    name: "SOC Pack",
    domain: "soc",
    description: null,
    status: "published",
    version: 3,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  let n = 0;
  (uuidv7 as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => `gen-${++n}`);
});

// ---------------------------------------------------------------------------
// clonePackToTenant
// ---------------------------------------------------------------------------

describe("clonePackToTenant", () => {
  it("T1: reuses an existing clone idempotently and inserts NOTHING", async () => {
    const client = makeClient([
      { rows: [{ id: PLATFORM }] },                                  // platform tenant
      { rows: [publishedPlatformPack()] },                           // source pack
      { rows: [{ id: "existing-clone", slug: "clone-soc-pack" }] },  // idempotency hit
      { rows: [{ count: "7" }] },                                    // count questions in clone
    ]);

    const res = await clonePackToTenant(client as never, SOURCE, TARGET, "actor-1");

    expect(res.reusedExisting).toBe(true);
    expect(res.clonedPackId).toBe("existing-clone");
    expect(res.questionCount).toBe(7);
    // The concurrency invariant: a second materialise of an existing (tenant,
    // source) must NOT insert another pack.
    expect(countCalls(client, "INSERT INTO question_packs")).toBe(0);
  });

  it("T2: rejects a source pack that is not published", async () => {
    const client = makeClient([
      { rows: [{ id: PLATFORM }] },
      { rows: [publishedPlatformPack({ status: "draft" })] },
    ]);
    await expect(clonePackToTenant(client as never, SOURCE, TARGET, "actor-1")).rejects.toMatchObject({
      details: { code: "SOURCE_NOT_PUBLISHED" },
    });
    expect(countCalls(client, "INSERT INTO question_packs")).toBe(0);
  });

  it("T3: rejects a source pack that does not live in the platform tenant", async () => {
    const client = makeClient([
      { rows: [{ id: PLATFORM }] },
      { rows: [publishedPlatformPack({ tenant_id: "some-other-tenant" })] },
    ]);
    await expect(clonePackToTenant(client as never, SOURCE, TARGET, "actor-1")).rejects.toMatchObject({
      details: { code: "SOURCE_NOT_PLATFORM" },
    });
  });

  it("T5: refuses to clone a pack INTO the platform tenant", async () => {
    const client = makeClient([{ rows: [{ id: PLATFORM }] }]);
    await expect(clonePackToTenant(client as never, SOURCE, PLATFORM, "actor-1")).rejects.toMatchObject({
      details: { code: "CLONE_INTO_PLATFORM" },
    });
  });

  it("T4: remaps taxonomy by SLUG to the target tenant and skips unresolvable questions", async () => {
    // q1: domain 'soc' — resolvable in target. q2: domain 'mystery' — NOT in
    // target → must be skipped, never attached to the source/foreign UUID.
    // Both have null category_id (so the source-category lookup is skipped).
    const client = makeClient([
      { rows: [{ id: PLATFORM }] },                                  // platform tenant
      { rows: [publishedPlatformPack()] },                           // source pack
      { rows: [] },                                                  // idempotency: none
      { rows: [{ id: "L1src", position: 1, label: "L1", description: null, duration_minutes: 30, default_question_count: 5, passing_score_pct: 60, rubric_defaults: null }] }, // levels
      { rows: [                                                      // questions
        { id: "q1", level_id: "L1src", type: "mcq", topic: "t1", points: 1, status: "active", content: {}, rubric: null, knowledge_base_sources: [], domain_id: "d_soc", category_id: null },
        { id: "q2", level_id: "L1src", type: "mcq", topic: "t2", points: 1, status: "active", content: {}, rubric: null, knowledge_base_sources: [], domain_id: "d_mystery", category_id: null },
      ] },
      { rows: [{ id: "d_soc", slug: "soc" }, { id: "d_mystery", slug: "mystery" }] }, // source domain slugs
      // (no source-category query — both questions have null category_id)
      { rows: [{ id: "tgt_soc", slug: "soc" }] },                    // TARGET domains (no 'mystery')
      { rows: [] },                                                  // TARGET categories
      { rows: [] },                                                  // deriveCloneSlug: no collision
      { rows: [] },                                                  // INSERT question_packs
      { rows: [] },                                                  // INSERT level
      { rows: [] },                                                  // INSERT question (q1)
      { rows: [] },                                                  // SELECT tags for q1 (none)
    ]);

    const res = await clonePackToTenant(client as never, SOURCE, TARGET, "actor-1");

    expect(res.reusedExisting).toBe(false);
    expect(res.questionCount).toBe(1); // q1 cloned
    expect(res.skippedCount).toBe(1);  // q2 skipped (no 'mystery' domain in target)
    expect(res.sourceVersion).toBe(3);

    // The cloned pack carries provenance: source_pack_id = the platform pack id.
    const packParams = paramsOf(client, "INSERT INTO question_packs");
    expect(packParams?.[7]).toBe(SOURCE); // $8 source_pack_id
    expect(packParams?.[1]).toBe(TARGET); // $2 tenant_id

    // Exactly ONE question inserted, remapped to the TARGET domain id (not the
    // source 'd_soc'), carrying source_question_id for lineage.
    expect(countCalls(client, "INSERT INTO questions")).toBe(1);
    const qParams = paramsOf(client, "INSERT INTO questions");
    expect(qParams?.[11]).toBe("tgt_soc"); // $12 domain_id — remapped to target
    expect(qParams?.[13]).toBe("q1");      // $14 source_question_id
  });
});

// ---------------------------------------------------------------------------
// materializeSetForTenant
// ---------------------------------------------------------------------------

describe("materializeSetForTenant", () => {
  it("T6: acquires the advisory lock and writes NO audit row when reusing an existing clone", async () => {
    const client = makeClient([
      { rows: [] },                                                  // BEGIN
      { rows: [] },                                                  // SET LOCAL ROLE assessiq_system
      { rows: [] },                                                  // pg_advisory_xact_lock
      { rows: [{ id: PLATFORM }] },                                  // platform tenant
      { rows: [publishedPlatformPack()] },                           // source pack
      { rows: [{ id: "existing-clone", slug: "clone-soc-pack" }] },  // idempotency hit
      { rows: [{ count: "5" }] },                                    // count questions
      { rows: [{ id: "cl-L1", position: 1, label: "L1" }] },         // post-clone levels SELECT
      { rows: [] },                                                  // COMMIT
    ]);
    (getPool as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      connect: vi.fn().mockResolvedValue(client),
    });

    const res = await materializeSetForTenant(SOURCE, TARGET, "actor-1");

    expect(res.reusedExisting).toBe(true);
    expect(res.clonedPackId).toBe("existing-clone");
    expect(res.levels).toEqual([{ id: "cl-L1", position: 1, label: "L1" }]);
    // Concurrency serialization: the advisory lock MUST be taken.
    expect(countCalls(client, "pg_advisory_xact_lock")).toBe(1);
    // Reuse changes nothing → no audit row, no second clone.
    expect(auditInTx).not.toHaveBeenCalled();
    expect(countCalls(client, "INSERT INTO question_packs")).toBe(0);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
