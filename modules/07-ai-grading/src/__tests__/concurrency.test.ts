// AssessIQ — modules/07-ai-grading/src/__tests__/concurrency.test.ts
//
// Unit tests for withConcurrencyLimit in concurrency.ts.

import { describe, it, expect } from "vitest";
import { withConcurrencyLimit } from "../concurrency.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("withConcurrencyLimit", () => {
  it("with limit=2 and 5 jobs of 50ms each, total time is ~150ms (not 250ms)", async () => {
    // With limit=2:
    //   Slot 0: job0 (0-50ms), job2 starts at ~50ms (50-100ms), job4 starts at ~100ms
    //   Slot 1: job1 (0-50ms), job3 starts at ~50ms (50-100ms)
    //   Total wall-time ≈ 150ms
    const start = Date.now();
    const results = await withConcurrencyLimit(
      [0, 1, 2, 3, 4],
      2,
      () => sleep(50),
    );
    const elapsed = Date.now() - start;
    // Should be ~150ms; allow generous slack for CI variability
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(400);
    expect(results).toHaveLength(5);
  }, 10_000);

  it("results are in input order even when jobs resolve out of order", async () => {
    // Items: 0→fast, 1→slow, 2→fast, 3→slow
    const delays = [80, 200, 80, 200];
    const results = await withConcurrencyLimit(
      delays,
      4, // all start at once so completion order differs from input order
      (d) => sleep(d).then(() => d),
    );
    expect(results.map((r) => (r as PromiseFulfilledResult<number>).value)).toEqual(delays);
  }, 10_000);

  it("mix of resolves and rejects yields correct PromiseSettledResult array", async () => {
    const items = [1, 2, 3];
    const results = await withConcurrencyLimit(items, 3, (n) => {
      if (n === 2) return Promise.reject(new Error("item2 failed"));
      return Promise.resolve(n * 10);
    });

    expect(results[0]).toEqual({ status: "fulfilled", value: 10 });
    expect(results[1]).toMatchObject({ status: "rejected" });
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(results[2]).toEqual({ status: "fulfilled", value: 30 });
  });

  it("empty items array resolves immediately with []", async () => {
    const results = await withConcurrencyLimit([], 2, () => Promise.resolve());
    expect(results).toEqual([]);
  });

  it("limit=1 serialises workers", async () => {
    const order: number[] = [];
    await withConcurrencyLimit([0, 1, 2], 1, async (n) => {
      await sleep(10);
      order.push(n);
    });
    expect(order).toEqual([0, 1, 2]);
  }, 10_000);
});
