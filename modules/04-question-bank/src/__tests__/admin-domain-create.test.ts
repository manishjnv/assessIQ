/**
 * Unit tests: B1 write handlers — POST /api/admin/domains + /api/admin/categories
 *
 * Security focus (escalation trigger): handleAdminCreateCategory's cross-tenant
 * FK guard is the primary control preventing a category in tenant A from
 * referencing a domain in tenant B (Postgres FK bypasses RLS).
 *
 * Test cases (mirroring generate-cross-tenant-guard.test.ts mock style):
 *  (a) category-create with a domain_id belonging to another tenant → 422 CROSS_TENANT_FK_REJECTED
 *  (b) duplicate slug on domain create → 409 DOMAIN_SLUG_EXISTS
 *  (c) duplicate slug on category create → 409 CATEGORY_SLUG_EXISTS
 *  (d) happy-path domain create returns the row with server-generated slug
 *  (e) happy-path category create returns the row with server-generated slug
 *  (f) missing/non-existent domain_id (guard returns exists=false) → 422 CROSS_TENANT_FK_REJECTED
 *
 * Does NOT require a database — withTenant is mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ValidationError, ConflictError } from "@assessiq/core";

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

vi.mock("@assessiq/tenancy", () => ({
  withTenant: vi.fn(),
}));

// uuidv7 from @assessiq/core — mock to produce a deterministic id
vi.mock("@assessiq/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@assessiq/core")>();
  return {
    ...actual,
    uuidv7: vi.fn().mockReturnValue("00000000-0000-7000-8000-000000000001"),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock DB client whose query() always returns the given rows. */
function makeClient(rows: Record<string, unknown>[]): { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn().mockResolvedValue({ rows }) };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("handleAdminCreateDomain", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("(d) happy-path: returns created row with server-generated slug", async () => {
    const { withTenant } = await import("@assessiq/tenancy");

    // Sequence: MAX(display_order) query → INSERT RETURNING
    const mockClient = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ max: 3 }] })  // MAX query → nextOrder = 4
        .mockResolvedValueOnce({ rows: [{               // INSERT RETURNING
          id: "00000000-0000-7000-8000-000000000001",
          slug: "network-security",
          name: "Network Security",
          description: null,
          status: "active",
          display_order: 4,
        }] }),
    };

    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn(mockClient),
    );

    const { handleAdminCreateDomain } = await import("../handlers/admin-domains.js");

    const result = await handleAdminCreateDomain({
      tenantId: "tenant-a",
      name: "Network Security",
    });

    expect(result.slug).toBe("network-security");
    expect(result.display_order).toBe(4);
    expect(result.status).toBe("active");

    // Verify INSERT was called with explicit tenant_id ($2 param)
    const insertCall = mockClient.query.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("INSERT INTO domains"),
    );
    expect(insertCall).toBeDefined();
    // $2 must be the tenantId
    const params = insertCall![1] as unknown[];
    expect(params[1]).toBe("tenant-a");
  });

  it("(b) duplicate slug → 409 ConflictError with DOMAIN_SLUG_EXISTS", async () => {
    const { withTenant } = await import("@assessiq/tenancy");

    const pgUniqueError = Object.assign(new Error("duplicate key"), { code: "23505" });

    const mockClient = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ max: 0 }] }) // MAX(display_order)
        .mockRejectedValueOnce(pgUniqueError),          // INSERT throws unique violation
    };

    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn(mockClient),
    );

    const { handleAdminCreateDomain } = await import("../handlers/admin-domains.js");

    await expect(
      handleAdminCreateDomain({ tenantId: "tenant-a", name: "Network Security" }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).details?.["code"]).toBe("DOMAIN_SLUG_EXISTS");
      return true;
    });
  });

  it("rejects empty name with ValidationError", async () => {
    const { handleAdminCreateDomain } = await import("../handlers/admin-domains.js");
    await expect(
      handleAdminCreateDomain({ tenantId: "tenant-a", name: "   " }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("handleAdminCreateCategory", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("(a) cross-tenant domain_id (guard returns exists=false) → 422 CROSS_TENANT_FK_REJECTED", async () => {
    const { withTenant } = await import("@assessiq/tenancy");

    // Guard query returns exists=false → cross-tenant rejection
    const mockClient = makeClient([{ exists: false }]);

    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn(mockClient),
    );

    const { handleAdminCreateCategory } = await import("../handlers/admin-domains.js");

    await expect(
      handleAdminCreateCategory({
        tenantId: "tenant-a",
        domain_id: "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee",
        name: "Threat Intel",
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details?.["code"]).toBe("CROSS_TENANT_FK_REJECTED");
      return true;
    });
  });

  it("(f) non-existent domain_id (guard returns no rows) → 422 CROSS_TENANT_FK_REJECTED", async () => {
    const { withTenant } = await import("@assessiq/tenancy");

    // Guard query returns empty rows → treat as cross-tenant (domain doesn't exist for this tenant)
    const mockClient = makeClient([]);

    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn(mockClient),
    );

    const { handleAdminCreateCategory } = await import("../handlers/admin-domains.js");

    await expect(
      handleAdminCreateCategory({
        tenantId: "tenant-a",
        domain_id: "ffffffff-0000-4111-8222-333333333333",
        name: "New Cat",
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details?.["code"]).toBe("CROSS_TENANT_FK_REJECTED");
      return true;
    });
  });

  it("(e) happy-path: returns created row with server-generated slug + inherits domain supported_types", async () => {
    const { withTenant } = await import("@assessiq/tenancy");

    // Sequence: guard → domain supported_types → MAX(relevance_score) → INSERT RETURNING
    const mockClient = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ exists: true }] })                // guard
        .mockResolvedValueOnce({ rows: [{ supported_types: ["mcq", "scenario"] }] }) // domain types
        .mockResolvedValueOnce({ rows: [{ max: 5 }] })                      // MAX(relevance_score)
        .mockResolvedValueOnce({ rows: [{                                   // INSERT RETURNING
          id: "00000000-0000-7000-8000-000000000001",
          domain_id: "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee",
          slug: "threat-intel",
          name: "Threat Intel",
          description: null,
          relevance_score: 6,
          default_selected: true,
          supported_types: ["mcq", "scenario"],
          default_question_count: 1,
          status: "active",
        }] }),
    };

    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn(mockClient),
    );

    const { handleAdminCreateCategory } = await import("../handlers/admin-domains.js");

    const result = await handleAdminCreateCategory({
      tenantId: "tenant-a",
      domain_id: "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee",
      name: "Threat Intel",
    });

    expect(result.slug).toBe("threat-intel");
    expect(result.relevance_score).toBe(6);
    expect(result.default_selected).toBe(true);
    expect(result.status).toBe("active");

    // Verify INSERT was called with explicit tenant_id ($2 param)
    const insertCall = mockClient.query.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("INSERT INTO categories"),
    );
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    // Params: [id, tenant_id, domain_id, slug, name, description, relevance_score, supported_types, default_count]
    expect(params[1]).toBe("tenant-a"); // tenant_id explicit
    expect(params[2]).toBe("aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee"); // domain_id
  });

  it("(c) duplicate slug → 409 ConflictError with CATEGORY_SLUG_EXISTS", async () => {
    const { withTenant } = await import("@assessiq/tenancy");

    const pgUniqueError = Object.assign(new Error("duplicate key"), { code: "23505" });

    // guard passes, domain types, MAX, INSERT throws unique
    const mockClient = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ exists: true }] })          // guard
        .mockResolvedValueOnce({ rows: [{ supported_types: ["mcq"] }] }) // domain types
        .mockResolvedValueOnce({ rows: [{ max: 2 }] })                // MAX
        .mockRejectedValueOnce(pgUniqueError),                         // INSERT
    };

    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn(mockClient),
    );

    const { handleAdminCreateCategory } = await import("../handlers/admin-domains.js");

    await expect(
      handleAdminCreateCategory({
        tenantId: "tenant-a",
        domain_id: "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee",
        name: "Threat Intel",
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).details?.["code"]).toBe("CATEGORY_SLUG_EXISTS");
      return true;
    });
  });

  it("guard is called BEFORE INSERT (security sequence)", async () => {
    const { withTenant } = await import("@assessiq/tenancy");

    const queryOrder: string[] = [];
    const mockClient = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("EXISTS") && sql.includes("domains")) {
          queryOrder.push("guard");
          return Promise.resolve({ rows: [{ exists: false }] }); // reject here
        }
        if (sql.includes("INSERT")) {
          queryOrder.push("insert");
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      }),
    };

    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn(mockClient),
    );

    const { handleAdminCreateCategory } = await import("../handlers/admin-domains.js");

    await expect(
      handleAdminCreateCategory({
        tenantId: "tenant-a",
        domain_id: "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee",
        name: "ShouldFail",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    // Guard must fire; INSERT must NOT fire
    expect(queryOrder).toContain("guard");
    expect(queryOrder).not.toContain("insert");
  });
});
