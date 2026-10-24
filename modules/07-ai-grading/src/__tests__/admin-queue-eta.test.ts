// SP11: GET /api/admin/dashboard/queue carries evaluationTurnaroundText.
// Unit test: DB and tenancy are mocked, so no Docker is needed.
import { describe, it, expect, vi } from "vitest";

vi.mock("@assessiq/tenancy", () => ({
  withTenant: async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn({}),
}));
vi.mock("../repository.js", () => ({
  listGradingQueue: async () => [],
  countGradingQueue: async () => ({ in_queue: 0, awaiting_release: 0, ready_to_publish: 0, by_assessment: [] }),
}));

import { handleAdminQueue } from "../handlers/admin-queue.js";
import { config } from "@assessiq/core";

describe("handleAdminQueue evaluationTurnaroundText (SP11)", () => {
  it("returns the configured turnaround text next to the queue", async () => {
    const out = await handleAdminQueue({ tenantId: "00000000-0000-0000-0000-000000000001" });
    expect(out.evaluationTurnaroundText).toBe(config.EVALUATION_TURNAROUND_TEXT);
    expect(out.evaluationTurnaroundText.length).toBeGreaterThan(0);
  });
});
