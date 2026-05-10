/**
 * Pure runtime-metrics scoring tests for the score-candidate subcommand.
 *
 * No Docker, no DATABASE_URL, no DB — tests exercise scoreRuntimeMetrics()
 * directly with synthetic attempt data.  The function is a pure transform:
 * it reads no files and calls process.exit nowhere — easy to unit-test.
 *
 * Test cases:
 *   1. Happy path: all metrics pass → anyFail false, exit 0.
 *   2. chunks_failed=2/5 → chunk_success_rate exactly 0.60 → ✓ pass (≥, not >).
 *   3. chunks_failed=3/5 → chunk_success_rate 0.40 → ✗ FAIL.
 *   4. count_inserted=5/15 → total_inserted_pct 0.33 < 0.70 → ✗ FAIL.
 *   5. chunks_planned=0 → chunk_success_rate row value "n/a" (no division by zero).
 *   6. anyFail=true → with --strict-runtime the CLI would exit 1.
 *   7. anyFail=true but !strictRuntime → structural section drives exit code alone.
 *   8. thresholds=null → hasThresholds false, anyFail false (no thresholds available).
 */

import { describe, it, expect } from "vitest";
import { scoreRuntimeMetrics } from "../cli-typed.js";
import type { RuntimeThresholds } from "../runner.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const defaultThresholds: RuntimeThresholds = {
  min_chunk_success_rate: 0.6,
  max_peak_rss_mib: 1000,
  max_per_type_duration_ms_at_count_le_2: 360000,
  min_total_inserted_pct: 0.7,
};

function makeAttempt(
  overrides: Partial<{
    chunks_planned: number | null;
    chunks_failed: number | null;
    count_inserted: number;
    count_requested: number;
  }> = {},
) {
  return {
    chunks_planned: 5,
    chunks_failed: 0,
    count_inserted: 15,
    count_requested: 15,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scoreRuntimeMetrics", () => {
  it("(1) happy path: all metrics pass → no failing rows, anyFail false", () => {
    const result = scoreRuntimeMetrics(
      makeAttempt({ chunks_planned: 5, chunks_failed: 0, count_inserted: 15, count_requested: 15 }),
      defaultThresholds,
    );
    expect(result.hasThresholds).toBe(true);
    expect(result.anyFail).toBe(false);
    expect(result.rows.filter((r) => r.verdict === "fail")).toHaveLength(0);

    const csrRow = result.rows.find((r) => r.metric === "chunk_success_rate")!;
    expect(csrRow.verdict).toBe("pass");
    expect(csrRow.value).toBe("1.00");

    const tipRow = result.rows.find((r) => r.metric === "total_inserted_pct")!;
    expect(tipRow.verdict).toBe("pass");
    expect(tipRow.value).toBe("1.00");
  });

  it("(2) chunks_failed=2/5 → chunk_success_rate exactly 0.60 → ✓ pass (≥ not >)", () => {
    const result = scoreRuntimeMetrics(
      makeAttempt({ chunks_planned: 5, chunks_failed: 2 }),
      defaultThresholds,
    );
    const csrRow = result.rows.find((r) => r.metric === "chunk_success_rate")!;
    expect(csrRow.value).toBe("0.60");
    expect(csrRow.verdict).toBe("pass");
    expect(csrRow.threshold).toBe("≥0.60");
    // boundary: exactly at threshold is a pass, not a fail
    expect(result.anyFail).toBe(false);
  });

  it("(3) chunks_failed=3/5 → chunk_success_rate 0.40 < 0.60 → ✗ FAIL", () => {
    const result = scoreRuntimeMetrics(
      makeAttempt({ chunks_planned: 5, chunks_failed: 3 }),
      defaultThresholds,
    );
    const csrRow = result.rows.find((r) => r.metric === "chunk_success_rate")!;
    expect(csrRow.value).toBe("0.40");
    expect(csrRow.verdict).toBe("fail");
    expect(result.anyFail).toBe(true);
  });

  it("(4) count_inserted=5/15 → total_inserted_pct 0.33 < 0.70 → ✗ FAIL", () => {
    const result = scoreRuntimeMetrics(
      makeAttempt({ count_inserted: 5, count_requested: 15 }),
      defaultThresholds,
    );
    const tipRow = result.rows.find((r) => r.metric === "total_inserted_pct")!;
    expect(tipRow.value).toBe("0.33");
    expect(tipRow.verdict).toBe("fail");
    expect(result.anyFail).toBe(true);
  });

  it("(5) chunks_planned=0 → chunk_success_rate row shows 'n/a' (no division by zero)", () => {
    const result = scoreRuntimeMetrics(
      makeAttempt({ chunks_planned: 0, chunks_failed: 0 }),
      defaultThresholds,
    );
    const csrRow = result.rows.find((r) => r.metric === "chunk_success_rate")!;
    expect(csrRow.value).toBe("n/a");
    expect(csrRow.verdict).toBe("na");
    // chunks_planned=null is also safe
    const result2 = scoreRuntimeMetrics(
      makeAttempt({ chunks_planned: null, chunks_failed: null }),
      defaultThresholds,
    );
    const csrRow2 = result2.rows.find((r) => r.metric === "chunk_success_rate")!;
    expect(csrRow2.value).toBe("n/a");
    expect(csrRow2.verdict).toBe("na");
  });

  it("(6) anyFail=true → with --strict-runtime the CLI should exit 1", () => {
    // This test verifies that scoreRuntimeMetrics signals a failure that the
    // CLI gates on when --strict-runtime is passed.  The CLI contract is:
    //   if (runtimeMetrics.anyFail && strictRuntime) → process.exit(1)
    const result = scoreRuntimeMetrics(
      makeAttempt({ chunks_planned: 5, chunks_failed: 3 }),
      defaultThresholds,
    );
    expect(result.anyFail).toBe(true);
    // Exactly the failing rows the CLI would surface:
    const failingRows = result.rows.filter((r) => r.verdict === "fail");
    expect(failingRows).toHaveLength(1);
    expect(failingRows[0]!.metric).toBe("chunk_success_rate");
  });

  it("(7) anyFail=true without --strict-runtime → structural section is sole exit gate", () => {
    // When strictRuntime is false, the runtime section is informational only.
    // scoreRuntimeMetrics() returns anyFail=true, but the CLI does NOT exit 1
    // on that alone — the structural regression check (step 8) drives exit code.
    const result = scoreRuntimeMetrics(
      makeAttempt({ chunks_planned: 5, chunks_failed: 3, count_inserted: 5, count_requested: 15 }),
      defaultThresholds,
    );
    expect(result.anyFail).toBe(true);
    // The caller (cmdScoreCandidate) only gates when strictRuntime=true.
    // Without it, the CLI proceeds to the structural section regardless.
    // We confirm both failing metrics are present in the result:
    const failingMetrics = result.rows.filter((r) => r.verdict === "fail").map((r) => r.metric);
    expect(failingMetrics).toContain("chunk_success_rate");
    expect(failingMetrics).toContain("total_inserted_pct");
  });

  it("(8) thresholds=null → hasThresholds false, anyFail false, no rows", () => {
    const result = scoreRuntimeMetrics(makeAttempt(), null);
    expect(result.hasThresholds).toBe(false);
    expect(result.anyFail).toBe(false);
    expect(result.rows).toHaveLength(0);
    // The CLI prints "(no thresholds available)" and exits 0 in this case.
  });

  it("peak_rss_mib and per_type_duration rows are always 'na' — never drive anyFail", () => {
    // Verifies that unmeasured metrics never poison anyFail.
    const result = scoreRuntimeMetrics(
      makeAttempt({ chunks_planned: 5, chunks_failed: 0, count_inserted: 15, count_requested: 15 }),
      defaultThresholds,
    );
    const rssRow = result.rows.find((r) => r.metric === "peak_rss_mib")!;
    const durRow = result.rows.find((r) => r.metric === "per_type_duration (max)")!;
    expect(rssRow.verdict).toBe("na");
    expect(durRow.verdict).toBe("na");
    expect(result.anyFail).toBe(false);
  });

  it("threshold strings are formatted correctly", () => {
    const result = scoreRuntimeMetrics(makeAttempt(), defaultThresholds);
    const byMetric = Object.fromEntries(result.rows.map((r) => [r.metric, r]));
    expect(byMetric["chunk_success_rate"]!.threshold).toBe("≥0.60");
    expect(byMetric["total_inserted_pct"]!.threshold).toBe("≥0.70");
    expect(byMetric["per_type_duration (max)"]!.threshold).toBe("≤360000");
    expect(byMetric["peak_rss_mib"]!.threshold).toBe("≤1000");
  });
});
