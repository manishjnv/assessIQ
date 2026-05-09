// AssessIQ — modules/07-ai-grading/eval/runner.ts
//
// SCAFFOLD ONLY — Stage 1.
// Actual eval logic, fixtures, and golden questions are populated in Stage 1.5.
//
// This file defines the type contracts and stub implementations for the
// type-sharded generation eval harness. The existing cli.ts covers the
// grading pipeline eval; runner.ts is specific to generation quality.
//
// NOTE (D2): This file does NOT spawn claude in Stage 1. The stubs throw
// immediately. The lint (lint-no-ambient-claude.ts) does not need updating.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Type contracts
// ---------------------------------------------------------------------------

/** A single eval case: one skill invocation with known-good expected output. */
export interface EvalCase {
  /** Unique identifier, e.g. "l2-mcq-001". */
  id: string;
  /** Skill name, e.g. "generate-mcq". */
  skill: string;
  /** Path to the fixture input file (relative to eval/fixtures/). */
  fixturePath: string;
  /** Path to the golden expected output file (relative to eval/golden-questions/). */
  goldenPath: string;
}

/** Result of running a single EvalCase. */
export interface EvalResult {
  caseId: string;
  /** Whether the actual output matched the golden within threshold. */
  passed: boolean;
  /** Human-readable explanation of what matched / failed. */
  summary: string;
  /** Score for this case (0.0–1.0). */
  score: number;
  /** ISO-8601 timestamp. */
  ranAt: string;
}

/** Aggregate score for a skill across all its cases. */
export interface EvalScore {
  skill: string;
  /** Average score across all cases. */
  meanScore: number;
  /** How many cases passed. */
  passed: number;
  /** How many cases ran. */
  total: number;
  /** ISO-8601 date of the baseline run. */
  baselineDate: string;
}

// ---------------------------------------------------------------------------
// Stub implementations
// ---------------------------------------------------------------------------

/**
 * Run a single eval case.
 *
 * @throws Always in Stage 1. Stage 1.5 populates this with fixture loading,
 *   skill invocation, and golden-question comparison.
 */
export async function runEvalCase(
  _skill: string,
  _fixturePath: string,
  _goldenPath: string,
): Promise<EvalResult> {
  throw new Error(
    "Not implemented in Stage 1; populated in Stage 1.5 after golden questions are authored.",
  );
}

/**
 * Load the baseline score record from eval/baseline.json.
 * Returns an empty object if the file is missing (expected in Stage 1).
 */
export async function loadBaseline(): Promise<Record<string, EvalScore>> {
  const baselinePath = join(__dirname, "baseline.json");
  if (!existsSync(baselinePath)) {
    return {};
  }
  try {
    const raw = await readFile(baselinePath, "utf8");
    return JSON.parse(raw) as Record<string, EvalScore>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// CLI entry (scaffold)
// ---------------------------------------------------------------------------

// Using import.meta.url to detect direct execution in ESM
if (import.meta.url === `file://${process.argv[1]}`) {
  // eslint-disable-next-line no-console
  console.log(
    "eval harness scaffold — Stage 1.5 will populate fixtures and golden questions",
  );
  process.exit(0);
}
