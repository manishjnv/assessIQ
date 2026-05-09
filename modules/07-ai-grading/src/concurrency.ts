// AssessIQ — modules/07-ai-grading/src/concurrency.ts
//
// Tiny counting semaphore for type-sharded generation fan-out.
// Stage 1 — see docs/design/2026-05-09-type-sharded-generation.md.
//
// No external dependencies. Results are in input order (same contract as
// Promise.allSettled). Deterministic: given deterministic workers, running
// the same inputs twice yields the same result order.

/**
 * Run `worker` over every item in `items`, with at most `limit` workers
 * running concurrently at any moment. As each worker settles, the next
 * queued item starts immediately.
 *
 * Returns a `Promise<PromiseSettledResult<unknown>[]>` in input order,
 * matching the shape of `Promise.allSettled`.
 */
export function withConcurrencyLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<unknown>,
): Promise<PromiseSettledResult<unknown>[]> {
  return new Promise((resolve) => {
    if (items.length === 0) {
      resolve([]);
      return;
    }

    const results: PromiseSettledResult<unknown>[] = new Array(items.length);
    let nextIndex = 0;
    let settled = 0;

    function startNext(): void {
      if (nextIndex >= items.length) return;
      const index = nextIndex++;
      const item = items[index]!;

      worker(item).then(
        (value) => {
          results[index] = { status: "fulfilled", value };
          settled++;
          if (settled === items.length) {
            resolve(results);
          } else {
            startNext();
          }
        },
        (reason: unknown) => {
          results[index] = { status: "rejected", reason };
          settled++;
          if (settled === items.length) {
            resolve(results);
          } else {
            startNext();
          }
        },
      );
    }

    // Seed up to `limit` workers
    const seed = Math.min(limit, items.length);
    for (let i = 0; i < seed; i++) {
      startNext();
    }
  });
}
