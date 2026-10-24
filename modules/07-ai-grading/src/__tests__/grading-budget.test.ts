/**
 * Unit tests for ../grading-budget.ts (D6 budget gate, Z-163). withTenant and the repository are mocked: no DB.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@assessiq/tenancy", () => ({
  withTenant: vi.fn((_tenantId: string, fn: (c: unknown) => unknown) => fn({})),
}));
vi.mock("../repository.js", () => ({
  rollAndFindBudget: vi.fn(),
  addBudgetUsage: vi.fn(() => Promise.resolve()),
}));

import { assertBudget, callCostUsd, parseCachedUsage, recordUsage } from "../grading-budget.js";
import { addBudgetUsage, rollAndFindBudget } from "../repository.js";
import { AI_GRADING_ERROR_CODES } from "../types.js";

const row = (monthly_budget_usd: number, used_usd: number) => ({ monthly_budget_usd, used_usd });

beforeEach(() => {
  vi.mocked(rollAndFindBudget).mockReset();
  vi.mocked(addBudgetUsage).mockClear();
});

describe("callCostUsd", () => {
  it("prices Haiku 5.5 and Sonnet 5.5 per million tokens", () => {
    expect(callCostUsd("claude-haiku-5-5", { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBeCloseTo(0.6, 6);
    expect(callCostUsd("claude-sonnet-5-5", { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBeCloseTo(12, 6);
  });

  it("bills cache write at 1.25x and cache read at 0.1x of the input price", () => {
    const usd = callCostUsd("claude-sonnet-5-5", { cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 });
    expect(usd).toBeCloseTo(2 * 1.25 + 2 * 0.1, 6);
  });

  it("bills an unknown model at the dearest rate", () => {
    expect(callCostUsd("claude-mystery-9", { output_tokens: 1_000_000 })).toBeCloseTo(20, 6);
  });
});

describe("assertBudget", () => {
  it("passes when there is no row (unlimited)", async () => {
    vi.mocked(rollAndFindBudget).mockResolvedValue(null);
    await expect(assertBudget("t1")).resolves.toBeUndefined();
  });

  it("passes when the budget is 0 (unlimited, ledger only)", async () => {
    vi.mocked(rollAndFindBudget).mockResolvedValue(row(0, 5) as never);
    await expect(assertBudget("t1")).resolves.toBeUndefined();
  });

  it("passes while used is under the budget", async () => {
    vi.mocked(rollAndFindBudget).mockResolvedValue(row(10, 9.99) as never);
    await expect(assertBudget("t1")).resolves.toBeUndefined();
  });

  it("refuses with 429 BUDGET_EXHAUSTED when used reaches the budget", async () => {
    vi.mocked(rollAndFindBudget).mockResolvedValue(row(10, 10) as never);
    await expect(assertBudget("t1")).rejects.toMatchObject({ code: AI_GRADING_ERROR_CODES.BUDGET_EXHAUSTED, status: 429 });
  });
});

describe("recordUsage", () => {
  it("writes the cost and token counts to the ledger", async () => {
    await recordUsage("t1", { usd: 0.008, inputTokens: 3000, outputTokens: 400 });
    expect(addBudgetUsage).toHaveBeenCalledWith({}, { usd: 0.008, inputTokens: 3000, outputTokens: 400 });
  });
});

describe("parseCachedUsage (Z-163 per-row cost)", () => {
  it("accepts a clean record and rounds tokens", () => {
    expect(parseCachedUsage({ usd: 0.0085, input_tokens: 2800.4, output_tokens: 300 })).toEqual({ usd: 0.0085, input_tokens: 2800, output_tokens: 300 });
  });
  it("drops anything that is not a clean non-negative record", () => {
    expect(parseCachedUsage(undefined)).toBeNull();
    expect(parseCachedUsage(null)).toBeNull();
    expect(parseCachedUsage("x")).toBeNull();
    expect(parseCachedUsage({ usd: -1, input_tokens: 1, output_tokens: 1 })).toBeNull();
    expect(parseCachedUsage({ usd: 1, input_tokens: "5", output_tokens: 1 })).toBeNull();
    expect(parseCachedUsage({ usd: Number.NaN, input_tokens: 1, output_tokens: 1 })).toBeNull();
  });
});
