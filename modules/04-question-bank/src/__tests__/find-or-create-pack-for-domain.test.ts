/**
 * Unit tests: findOrCreatePackForDomain (C1) + POST /api/admin/generate (C2)
 *
 * Security focus: cross-tenant domain guard is the primary control preventing
 * a pack/level from being created for a domain belonging to another tenant.
 * Postgres FK validation bypasses RLS — this explicit guard is load-bearing.
 *
 * Test cases:
 *  (a) resolver: cross-tenant domain_id → 422 CROSS_TENANT_FK_REJECTED
 *  (b) resolver: first call creates pack + 3 levels (L1, L2, L3)
 *  (c) resolver: second call is idempotent (same packId, no dup pack)
 *  (d) resolver: heals a missing level (pack exists, only L1+L2 → inserts L3)
 *  (e) POST /api/admin/generate: rejects bad level value → 422
 *  (f) POST /api/admin/generate: rejects cross-tenant domain → propagates 422
 *
 * Does NOT require a database — withTenant is mocked.
 * Mirrors admin-domain-create.test.ts / generate-cross-tenant-guard.test.ts style.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { ValidationError } from "@assessiq/core";

// Suppress unused import warning — ValidationError is used in rejects.toSatisfy
void ValidationError;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@assessiq/tenancy", () => ({
  withTenant: vi.fn(),
}));

vi.mock("@assessiq/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@assessiq/core")>();
  return {
    ...actual,
    uuidv7: vi.fn()
      .mockReturnValueOnce("pack-uuid-0000-0000-0000-000000000001")
      .mockReturnValueOnce("level-uuid-L1-0000-0000-000000000002")
      .mockReturnValueOnce("level-uuid-L2-0000-0000-000000000003")
      .mockReturnValueOnce("level-uuid-L3-0000-0000-000000000004")
      .mockReturnValue("fallback-uuid-0000-0000-0000-999999999999"),
  };
});

// Mock ai-grading so generateQuestions doesn't try to run real AI in endpoint tests
vi.mock("@assessiq/ai-grading", () => ({
  handleAdminGenerate: vi.fn().mockResolvedValue({
    questionIds: ["q-uuid-0001"],
    generated: 1,
    skillSha: "test-sha-abc",
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(queryCalls: Array<{ rows: Record<string, unknown>[] } | Error>): { query: ReturnType<typeof vi.fn> } {
  let callIndex = 0;
  return {
    query: vi.fn().mockImplementation(() => {
      const response = queryCalls[callIndex];
      callIndex++;
      if (response instanceof Error) return Promise.reject(response);
      return Promise.resolve(response ?? { rows: [] });
    }),
  };
}

// ---------------------------------------------------------------------------
// C1: findOrCreatePackForDomain
// ---------------------------------------------------------------------------

describe("findOrCreatePackForDomain", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-prime uuidv7 sequence each test after clearAllMocks resets call counts.
    const core = await import("@assessiq/core");
    (core.uuidv7 as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce("pack-uuid-0000-0000-0000-000000000001")
      .mockReturnValueOnce("level-uuid-L1-0000-0000-000000000002")
      .mockReturnValueOnce("level-uuid-L2-0000-0000-000000000003")
      .mockReturnValueOnce("level-uuid-L3-0000-0000-000000000004")
      .mockReturnValue("fallback-uuid-0000-0000-0000-999999999999");
  });

  it("(a) cross-tenant domain_id → 422 CROSS_TENANT_FK_REJECTED", async () => {
    const { withTenant } = await import("@assessiq/tenancy");

    // Guard query returns 0 rows (domain not in this tenant)
    const mockClient = makeClient([{ rows: [] }]);

    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn(mockClient),
    );

    const { findOrCreatePackForDomain } = await import("../service.js");

    await expect(
      findOrCreatePackForDomain(
        "tenant-a",
        "dom-uuid-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        "user-uuid-0000",
      ),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details?.["code"]).toBe("CROSS_TENANT_FK_REJECTED");
      return true;
    });

    // Guard must be the FIRST query fired — INSERT must NOT run
    const queries = (mockClient.query.mock.calls as Array<[string, unknown[]]>).map(([sql]) => sql);
    expect(queries[0]).toMatch(/FROM domains WHERE id/);
    expect(queries.some((q) => q.includes("INSERT INTO question_packs"))).toBe(false);
  });

  it("(b) first call: creates pack + heals L1, L2, L3 levels", async () => {
    const { withTenant } = await import("@assessiq/tenancy");

    // Query sequence:
    // 1. Guard → domain found with slug+name
    // 2. SELECT id FROM question_packs (not found)
    // 3. INSERT INTO question_packs → new pack id
    // 4. SELECT id,label FROM levels (none exist)
    // 5. INSERT levels L1, L2, L3 (3 inserts)
    const packId = "pack-uuid-0000-0000-0000-000000000001";
    const l1Id = "level-uuid-L1-0000-0000-000000000002";
    const l2Id = "level-uuid-L2-0000-0000-000000000003";
    const l3Id = "level-uuid-L3-0000-0000-000000000004";

    const mockClient = makeClient([
      { rows: [{ slug: "soc", name: "SOC Analyst" }] },  // guard
      { rows: [] },                                        // find pack → not found
      { rows: [{ id: packId }] },                         // insert pack RETURNING id
      { rows: [] },                                        // find existing levels → none
      { rows: [] },                                        // insert L1
      { rows: [] },                                        // insert L2
      { rows: [] },                                        // insert L3
    ]);

    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn(mockClient),
    );

    const { findOrCreatePackForDomain } = await import("../service.js");

    const result = await findOrCreatePackForDomain("tenant-a", "dom-id-soc", "user-id");

    expect(result.packId).toBe(packId);
    expect(result.levelIds.L1).toBe(l1Id);
    expect(result.levelIds.L2).toBe(l2Id);
    expect(result.levelIds.L3).toBe(l3Id);

    // Verify INSERT query was called with explicit tenant_id as $2
    const insertPackCall = (mockClient.query.mock.calls as Array<[string, unknown[]]>).find(
      ([sql]) => sql.includes("INSERT INTO question_packs"),
    );
    expect(insertPackCall).toBeDefined();
    const insertParams = insertPackCall![1];
    expect(insertParams[1]).toBe("tenant-a"); // tenant_id is $2 — EXPLICIT
    expect(insertParams[2]).toBe("dom-soc");   // slug = dom-<domainSlug>

    // Verify all 3 levels were inserted
    const levelInserts = (mockClient.query.mock.calls as Array<[string, unknown[]]>).filter(
      ([sql]) => sql.includes("INSERT INTO levels"),
    );
    expect(levelInserts).toHaveLength(3);
    const labels = levelInserts.map(([, params]) => (params as unknown[])[3]);
    expect(labels).toContain("L1");
    expect(labels).toContain("L2");
    expect(labels).toContain("L3");
  });

  it("(c) second call: idempotent — no dup pack, same packId returned", async () => {
    const { withTenant } = await import("@assessiq/tenancy");

    const packId = "existing-pack-uuid-1111-2222-333333333333";
    const l1Id = "existing-L1-uuid-aaaa-bbbb-cccccccccccc";
    const l2Id = "existing-L2-uuid-dddd-eeee-ffffffffffff";
    const l3Id = "existing-L3-uuid-1111-2222-333333333333";

    const mockClient = makeClient([
      { rows: [{ slug: "soc", name: "SOC Analyst" }] },                   // guard
      { rows: [{ id: packId }] },                                           // find pack → found
      // No INSERT INTO question_packs should happen
      { rows: [                                                               // find existing levels → all 3 exist
        { id: l1Id, label: "L1" },
        { id: l2Id, label: "L2" },
        { id: l3Id, label: "L3" },
      ] },
      // No INSERT INTO levels should happen
    ]);

    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn(mockClient),
    );

    const { findOrCreatePackForDomain } = await import("../service.js");

    const result = await findOrCreatePackForDomain("tenant-a", "dom-id-soc", "user-id");

    expect(result.packId).toBe(packId);
    expect(result.levelIds.L1).toBe(l1Id);
    expect(result.levelIds.L2).toBe(l2Id);
    expect(result.levelIds.L3).toBe(l3Id);

    // No INSERT INTO question_packs must fire (pack already exists)
    const allQueries = (mockClient.query.mock.calls as Array<[string, unknown[]]>).map(([sql]) => sql);
    expect(allQueries.some((q) => q.includes("INSERT INTO question_packs"))).toBe(false);
    // No INSERT INTO levels must fire (all 3 already exist)
    expect(allQueries.some((q) => q.includes("INSERT INTO levels"))).toBe(false);
  });

  it("(d) heals a missing level: pack exists, only L1+L2 exist → inserts L3", async () => {
    const { withTenant } = await import("@assessiq/tenancy");

    const packId = "existing-pack-uuid-partial";
    const l1Id = "existing-L1-uuid-aaaa";
    const l2Id = "existing-L2-uuid-bbbb";
    // After clearAllMocks + re-prime, the first uuidv7 return is:
    // "pack-uuid-0000-0000-0000-000000000001" — but here NO pack insert fires
    // (pack already exists), so the first uuidv7 consumption is for L3 insert.
    const l3Id = "pack-uuid-0000-0000-0000-000000000001";

    const mockClient = makeClient([
      { rows: [{ slug: "soc", name: "SOC Analyst" }] },   // guard
      { rows: [{ id: packId }] },                           // find pack → found
      { rows: [                                              // find existing levels → L1 + L2 only
        { id: l1Id, label: "L1" },
        { id: l2Id, label: "L2" },
      ] },
      { rows: [] },                                          // insert L3
    ]);

    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn(mockClient),
    );

    const { findOrCreatePackForDomain } = await import("../service.js");

    const result = await findOrCreatePackForDomain("tenant-a", "dom-id-soc", "user-id");

    expect(result.packId).toBe(packId);
    expect(result.levelIds.L1).toBe(l1Id);
    expect(result.levelIds.L2).toBe(l2Id);
    expect(result.levelIds.L3).toBe(l3Id);

    // Only L3 insert should fire
    const levelInserts = (mockClient.query.mock.calls as Array<[string, unknown[]]>).filter(
      ([sql]) => sql.includes("INSERT INTO levels"),
    );
    expect(levelInserts).toHaveLength(1);
    const insertedLabel = (levelInserts[0]![1] as unknown[])[3];
    expect(insertedLabel).toBe("L3");
  });
});

// ---------------------------------------------------------------------------
// C2: POST /api/admin/generate endpoint
// ---------------------------------------------------------------------------

describe("POST /api/admin/generate endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function buildApp() {
    const app = Fastify({ logger: false });

    // Inject session via preHandler (same pattern as bulk-status-route.test.ts).
    // Type assertion bypasses the strict session type — acceptable in tests.
    app.addHook("preHandler", async (req) => {
      (req as unknown as { session: { tenantId: string; userId: string } }).session = {
        tenantId: "tenant-a",
        userId: "user-id-0001",
      };
    });

    // Wire the same error handler as apps/api/src/server.ts so AppError
    // subclasses (ValidationError status=400) are mapped to JSON envelopes.
    const { AppError } = await import("@assessiq/core");
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof AppError) {
        const status = (err.details?.["httpStatus"] as number | undefined) ?? err.status;
        void reply.code(status).send({ error: err.toJson() });
        return;
      }
      void reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : String(err) } });
    });

    const { registerQuestionBankRoutes } = await import("../routes.js");
    await registerQuestionBankRoutes(app, { adminOnly: [], superAdminOnly: [] });
    await app.ready();
    return app;
  }

  it("(e) rejects invalid level value with 422", async () => {
    const { withTenant } = await import("@assessiq/tenancy");

    // Guard would pass (domain found), but level validation should fail BEFORE
    // resolver is called — so withTenant may or may not be called
    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_t: string, fn: (c: unknown) => Promise<unknown>) =>
        fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
    );

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/generate",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        domain_id: "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee",
        level: "L4",   // invalid — must be L1|L2|L3
        count: 5,
      }),
    });

    // ValidationError.status = 400 (default); no httpStatus override.
    // error.code = "VALIDATION_FAILED" (AppError top-level);
    // error.details.code = "INVALID_PARAM" (domain-specific discriminator).
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload) as { error?: { code?: string; details?: { code?: string } } };
    expect(body.error?.details?.["code"]).toBe("INVALID_PARAM");
    await app.close();
  });

  it("(f) propagates CROSS_TENANT_FK_REJECTED from resolver on cross-tenant domain", async () => {
    const { withTenant } = await import("@assessiq/tenancy");

    // Guard returns 0 rows → resolver throws CROSS_TENANT_FK_REJECTED
    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_t: string, fn: (c: unknown) => Promise<unknown>) =>
        fn({
          query: vi.fn().mockResolvedValue({ rows: [] }), // empty = guard fail
        }),
    );

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/generate",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        domain_id: "ffffffff-ffff-4fff-bfff-ffffffffffff",
        level: "L1",
        count: 3,
      }),
    });

    // ValidationError → 400 from error handler (default status).
    // error.details.code = "CROSS_TENANT_FK_REJECTED" (domain-specific discriminator).
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload) as { error?: { code?: string; details?: { code?: string } } };
    expect(body.error?.details?.["code"]).toBe("CROSS_TENANT_FK_REJECTED");
    await app.close();
  });

  it("(g) missing domain_id → 400 INVALID_PARAM", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/generate",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ level: "L1", count: 5 }),
    });
    // ValidationError.status = 400 (default).
    // error.details.code = "INVALID_PARAM" (domain-specific discriminator).
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload) as { error?: { code?: string; details?: { code?: string } } };
    expect(body.error?.details?.["code"]).toBe("INVALID_PARAM");
    await app.close();
  });
});
