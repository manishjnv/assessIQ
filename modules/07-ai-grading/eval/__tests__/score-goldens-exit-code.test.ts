/**
 * Exit-code contract tests for cmdScoreGoldens.
 *
 * Guards the CI gate added in .github/workflows/ci.yml step "AI generation
 * eval gate (score-goldens)": if cmdScoreGoldens stops exiting non-zero on
 * any structural golden failure, this test will catch the regression.
 *
 * Strategy: vi.mock intercepts the runner module before cli-typed loads it
 * (Vitest hoists vi.mock calls), so cmdScoreGoldens is exercised with
 * controlled EvalResult values — no on-disk golden reads, no claude calls.
 *
 * The malformed-golden case simulates a MCQ where options.length=3 (should
 * be exactly 4), which the McqContentSchema z.array().length(4) rejects.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// vi.mock is hoisted by Vitest before any static import runs.
vi.mock("../runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runner.js")>();
  return { ...actual, runEvalCase: vi.fn() };
});

import { cmdScoreGoldens } from "../cli-typed.js";
import { runEvalCase } from "../runner.js";
import type { EvalResult } from "../runner.js";

describe("score-goldens exit-code contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true (exit 0) when every golden passes all checks", async () => {
    const passing: EvalResult = {
      level: "L2",
      type: "mcq",
      total: 5,
      passed: 5,
      failed: 0,
      scores: [],
    };
    vi.mocked(runEvalCase).mockResolvedValue(passing);

    const result = await cmdScoreGoldens();
    expect(result).toBe(true);
  });

  it("returns false (exit 1) when a golden has options.length=3 (MCQ shape violation)", async () => {
    // Inject a failing result that represents an MCQ where options only has 3
    // entries instead of the required 4. This is the canonical regression that
    // schema drift or accidental golden edits can introduce.
    const failing: EvalResult = {
      level: "L2",
      type: "mcq",
      total: 5,
      passed: 4,
      failed: 1,
      scores: [
        {
          id: "mcq-0",
          type: "mcq",
          schemaValid: false,
          citationsResolve: true,
          structuralCompleteness: false,
          topicNonEmpty: true,
          failures: ["Array must contain exactly 4 element(s)"],
        },
      ],
    };
    vi.mocked(runEvalCase).mockResolvedValue(failing);

    const result = await cmdScoreGoldens();
    expect(result).toBe(false);
  });
});
