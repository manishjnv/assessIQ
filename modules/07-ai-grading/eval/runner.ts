// AssessIQ — modules/07-ai-grading/eval/runner.ts
//
// Stage 1.5 — type-sharded generation eval harness.
// Implements golden-question loading, fixture loading, per-question scoring,
// eval case aggregation, baseline I/O, and regression comparison.
//
// Design reference: docs/design/2026-05-09-type-sharded-generation.md § 6.
//
// HARD CONSTRAINT: this file does NOT spawn claude and does NOT call any
// runtime/* function. It operates on static JSON files only.
// The lint-no-ambient-claude.ts invariant guard does not require update.

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Public type contracts
// ---------------------------------------------------------------------------

export type EvalType = "mcq" | "log_analysis" | "scenario" | "kql";

export interface KbSourceRef {
  id: string;
  name: string;
  citation: string;
  url: string;
  level_fit: "L1" | "L2" | "L3";
  function: string;
  description: string;
  tags: string[];
  kb_version: string;
}

export interface GoldenQuestion {
  type: EvalType;
  topic: string;
  points: number;
  content: unknown;
  knowledge_base_source_ids: string[];
}

/** Per-question check result produced by scoreQuestion(). */
export interface EvalScore {
  /** Synthesised from type + array index. */
  id: string;
  type: EvalType;
  schemaValid: boolean;
  citationsResolve: boolean;
  structuralCompleteness: boolean;
  topicNonEmpty: boolean;
  failures: string[];
}

/** Aggregate result for one (level, type) pair. */
export interface EvalResult {
  level: string;
  type: EvalType;
  total: number;
  /** Questions where all four checks pass. */
  passed: number;
  failed: number;
  scores: EvalScore[];
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const KbSourceRefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  citation: z.string().min(1),
  url: z.string().min(1),
  level_fit: z.enum(["L1", "L2", "L3"]),
  function: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string()),
  kb_version: z.string().min(1),
});

const GoldenBaseSchema = z.object({
  type: z.enum(["mcq", "log_analysis", "scenario", "kql"]),
  topic: z.string(),
  points: z.number().int().positive(),
  content: z.unknown(),
  knowledge_base_source_ids: z.array(z.string()).min(1),
});

// Per-type content schemas (mirror the omnibus skill's submit_questions shape)
const McqContentSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).length(4),
  correct: z.number().int().min(0).max(3),
  rationale: z.string().min(1),
});

const LogAnalysisContentSchema = z.object({
  question: z.string().min(1),
  log_format: z.enum(["json", "syslog", "windows_event", "freeform"]),
  log_excerpt: z.string().min(1),
  expected_findings: z.array(z.string()).min(2),
  sample_solution: z.string().min(1),
  hint: z.string().min(1),
});

const ScenarioContentSchema = z.object({
  title: z.string().min(1),
  intro: z.string().min(1),
  step_dependency: z.enum(["linear", "dag"]),
  steps: z
    .array(
      z.object({
        prompt: z.string().min(1),
        expected: z.string().min(1),
      }),
    )
    .min(1),
});

const KqlContentSchema = z.object({
  question: z.string().min(1),
  tables: z.array(z.string()).min(1),
  expected_keywords: z.array(z.string()).min(1),
  sample_solution: z.string().min(1),
});

// ---------------------------------------------------------------------------
// loadGolden
// ---------------------------------------------------------------------------

/**
 * Load and base-validate golden questions for the given level and type.
 * Reads eval/golden-questions/{level}/{type}.json.
 * Throws if the file is missing or any entry fails the base schema.
 */
export async function loadGolden(
  level: "L1" | "L2" | "L3",
  type: EvalType,
): Promise<GoldenQuestion[]> {
  const filePath = join(__dirname, "golden-questions", level, `${type}.json`);
  if (!existsSync(filePath)) {
    throw new Error(`Golden file missing: ${filePath}`);
  }
  const raw = await readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Golden file must be a JSON array: ${filePath}`);
  }
  return parsed.map((item, i) => {
    const result = GoldenBaseSchema.safeParse(item);
    if (!result.success) {
      throw new Error(
        `Golden[${i}] in ${filePath} invalid: ${result.error.issues.map((e) => e.message).join("; ")}`,
      );
    }
    return result.data as GoldenQuestion;
  });
}

// ---------------------------------------------------------------------------
// loadFixture
// ---------------------------------------------------------------------------

/**
 * Load KB source fixture for the given level.
 * Reads eval/fixtures/{level}-sources.json.
 * Throws if the file is missing or any entry fails validation.
 */
export async function loadFixture(level: "L1" | "L2" | "L3"): Promise<KbSourceRef[]> {
  const filePath = join(__dirname, "fixtures", `${level}-sources.json`);
  if (!existsSync(filePath)) {
    throw new Error(`Fixture file missing: ${filePath}`);
  }
  const raw = await readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Fixture file must be a JSON array: ${filePath}`);
  }
  return parsed.map((item, i) => {
    const result = KbSourceRefSchema.safeParse(item);
    if (!result.success) {
      throw new Error(
        `Fixture[${i}] in ${filePath} invalid: ${result.error.issues.map((e) => e.message).join("; ")}`,
      );
    }
    return result.data;
  });
}

// ---------------------------------------------------------------------------
// scoreQuestion
// ---------------------------------------------------------------------------

/**
 * Score a single golden question against a KB source fixture.
 * Runs four deterministic checks — no claude invocation.
 */
export function scoreQuestion(
  q: GoldenQuestion,
  fixture: KbSourceRef[],
  index: number,
): EvalScore {
  const id = `${q.type}-${index}`;
  const failures: string[] = [];
  let schemaValid = false;
  let structuralCompleteness = false;

  // --- schemaValid + structuralCompleteness (type-specific) ---
  switch (q.type) {
    case "mcq": {
      const r = McqContentSchema.safeParse(q.content);
      if (r.success) {
        schemaValid = true;
        structuralCompleteness = r.data.options.length === 4;
        if (!structuralCompleteness) failures.push("mcq: options.length !== 4");
      } else {
        failures.push(`schemaValid: ${r.error.issues.map((e) => e.message).join("; ")}`);
      }
      break;
    }
    case "log_analysis": {
      const r = LogAnalysisContentSchema.safeParse(q.content);
      if (r.success) {
        schemaValid = true;
        structuralCompleteness = r.data.expected_findings.length >= 2;
        if (!structuralCompleteness) failures.push("log_analysis: expected_findings.length < 2");
      } else {
        failures.push(`schemaValid: ${r.error.issues.map((e) => e.message).join("; ")}`);
      }
      break;
    }
    case "scenario": {
      const r = ScenarioContentSchema.safeParse(q.content);
      if (r.success) {
        schemaValid = true;
        structuralCompleteness = r.data.steps.length >= 1;
        if (!structuralCompleteness) failures.push("scenario: steps.length < 1");
      } else {
        failures.push(`schemaValid: ${r.error.issues.map((e) => e.message).join("; ")}`);
      }
      break;
    }
    case "kql": {
      const r = KqlContentSchema.safeParse(q.content);
      if (r.success) {
        schemaValid = true;
        structuralCompleteness = r.data.expected_keywords.length >= 1;
        if (!structuralCompleteness) failures.push("kql: expected_keywords.length < 1");
      } else {
        failures.push(`schemaValid: ${r.error.issues.map((e) => e.message).join("; ")}`);
      }
      break;
    }
  }

  // --- citationsResolve ---
  const sourceIds = new Set(fixture.map((s) => s.id));
  const missing = q.knowledge_base_source_ids.filter((sid) => !sourceIds.has(sid));
  const citationsResolve = missing.length === 0;
  if (!citationsResolve) {
    failures.push(`unknown source ids: ${missing.join(", ")}`);
  }

  // --- topicNonEmpty ---
  const topicNonEmpty = q.topic.trim().length > 0;
  if (!topicNonEmpty) failures.push(`topic is empty (id=${id})`);

  return {
    id,
    type: q.type,
    schemaValid,
    citationsResolve,
    structuralCompleteness,
    topicNonEmpty,
    failures,
  };
}

// ---------------------------------------------------------------------------
// runEvalCase
// ---------------------------------------------------------------------------

/**
 * Load goldens + fixture for (level, type) and score every question.
 * Returns an EvalResult summary with per-question EvalScore breakdown.
 */
export async function runEvalCase(
  level: "L1" | "L2" | "L3",
  type: EvalType,
): Promise<EvalResult> {
  const [goldens, fixture] = await Promise.all([loadGolden(level, type), loadFixture(level)]);
  const scores = goldens.map((q, i) => scoreQuestion(q, fixture, i));
  const passed = scores.filter(
    (s) => s.schemaValid && s.citationsResolve && s.structuralCompleteness && s.topicNonEmpty,
  ).length;
  return { level, type, total: scores.length, passed, failed: scores.length - passed, scores };
}

// ---------------------------------------------------------------------------
// loadBaseline
// ---------------------------------------------------------------------------

/**
 * Read eval/baseline.json.
 * Returns {} if the file is missing, empty, or unparseable —
 * expected state before the first ops-session baseline run.
 */
export async function loadBaseline(): Promise<Record<string, EvalResult>> {
  const baselinePath = join(__dirname, "baseline.json");
  if (!existsSync(baselinePath)) return {};
  try {
    const raw = await readFile(baselinePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, EvalResult>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// compareToBaseline
// ---------------------------------------------------------------------------

/**
 * Compare current EvalResults against a baseline snapshot.
 * Regression: current.passed < baseline.passed for any key present in both.
 * Improvement: current.passed > baseline.passed.
 * Keys in current but absent from baseline are skipped (new golden, no reference).
 */
export function compareToBaseline(
  current: Record<string, EvalResult>,
  baseline: Record<string, EvalResult>,
): { regressions: string[]; improvements: string[]; equal: boolean } {
  const regressions: string[] = [];
  const improvements: string[] = [];
  for (const [key, cur] of Object.entries(current)) {
    const base = baseline[key];
    if (base === undefined) continue;
    if (cur.passed < base.passed) {
      regressions.push(`${key}: passed ${cur.passed} < baseline ${base.passed}`);
    } else if (cur.passed > base.passed) {
      improvements.push(`${key}: passed ${cur.passed} > baseline ${base.passed}`);
    }
  }
  const equal = regressions.length === 0 && improvements.length === 0;
  return { regressions, improvements, equal };
}

// ---------------------------------------------------------------------------
// writeBaseline — used by cli-typed.ts write-baseline subcommand
// ---------------------------------------------------------------------------

export async function writeBaseline(
  data: Record<string, EvalResult>,
  outPath: string,
): Promise<void> {
  await writeFile(outPath, JSON.stringify(data, null, 2), "utf8");
}
