/** CT-0: the upkeep reminder only claims due patterns and sends one mail; an unsent mail releases the claim. No database. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const queries: string[] = [];
let claimRows: Array<{ id: string }> = [];
vi.mock("@assessiq/tenancy", () => ({
  withSystemRole: vi.fn(async (_reason: string, fn: (c: unknown) => Promise<unknown>) =>
    fn({ query: async (sql: string) => { queries.push(sql); return { rows: sql.includes("RETURNING") ? claimRows : [] }; } })),
}));
vi.mock("@assessiq/notifications", () => ({ sendPatternReviewDueEmail: vi.fn() }));

import { processBlueprintUpkeepTick } from "../jobs/blueprint-upkeep-reminder.js";

beforeEach(() => { queries.length = 0; claimRows = []; });

describe("blueprint.upkeep_reminder", () => {
  it("sends one mail naming the count when patterns are due", async () => {
    claimRows = [{ id: "a" }, { id: "b" }];
    const send = vi.fn(async () => ({ sent: 1 }));
    expect(await processBlueprintUpkeepTick({ recipients: ["x@y.io"], send })).toEqual({ due: 2, sent: 1 });
    expect(send).toHaveBeenCalledWith({ to: ["x@y.io"], count: 2 });
    expect(queries.some((q) => q.includes("upkeep_reminded_at = NULL"))).toBe(false);
  });
  it("sends nothing when no pattern is due", async () => {
    const send = vi.fn();
    expect(await processBlueprintUpkeepTick({ recipients: ["x@y.io"], send })).toEqual({ due: 0, sent: 0 });
    expect(send).not.toHaveBeenCalled();
  });
  it("releases the claim when no mail could be sent, so the next tick retries", async () => {
    claimRows = [{ id: "a" }];
    await processBlueprintUpkeepTick({ recipients: ["x@y.io"], send: vi.fn(async () => ({ sent: 0 })) });
    expect(queries.some((q) => q.includes("upkeep_reminded_at = NULL"))).toBe(true);
  });
});
