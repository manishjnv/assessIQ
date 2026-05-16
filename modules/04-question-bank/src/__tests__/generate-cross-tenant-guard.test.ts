/**
 * Unit test: cross-tenant FK guard in generateQuestions service.
 *
 * The guard is the primary security control that prevents a question in tenant A
 * from referencing a domain/category in tenant B. Postgres FK validation bypasses
 * RLS, so the explicit query (SELECT 1 FROM categories WHERE id=p1 AND domain_id=p2
 * AND tenant_id=p3) is load-bearing.
 *
 * This test validates the guard logic by mocking withTenant and intercepting the
 * guard query. It does NOT need a database or testcontainer.
 *
 * The security invariant: when passing a domain_id/category_id that does NOT
 * belong to the session tenant, generateQuestions MUST throw ValidationError with
 * code CROSS_TENANT_FK_REJECTED and NOT proceed to handleAdminGenerate.
 */

import { describe, it, expect, vi } from "vitest";
import { ValidationError } from "@assessiq/core";

// ---------------------------------------------------------------------------
// Mock setup — intercept withTenant to simulate cross-tenant rejection
// ---------------------------------------------------------------------------

// We test the guard logic in isolation by replacing withTenant with a mock
// that returns exists=false (simulating a cross-tenant mismatch).
vi.mock("@assessiq/tenancy", () => ({
  withTenant: vi.fn(),
}));

// Mock @assessiq/ai-grading to ensure handleAdminGenerate is NEVER called
// when the guard rejects.
vi.mock("@assessiq/ai-grading", () => ({
  handleAdminGenerate: vi.fn().mockRejectedValue(new Error("handleAdminGenerate must NOT be called on guard rejection")),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateQuestions — cross-tenant FK guard", () => {
  it("returns CROSS_TENANT_FK_REJECTED when category does not belong to session tenant", async () => {
    const { withTenant } = await import("@assessiq/tenancy");

    // Simulate the guard query returning exists=false (cross-tenant attempt)
    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => {
        const mockClient = {
          query: vi.fn().mockResolvedValue({ rows: [{ exists: false }] }),
        };
        return fn(mockClient);
      },
    );

    const { generateQuestions } = await import("../service.js");

    const domainId = "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee";
    const categoryId = "ffffffff-0000-4111-8222-333333333333";
    const tenantId = "tenant-a-uuid-1111-2222-333333333333";

    await expect(
      generateQuestions(
        tenantId,
        "user-id",
        "pack-id",
        "level-id",
        5,
        undefined,
        undefined,
        domainId,
        categoryId,
      ),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details?.["code"]).toBe("CROSS_TENANT_FK_REJECTED");
      return true;
    });
  });

  it("passes through (calls handleAdminGenerate) when guard query returns exists=true", async () => {
    const { withTenant } = await import("@assessiq/tenancy");
    const { handleAdminGenerate } = await import("@assessiq/ai-grading");

    // Reset the mock to return exists=true (legitimate same-tenant call)
    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => {
        const mockClient = {
          query: vi.fn().mockResolvedValue({ rows: [{ exists: true }] }),
        };
        return fn(mockClient);
      },
    );

    (handleAdminGenerate as ReturnType<typeof vi.fn>).mockResolvedValue({
      questionIds: ["q1"],
      generated: 1,
      skillSha: "abc123",
    });

    const { generateQuestions } = await import("../service.js");

    const result = await generateQuestions(
      "tenant-id",
      "user-id",
      "pack-id",
      "level-id",
      1,
      undefined,
      undefined,
      "dom-uuid-aaaa-bbbb-cccc-dddddddddddd",
      "cat-uuid-eeee-ffff-0000-111111111111",
    );

    expect(handleAdminGenerate).toHaveBeenCalled();
    expect(result.generated).toBe(1);
  });

  it("skips guard when domainId is undefined (legacy path)", async () => {
    const { withTenant } = await import("@assessiq/tenancy");
    const { handleAdminGenerate } = await import("@assessiq/ai-grading");

    // withTenant should still be called (for other queries: level resolution, existingTopics)
    // but NOT for the guard query
    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => {
        const mockClient = {
          query: vi.fn().mockResolvedValue({ rows: [] }),
        };
        return fn(mockClient);
      },
    );

    (handleAdminGenerate as ReturnType<typeof vi.fn>).mockResolvedValue({
      questionIds: [],
      generated: 0,
      skillSha: "no-sha",
    });

    const { generateQuestions } = await import("../service.js");

    // No domainId/categoryId -- guard should be skipped
    await generateQuestions("tenant-id", "user-id", "pack-id", "level-id", 5);

    // handleAdminGenerate called without domainId/categoryId
    expect(handleAdminGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-id" }),
    );
    const callArg = (handleAdminGenerate as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(callArg?.domainId).toBeUndefined();
    expect(callArg?.categoryId).toBeUndefined();
  });

  // SECURITY (Opus, 2026-05-16): the exactly-one-supplied bypass. Without the
  // both-or-neither guard, passing only domainId skips the composite tenant
  // check while the unvalidated FK still reaches insertDrafts (FK bypasses RLS)
  // → cross-tenant leak. Must reject BEFORE generation.
  it("rejects when only domainId is supplied (no categoryId) — partial-tag bypass", async () => {
    const { withTenant } = await import("@assessiq/tenancy");
    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_t: string, fn: (c: unknown) => Promise<unknown>) =>
        fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
    );
    const { generateQuestions } = await import("../service.js");
    await expect(
      generateQuestions(
        "tenant-id", "user-id", "pack-id", "level-id", 5,
        undefined, undefined,
        "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee", // domainId only
        undefined,
      ),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details?.["code"]).toBe("CROSS_TENANT_FK_REJECTED");
      return true;
    });
  });

  it("rejects when only categoryId is supplied (no domainId) — partial-tag bypass", async () => {
    const { withTenant } = await import("@assessiq/tenancy");
    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_t: string, fn: (c: unknown) => Promise<unknown>) =>
        fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
    );
    const { generateQuestions } = await import("../service.js");
    await expect(
      generateQuestions(
        "tenant-id", "user-id", "pack-id", "level-id", 5,
        undefined, undefined,
        undefined,
        "ffffffff-0000-4111-8222-333333333333", // categoryId only
      ),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details?.["code"]).toBe("CROSS_TENANT_FK_REJECTED");
      return true;
    });
  });
});
