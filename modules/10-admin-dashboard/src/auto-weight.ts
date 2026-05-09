// AssessIQ — modules/10-admin-dashboard/src/auto-weight.ts
//
// Pure functions for type-sharded question generation count allocation.
// Mirrors modules/07-ai-grading/src/auto-weight.ts — duplicated here so the
// frontend SPA bundle doesn't pull the ai-grading barrel (which transitively
// imports server-only modules like @assessiq/audit-log).
// Keep these two files in sync; both are pure (no deps, no I/O).

export type QuestionType =
  | "mcq"
  | "log_analysis"
  | "scenario"
  | "kql"
  | "subjective";

// ---------------------------------------------------------------------------
// Weight tables — source: omnibus skill front-matter weight table
// ---------------------------------------------------------------------------

/** Per-level weight distribution (must sum to 100 per level). */
export const TYPE_WEIGHTS: Record<"L1" | "L2" | "L3", Record<QuestionType, number>> = {
  L1: { mcq: 50, log_analysis: 30, scenario: 10, kql: 5, subjective: 5 },
  L2: { mcq: 35, log_analysis: 30, scenario: 20, kql: 10, subjective: 5 },
  L3: { mcq: 20, log_analysis: 20, scenario: 25, kql: 20, subjective: 15 },
};

// ---------------------------------------------------------------------------
// allocateByWeight — largest-remainder method
// ---------------------------------------------------------------------------

/**
 * Distribute `totalCount` questions across question types using the
 * largest-remainder method so the result always sums to `totalCount` exactly.
 *
 * Algorithm:
 *   1. exact[type] = weight[type] / 100 * totalCount
 *   2. floor each → base allocation
 *   3. remainder = totalCount - sum(base)
 *   4. Sort types by (exact - floor) descending
 *   5. Give +1 to the top `remainder` types in that order
 */
export function allocateByWeight(
  level: "L1" | "L2" | "L3",
  totalCount: number,
): Record<QuestionType, number> {
  const weights = TYPE_WEIGHTS[level];
  const types = Object.keys(weights) as QuestionType[];

  // Step 1-2: exact and floored values
  const exact: Record<string, number> = {};
  const floored: Record<string, number> = {};
  let baseSum = 0;
  for (const type of types) {
    const e = (weights[type] / 100) * totalCount;
    exact[type] = e;
    floored[type] = Math.floor(e);
    baseSum += Math.floor(e);
  }

  // Step 3: remainder to distribute
  const remainder = totalCount - baseSum;

  // Step 4: sort by fractional part descending (exact - floor), tie-break by type name for stability
  const sorted = types.slice().sort((a, b) => {
    const fracDiff = (exact[b]! - floored[b]!) - (exact[a]! - floored[a]!);
    return fracDiff !== 0 ? fracDiff : a.localeCompare(b);
  });

  // Step 5: distribute remainder
  const result = { ...floored } as Record<QuestionType, number>;
  for (let i = 0; i < remainder; i++) {
    result[sorted[i]!]!++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// applyOverride — honour per-type overrides, rebalance residual
// ---------------------------------------------------------------------------

/**
 * Apply caller-supplied per-type overrides to an allocation produced by
 * `allocateByWeight`. The total count is derived from the sum of the
 * incoming `allocation`.
 *
 * Rules:
 * - Overridden types take their override value exactly.
 * - If overrides sum >= totalCount, return overrides verbatim (non-overridden
 *   types are zeroed).
 * - Otherwise, distribute the residual (totalCount - overrideSum)
 *   proportionally across non-overridden types using largest-remainder.
 *   If only one non-overridden type remains, it gets the full residual.
 */
export function applyOverride(
  allocation: Record<QuestionType, number>,
  override: Partial<Record<QuestionType, number>>,
): Record<QuestionType, number> {
  const types = Object.keys(allocation) as QuestionType[];
  const totalCount = types.reduce((s, t) => s + allocation[t], 0);
  const overrideSum = (Object.keys(override) as QuestionType[]).reduce(
    (s, t) => s + (override[t] ?? 0),
    0,
  );

  const result = { ...allocation };

  // Apply overrides
  for (const type of types) {
    if (override[type] !== undefined) {
      result[type] = override[type]!;
    }
  }

  if (overrideSum >= totalCount) {
    // Overrides consume all (or more) — zero out non-overridden types
    for (const type of types) {
      if (override[type] === undefined) {
        result[type] = 0;
      }
    }
    return result;
  }

  // Residual to distribute across non-overridden types
  const residual = totalCount - overrideSum;
  const freeTypes = types.filter((t) => override[t] === undefined);

  if (freeTypes.length === 0) {
    return result;
  }

  if (freeTypes.length === 1) {
    result[freeTypes[0]!] = residual;
    return result;
  }

  // Proportional redistribution using original allocation weights as the basis
  const freeTotal = freeTypes.reduce((s, t) => s + allocation[t], 0);
  const exact: Record<string, number> = {};
  const floored: Record<string, number> = {};
  let baseSum = 0;
  for (const type of freeTypes) {
    const e = freeTotal === 0 ? residual / freeTypes.length : (allocation[type] / freeTotal) * residual;
    exact[type] = e;
    floored[type] = Math.floor(e);
    baseSum += Math.floor(e);
  }

  const rem = residual - baseSum;
  const sorted = freeTypes.slice().sort((a, b) => {
    const fracDiff = (exact[b]! - floored[b]!) - (exact[a]! - floored[a]!);
    return fracDiff !== 0 ? fracDiff : a.localeCompare(b);
  });

  for (const type of freeTypes) {
    result[type] = floored[type]!;
  }
  for (let i = 0; i < rem; i++) {
    result[sorted[i]!]!++;
  }

  return result;
}
