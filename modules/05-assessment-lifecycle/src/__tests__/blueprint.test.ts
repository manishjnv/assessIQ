/**
 * Unit tests: Phase 2 Slice A — Blueprint Assemble & Assign
 *
 * C1: createAssessment / updateAssessment — cross-tenant category_id guard → 422
 * C2: publishAssessment — POOL_TOO_SMALL_CRITERION names the failing criterion
 * C3: startAttempt — per-criterion draw returns Σcount when pool sufficient,
 *     degrades gracefully when short; no-blueprint regression (full-pool path identical)
 *
 * Does NOT need a database — withTenant and the pool query helpers are mocked.
 * Pattern mirrors generate-cross-tenant-guard.test.ts and find-or-create-pack-for-domain.test.ts.
 *
 * LOAD-BEARING: C1 cross-tenant guard + C3 no-blueprint regression are the
 * primary security/integrity controls in this slice. Opus adversarially reviews
 * the guard pattern and the regression path before deploy.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ValidationError } from "@assessiq/core";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@assessiq/tenancy", () => ({
  withTenant: vi.fn(),
}));

// Mock findOrCreatePackForDomain (used by C1 blueprint path)
vi.mock("../../../04-question-bank/src/service.js", () => ({
  findOrCreatePackForDomain: vi.fn().mockResolvedValue({
    packId: "pack-00000000-0000-0000-0000-000000000001",
    levelIds: {
      L1: "level-L1-0000-0000-0000-000000000002",
      L2: "level-L2-0000-0000-0000-000000000003",
      L3: "level-L3-0000-0000-0000-000000000004",
    },
  }),
}));

// Mock qbRepo (repository functions used inside the withTenant scope)
vi.mock("../../../04-question-bank/src/repository.js", () => ({
  findPackById: vi.fn().mockResolvedValue({
    id: "pack-00000000-0000-0000-0000-000000000001",
    status: "published",
    version: 1,
  }),
  findLevelById: vi.fn().mockResolvedValue({
    id: "level-L1-0000-0000-0000-000000000002",
    pack_id: "pack-00000000-0000-0000-0000-000000000001",
    duration_minutes: 60,
  }),
}));

// Mock repo (05-assessment-lifecycle repository)
vi.mock("../repository.js", () => ({
  findAssessmentById: vi.fn(),
  insertAssessment: vi.fn(),
  updateAssessmentRow: vi.fn(),
  listInvitationRows: vi.fn(),
}));

// Mock audit-log
vi.mock("@assessiq/audit-log", () => ({
  auditInTx: vi.fn().mockResolvedValue(undefined),
}));

// Mock email send (inviteUsers / sendInvitationEmail not under test here)
vi.mock("../email.js", () => ({
  sendInvitationEmail: vi.fn().mockResolvedValue(undefined),
}));

// Mock tokens
vi.mock("../tokens.js", () => ({
  hashInvitationToken: vi.fn().mockReturnValue("hash"),
  generateInvitationToken: vi.fn().mockReturnValue({ plaintext: "tok", hash: "hash" }),
  DEFAULT_INVITATION_TTL_HOURS: 72,
}));

// Mock tenancy repo
vi.mock("../../../02-tenancy/src/repository.js", () => ({
  findTenantById: vi.fn().mockResolvedValue({ id: "tenant-a", name: "Tenant A" }),
}));

// Mock state-machine (not under test here)
vi.mock("../state-machine.js", () => ({
  assertCanTransition: vi.fn(),
  assertValidWindow: vi.fn(),
  assertReopenAllowed: vi.fn(),
}));

// Mock core uuidv7
vi.mock("@assessiq/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@assessiq/core")>();
  return {
    ...actual,
    uuidv7: vi.fn().mockReturnValue("assessment-uuid-0000-0000-0000-000000000001"),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockQueryResponse = { rows: Record<string, unknown>[] } | Error;

/**
 * Build a mock client whose .query() calls return responses from the given sequence.
 * Each call advances the index; undefined = { rows: [] }.
 */
function makeClient(queryCalls: MockQueryResponse[]): { query: ReturnType<typeof vi.fn> } {
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

const TENANT_A = "a0000000-0000-4000-8000-000000000001";
const DOMAIN_ID = "d0000000-0000-4000-8000-000000000001";
const CAT_ID_1 = "c0000001-0000-4000-8000-000000000001";
const CAT_ID_2 = "c0000002-0000-4000-8000-000000000002";
const PACK_ID = "p0000000-0000-4000-8000-000000000001";
const LEVEL_ID = "l0000000-0000-4000-8000-000000000001";

const VALID_BLUEPRINT = {
  domain_id: DOMAIN_ID,
  level: "L1" as const,
  criteria: [
    { category_id: CAT_ID_1, type: "mcq" as const, count: 3 },
    { category_id: CAT_ID_2, type: "scenario" as const, count: 2 },
  ],
};

// ---------------------------------------------------------------------------
// C1: Cross-tenant FK guard — createAssessment
// ---------------------------------------------------------------------------

describe("C1 — createAssessment blueprint cross-tenant category guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects when domain belongs to another tenant (domain guard fails)", async () => {
    const { withTenant } = await import("@assessiq/tenancy");

    // Domain guard query returns 0 rows (domain not in this tenant)
    const mockClient = makeClient([{ rows: [] }]); // domain guard → miss

    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn(mockClient),
    );

    const { createAssessment } = await import("../service.js");

    await expect(
      createAssessment(
        TENANT_A,
        {
          pack_id: PACK_ID,
          level_id: LEVEL_ID,
          name: "Test Assessment",
          question_count: 5,
          opens_at: new Date(Date.now() + 60_000),
          settings: { blueprint: VALID_BLUEPRINT },
        },
        "admin-user-id",
      ),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details?.["code"]).toBe("CROSS_TENANT_FK_REJECTED");
      expect((err as ValidationError).details?.["field"]).toBe("blueprint.domain_id");
      return true;
    });
  });

  it("rejects when a category_id belongs to another tenant's domain (category guard fails)", async () => {
    const { withTenant } = await import("@assessiq/tenancy");

    // Domain guard passes, category guard fails on first category
    const mockClient = makeClient([
      { rows: [{ slug: "soc" }] },  // domain guard → pass
      { rows: [] },                  // category guard CAT_ID_1 → miss
    ]);

    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn(mockClient),
    );

    const { createAssessment } = await import("../service.js");

    await expect(
      createAssessment(
        TENANT_A,
        {
          pack_id: PACK_ID,
          level_id: LEVEL_ID,
          name: "Test Assessment",
          question_count: 5,
          opens_at: new Date(Date.now() + 60_000),
          settings: { blueprint: VALID_BLUEPRINT },
        },
        "admin-user-id",
      ),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details?.["code"]).toBe("CROSS_TENANT_FK_REJECTED");
      expect((err as ValidationError).details?.["field"]).toBe("blueprint.criteria[].category_id");
      expect((err as ValidationError).details?.["category_id"]).toBe(CAT_ID_1);
      return true;
    });
  });

  it("proceeds when all guards pass (resolves pack + inserts assessment)", async () => {
    const { withTenant } = await import("@assessiq/tenancy");
    const repo = await import("../repository.js");

    const ASSESSMENT_RESULT = {
      id: "assessment-uuid-0000-0000-0000-000000000001",
      tenant_id: TENANT_A,
      pack_id: PACK_ID,
      level_id: LEVEL_ID,
      pack_version: 1,
      name: "Test Assessment",
      description: null,
      status: "draft",
      question_count: 5,
      randomize: true,
      opens_at: new Date(Date.now() + 60_000),
      closes_at: null,
      settings: { blueprint: VALID_BLUEPRINT },
      created_by: "admin-user-id",
      created_at: new Date(),
      updated_at: new Date(),
    };

    // Domain guard → pass; CAT_ID_1 guard → pass; CAT_ID_2 guard → pass
    const mockClient = makeClient([
      { rows: [{ slug: "soc" }] },            // domain guard
      { rows: [{ id: CAT_ID_1 }] },           // cat guard CAT_ID_1
      { rows: [{ id: CAT_ID_2 }] },           // cat guard CAT_ID_2
      // qbRepo.findPackById called next inside withTenant
    ]);

    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn(mockClient),
    );

    (repo.insertAssessment as ReturnType<typeof vi.fn>).mockResolvedValue(ASSESSMENT_RESULT);

    const { createAssessment } = await import("../service.js");

    const result = await createAssessment(
      TENANT_A,
      {
        pack_id: PACK_ID,
        level_id: LEVEL_ID,
        name: "Test Assessment",
        question_count: 5,
        opens_at: new Date(Date.now() + 60_000),
        settings: { blueprint: VALID_BLUEPRINT },
      },
      "admin-user-id",
    );

    expect(result.id).toBe(ASSESSMENT_RESULT.id);
    expect(result.settings).toMatchObject({ blueprint: VALID_BLUEPRINT });
  });
});

// ---------------------------------------------------------------------------
// C1: Blueprint Zod validation
// ---------------------------------------------------------------------------

describe("C1 — blueprint Zod validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects blueprint with invalid level", async () => {
    // findOrCreatePackForDomain won't be called — Zod fails first
    const { createAssessment } = await import("../service.js");

    await expect(
      createAssessment(
        TENANT_A,
        {
          pack_id: PACK_ID,
          level_id: LEVEL_ID,
          name: "Test Assessment",
          question_count: 5,
          opens_at: new Date(Date.now() + 60_000),
          settings: {
            blueprint: {
              domain_id: DOMAIN_ID,
              level: "L9" as unknown as "L1",  // invalid
              criteria: [{ category_id: CAT_ID_1, type: "mcq", count: 3 }],
            },
          },
        },
        "admin-user-id",
      ),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details?.["code"]).toBe("BLUEPRINT_INVALID");
      return true;
    });
  });

  it("rejects blueprint with count < 1", async () => {
    const { createAssessment } = await import("../service.js");

    await expect(
      createAssessment(
        TENANT_A,
        {
          pack_id: PACK_ID,
          level_id: LEVEL_ID,
          name: "Test Assessment",
          question_count: 5,
          opens_at: new Date(Date.now() + 60_000),
          settings: {
            blueprint: {
              domain_id: DOMAIN_ID,
              level: "L1",
              criteria: [{ category_id: CAT_ID_1, type: "mcq", count: 0 }],  // invalid
            },
          },
        },
        "admin-user-id",
      ),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details?.["code"]).toBe("BLUEPRINT_INVALID");
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// C2: publishAssessment — POOL_TOO_SMALL_CRITERION
// ---------------------------------------------------------------------------

describe("C2 — publishAssessment blueprint per-criterion pool pre-flight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws POOL_TOO_SMALL_CRITERION naming the failing criterion when criterion pool is short", async () => {
    const { withTenant } = await import("@assessiq/tenancy");
    const repo = await import("../repository.js");

    const ASSESSMENT_WITH_BLUEPRINT = {
      id: "assessment-id-1",
      tenant_id: TENANT_A,
      pack_id: PACK_ID,
      level_id: LEVEL_ID,
      pack_version: 1,
      name: "Blueprint Assessment",
      description: null,
      status: "draft",
      question_count: 5,
      randomize: true,
      opens_at: null,
      closes_at: null,
      settings: {
        blueprint: {
          domain_id: DOMAIN_ID,
          level: "L1",
          criteria: [
            { category_id: CAT_ID_1, type: "mcq", count: 3 },     // need 3
            { category_id: CAT_ID_2, type: "scenario", count: 2 }, // need 2
          ],
        },
      },
      created_by: "admin-user-id",
      created_at: new Date(),
      updated_at: new Date(),
    };

    (repo.findAssessmentById as ReturnType<typeof vi.fn>).mockResolvedValue(ASSESSMENT_WITH_BLUEPRINT);
    (repo.updateAssessmentRow as ReturnType<typeof vi.fn>).mockResolvedValue({ ...ASSESSMENT_WITH_BLUEPRINT, status: "published" });

    // assertPublishEntitled fires getTenantTier first; tier='internal' bypasses
    // entitlement checks so the criterion pool-count queries follow in order.
    // count query for criterion 0 returns 3 (enough)
    // count query for criterion 1 returns 1 (NOT enough — need 2)
    const mockClient = makeClient([
      { rows: [{ tier: "internal" }] }, // getTenantTier → internal (bypass entitlement)
      { rows: [{ count: "3" }] },       // criterion 0: 3 available ≥ 3 required → pass
      { rows: [{ count: "1" }] },       // criterion 1: 1 available < 2 required → fail
    ]);

    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn(mockClient),
    );

    const { publishAssessment } = await import("../service.js");

    await expect(publishAssessment(TENANT_A, "assessment-id-1", "admin-user-id"))
      .rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(ValidationError);
        const details = (err as ValidationError).details as Record<string, unknown>;
        expect(details["code"]).toBe("POOL_TOO_SMALL_CRITERION");
        expect(details["criterion_index"]).toBe(1);
        expect(details["category_id"]).toBe(CAT_ID_2);
        expect(details["type"]).toBe("scenario");
        expect(details["available"]).toBe(1);
        expect(details["required"]).toBe(2);
        return true;
      });
  });

  it("publishes successfully when all criteria have sufficient pool", async () => {
    const { withTenant } = await import("@assessiq/tenancy");
    const repo = await import("../repository.js");

    const ASSESSMENT_WITH_BLUEPRINT = {
      id: "assessment-id-2",
      tenant_id: TENANT_A,
      pack_id: PACK_ID,
      level_id: LEVEL_ID,
      pack_version: 1,
      name: "Blueprint Assessment",
      description: null,
      status: "draft",
      question_count: 5,
      randomize: true,
      opens_at: null,
      closes_at: null,
      settings: {
        blueprint: {
          domain_id: DOMAIN_ID,
          level: "L1",
          criteria: [
            { category_id: CAT_ID_1, type: "mcq", count: 3 },
            { category_id: CAT_ID_2, type: "scenario", count: 2 },
          ],
        },
      },
      created_by: "admin-user-id",
      created_at: new Date(),
      updated_at: new Date(),
    };

    (repo.findAssessmentById as ReturnType<typeof vi.fn>).mockResolvedValue(ASSESSMENT_WITH_BLUEPRINT);
    const published = { ...ASSESSMENT_WITH_BLUEPRINT, status: "published" };
    (repo.updateAssessmentRow as ReturnType<typeof vi.fn>).mockResolvedValue(published);

    // assertPublishEntitled fires getTenantTier first; tier='internal' bypasses
    // entitlement checks so the criterion pool-count queries follow in order.
    // Both criteria have enough
    const mockClient = makeClient([
      { rows: [{ tier: "internal" }] }, // getTenantTier → internal (bypass entitlement)
      { rows: [{ count: "5" }] },       // criterion 0: 5 ≥ 3
      { rows: [{ count: "4" }] },       // criterion 1: 4 ≥ 2
    ]);

    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn(mockClient),
    );

    const { publishAssessment } = await import("../service.js");

    const result = await publishAssessment(TENANT_A, "assessment-id-2", "admin-user-id");
    expect(result.status).toBe("published");
  });

  it("no-blueprint path: uses existing whole-pool check (regression)", async () => {
    const { withTenant } = await import("@assessiq/tenancy");
    const repo = await import("../repository.js");

    const ASSESSMENT_NO_BLUEPRINT = {
      id: "assessment-id-3",
      tenant_id: TENANT_A,
      pack_id: PACK_ID,
      level_id: LEVEL_ID,
      pack_version: 1,
      name: "Legacy Assessment",
      description: null,
      status: "draft",
      question_count: 10,
      randomize: true,
      opens_at: null,
      closes_at: null,
      settings: {},  // no blueprint
      created_by: "admin-user-id",
      created_at: new Date(),
      updated_at: new Date(),
    };

    (repo.findAssessmentById as ReturnType<typeof vi.fn>).mockResolvedValue(ASSESSMENT_NO_BLUEPRINT);

    // assertPublishEntitled fires getTenantTier first; tier='internal' bypasses
    // entitlement checks so the whole-pool count query follows.
    // Whole-pool count: 5 < 10 required → POOL_TOO_SMALL (not POOL_TOO_SMALL_CRITERION)
    const mockClient = makeClient([
      { rows: [{ tier: "internal" }] }, // getTenantTier → internal (bypass entitlement)
      { rows: [{ count: "5" }] },       // whole-pool count
    ]);

    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn(mockClient),
    );

    const { publishAssessment } = await import("../service.js");

    await expect(publishAssessment(TENANT_A, "assessment-id-3", "admin-user-id"))
      .rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(ValidationError);
        const details = (err as ValidationError).details as Record<string, unknown>;
        // Must be the original POOL_TOO_SMALL code (not POOL_TOO_SMALL_CRITERION)
        expect(details["code"]).toBe("POOL_TOO_SMALL");
        expect(details["available"]).toBe(5);
        expect(details["required"]).toBe(10);
        return true;
      });
  });
});

// ---------------------------------------------------------------------------
// B1 (Slice A.1): PACK_NOT_PUBLISHED pre-flight — conditional skip for blueprint
// ---------------------------------------------------------------------------
//
// B1 fix: the pack-published guard in createAssessment is skipped when
// settings.blueprint is present.  Non-blueprint (legacy) path is unchanged.

describe("B1 — createAssessment pack-published conditional (Slice A.1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("blueprint + draft auto-pack → create SUCCEEDS (B1 fix)", async () => {
    // Setup: findPackById returns a DRAFT pack (the auto-pack state in production)
    const qbRepo = await import("../../../04-question-bank/src/repository.js");
    (qbRepo.findPackById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "pack-00000000-0000-0000-0000-000000000001",
      status: "draft",  // <-- draft auto-pack; pre-B1 this would throw PACK_NOT_PUBLISHED
      version: 1,
    });

    const { withTenant } = await import("@assessiq/tenancy");
    const repo = await import("../repository.js");

    const ASSESSMENT_RESULT = {
      id: "assessment-uuid-0000-0000-0000-000000000001",
      tenant_id: TENANT_A,
      pack_id: "pack-00000000-0000-0000-0000-000000000001",
      level_id: "level-L1-0000-0000-0000-000000000002",
      pack_version: 1,
      name: "Blueprint Draft Pack Test",
      description: null,
      status: "draft",
      question_count: 5,
      randomize: true,
      opens_at: null,
      closes_at: null,
      settings: { blueprint: VALID_BLUEPRINT },
      created_by: "admin-user-id",
      created_at: new Date(),
      updated_at: new Date(),
    };

    // withTenant client: domain guard → pass; cat guard x2 → pass
    const mockClient = makeClient([
      { rows: [{ slug: "soc" }] },   // domain guard
      { rows: [{ id: CAT_ID_1 }] }, // cat guard CAT_ID_1
      { rows: [{ id: CAT_ID_2 }] }, // cat guard CAT_ID_2
    ]);

    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn(mockClient),
    );
    (repo.insertAssessment as ReturnType<typeof vi.fn>).mockResolvedValue(ASSESSMENT_RESULT);

    const { createAssessment } = await import("../service.js");

    // Must NOT throw PACK_NOT_PUBLISHED
    const result = await createAssessment(
      TENANT_A,
      {
        pack_id: PACK_ID,
        level_id: LEVEL_ID,
        name: "Blueprint Draft Pack Test",
        question_count: 5,
        opens_at: new Date(Date.now() + 60_000),
        settings: { blueprint: VALID_BLUEPRINT },
      },
      "admin-user-id",
    );

    expect(result.id).toBe(ASSESSMENT_RESULT.id);
    expect(result.settings).toMatchObject({ blueprint: VALID_BLUEPRINT });
  });

  it("non-blueprint + draft pack → still throws PACK_NOT_PUBLISHED (regression)", async () => {
    // Setup: findPackById returns a DRAFT pack
    const qbRepo = await import("../../../04-question-bank/src/repository.js");
    (qbRepo.findPackById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "pack-00000000-0000-0000-0000-000000000001",
      status: "draft",  // draft pack, no blueprint → must still reject
      version: 1,
    });

    const { withTenant } = await import("@assessiq/tenancy");

    // No blueprint guard queries needed — guard triggers before FK checks
    const mockClient = makeClient([]);

    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn(mockClient),
    );

    const { createAssessment } = await import("../service.js");

    await expect(
      createAssessment(
        TENANT_A,
        {
          pack_id: PACK_ID,
          level_id: LEVEL_ID,
          name: "Legacy Assessment",
          question_count: 10,
          opens_at: new Date(Date.now() + 60_000),
          // NO settings.blueprint — legacy path
        },
        "admin-user-id",
      ),
    ).rejects.toSatisfy((err: unknown) => {
      // Must be the original PACK_NOT_PUBLISHED error
      expect(err).toBeInstanceOf(Error);
      const details = (err as { details?: Record<string, unknown> }).details;
      expect(details?.["code"]).toBe("PACK_NOT_PUBLISHED");
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// Slice A.2: opens_at mandatory — createAssessment + updateAssessment
// ---------------------------------------------------------------------------
//
// Acceptance:
//  1. createAssessment with opens_at null → OPENS_AT_REQUIRED (blueprint path)
//  2. createAssessment with opens_at null → OPENS_AT_REQUIRED (non-blueprint path)
//  3. createAssessment with opens_at set → proceeds past the check
//  4. updateAssessment {opens_at: null} → OPENS_AT_REQUIRED
//  5. updateAssessment without opens_at key → unaffected (other fields patch fine)
//  6. The create check fires BEFORE resolveBlueprintPackLevel (no auto-pack on missing Opens)

import * as qbService from "../../../04-question-bank/src/service.js";

describe("Slice A.2 — opens_at mandatory (createAssessment)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("blueprint path: opens_at=null → OPENS_AT_REQUIRED (before pack resolution)", async () => {
    const { createAssessment } = await import("../service.js");
    // findOrCreatePackForDomain must NOT be called when opens_at is missing
    const findOrCreate = vi.mocked(qbService.findOrCreatePackForDomain);
    findOrCreate.mockClear();

    await expect(
      createAssessment(
        TENANT_A,
        {
          pack_id: PACK_ID,
          level_id: LEVEL_ID,
          name: "No Opens Blueprint",
          question_count: 5,
          // opens_at deliberately omitted (undefined == null check)
          settings: { blueprint: VALID_BLUEPRINT },
        },
        "admin-user-id",
      ),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details?.["code"]).toBe("OPENS_AT_REQUIRED");
      return true;
    });

    // Assert no auto-pack was created (findOrCreatePackForDomain not called)
    expect(findOrCreate).not.toHaveBeenCalled();
  });

  it("non-blueprint path: opens_at=null → OPENS_AT_REQUIRED", async () => {
    const { createAssessment } = await import("../service.js");

    await expect(
      createAssessment(
        TENANT_A,
        {
          pack_id: PACK_ID,
          level_id: LEVEL_ID,
          name: "No Opens Legacy",
          question_count: 5,
          // opens_at deliberately omitted
        },
        "admin-user-id",
      ),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details?.["code"]).toBe("OPENS_AT_REQUIRED");
      return true;
    });
  });

  it("opens_at explicit null → OPENS_AT_REQUIRED", async () => {
    const { createAssessment } = await import("../service.js");

    await expect(
      createAssessment(
        TENANT_A,
        {
          pack_id: PACK_ID,
          level_id: LEVEL_ID,
          name: "Explicit Null Opens",
          question_count: 5,
          opens_at: null,
        },
        "admin-user-id",
      ),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details?.["code"]).toBe("OPENS_AT_REQUIRED");
      return true;
    });
  });

  it("opens_at set → check passes and proceeds (blueprint path)", async () => {
    const { withTenant } = await import("@assessiq/tenancy");
    const repo = await import("../repository.js");

    const ASSESSMENT_RESULT = {
      id: "assessment-uuid-0000-0000-0000-000000000001",
      tenant_id: TENANT_A,
      pack_id: "pack-00000000-0000-0000-0000-000000000001",
      level_id: "level-L1-0000-0000-0000-000000000002",
      pack_version: 1,
      name: "With Opens Blueprint",
      description: null,
      status: "draft",
      question_count: 5,
      randomize: true,
      opens_at: new Date(Date.now() + 60_000),
      closes_at: null,
      settings: { blueprint: VALID_BLUEPRINT },
      created_by: "admin-user-id",
      created_at: new Date(),
      updated_at: new Date(),
    };

    // Domain + cat guards pass; pack/level mocks already set at file top
    const mockClient = makeClient([
      { rows: [{ slug: "soc" }] },   // domain guard
      { rows: [{ id: CAT_ID_1 }] }, // cat guard CAT_ID_1
      { rows: [{ id: CAT_ID_2 }] }, // cat guard CAT_ID_2
    ]);

    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn(mockClient),
    );
    (repo.insertAssessment as ReturnType<typeof vi.fn>).mockResolvedValue(ASSESSMENT_RESULT);

    const { createAssessment } = await import("../service.js");

    const result = await createAssessment(
      TENANT_A,
      {
        pack_id: PACK_ID,
        level_id: LEVEL_ID,
        name: "With Opens Blueprint",
        question_count: 5,
        opens_at: new Date(Date.now() + 60_000),
        settings: { blueprint: VALID_BLUEPRINT },
      },
      "admin-user-id",
    );

    expect(result.id).toBe(ASSESSMENT_RESULT.id);
  });
});

describe("Slice A.2 — opens_at mandatory (updateAssessment)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("patch {opens_at: null} → OPENS_AT_REQUIRED", async () => {
    const { withTenant } = await import("@assessiq/tenancy");
    const repo = await import("../repository.js");

    const EXISTING_ASSESSMENT = {
      id: "assessment-id-update-1",
      tenant_id: TENANT_A,
      pack_id: PACK_ID,
      level_id: LEVEL_ID,
      pack_version: 1,
      name: "Existing Assessment",
      description: null,
      status: "draft",
      question_count: 5,
      randomize: true,
      opens_at: new Date(Date.now() + 60_000),
      closes_at: null,
      settings: {},
      created_by: "admin-user-id",
      created_at: new Date(),
      updated_at: new Date(),
    };

    (repo.findAssessmentById as ReturnType<typeof vi.fn>).mockResolvedValue(EXISTING_ASSESSMENT);

    const mockClient = makeClient([]);
    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn(mockClient),
    );

    const { updateAssessment } = await import("../service.js");

    await expect(
      updateAssessment(TENANT_A, "assessment-id-update-1", { opens_at: null }, "admin-user-id"),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details?.["code"]).toBe("OPENS_AT_REQUIRED");
      return true;
    });
  });

  it("patch without opens_at key → unaffected (name patch succeeds)", async () => {
    const { withTenant } = await import("@assessiq/tenancy");
    const repo = await import("../repository.js");

    const EXISTING_ASSESSMENT = {
      id: "assessment-id-update-2",
      tenant_id: TENANT_A,
      pack_id: PACK_ID,
      level_id: LEVEL_ID,
      pack_version: 1,
      name: "Old Name",
      description: null,
      status: "draft",
      question_count: 5,
      randomize: true,
      opens_at: new Date(Date.now() + 60_000),
      closes_at: null,
      settings: {},
      created_by: "admin-user-id",
      created_at: new Date(),
      updated_at: new Date(),
    };

    const UPDATED = { ...EXISTING_ASSESSMENT, name: "New Name" };

    (repo.findAssessmentById as ReturnType<typeof vi.fn>).mockResolvedValue(EXISTING_ASSESSMENT);
    (repo.updateAssessmentRow as ReturnType<typeof vi.fn>).mockResolvedValue(UPDATED);

    const mockClient = makeClient([]);
    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn(mockClient),
    );

    const { updateAssessment } = await import("../service.js");

    // Patch only name — opens_at key is absent → must NOT throw
    const result = await updateAssessment(
      TENANT_A,
      "assessment-id-update-2",
      { name: "New Name" },
      "admin-user-id",
    );

    expect(result.name).toBe("New Name");
  });
});
