/**
 * difficulty-spec.ts
 *
 * Phase A1 — pure, stateless difficulty specification for the AI question
 * generator.  No DB, no network, no `claude` invocation.
 *
 * Three exports drive downstream work:
 *   DIFFICULTY_SPEC  – the full (QuestionType × DifficultyLevel) matrix
 *   resolveDifficulty – typed accessor (type + level → DifficultyTarget)
 *   functionToNice   – coarse KbSource.function → NICE work-role name
 *   validateStructuralDifficulty – hard structural gate (Phase A)
 *
 * FU-C15 (2026-10-06): `numeric`, `multi_select` and `ordering` have NO entry
 * in DIFFICULTY_SPEC, by design — they are hand-authored/deterministic types,
 * never produced by the AI generator, so there is no generation difficulty to
 * target. Record this as "no spec by design", not a gap to fill.
 */

import { QUESTION_TYPES, getQuestionType } from "@assessiq/question-types";
import { type QuestionType } from "./types.js";

// ---------------------------------------------------------------------------
// Bloom's Taxonomy levels (ordered lowest → highest)
// ---------------------------------------------------------------------------

export const BLOOM_LEVELS = [
  "remember",
  "understand",
  "apply",
  "analyze",
  "evaluate",
  "create",
] as const;

export type BloomLevel = typeof BLOOM_LEVELS[number];

// ---------------------------------------------------------------------------
// Difficulty levels
// ---------------------------------------------------------------------------

export type DifficultyLevel = "L1" | "L2" | "L3";

// ---------------------------------------------------------------------------
// DifficultyTarget — per-(type, level) specification
// ---------------------------------------------------------------------------

export interface DifficultyTarget {
  /** Allowed / target Bloom levels for this (type, level) combination. */
  cognitiveLevel: BloomLevel[];

  // ---- structural HARD-gate bounds (only set for fields relevant to the type) ----

  /** mcq: exact number of options required. */
  optionsExactly?: number;

  /** kql: minimum number of tables. */
  tablesCountMin?: number;
  /** kql: maximum number of tables. */
  tablesCountMax?: number;

  /** scenario: minimum number of steps. */
  stepsMin?: number;
  /** scenario: maximum number of steps. */
  stepsMax?: number;
  /** scenario: step_dependency values that are allowed (validated against Zod enum "linear"|"parallel"). */
  allowedStepDependency?: readonly string[];

  /** subjective: minimum number of rubric anchors. */
  anchorMin?: number;
  /** subjective: maximum number of rubric anchors. */
  anchorMax?: number;

  // ---- descriptive params (carried for tagging + Phase B; NOT enforced as hard gates in Phase A) ----

  /** mcq: homogeneity of wrong-answer distractors. */
  distractorHomogeneity?: "low" | "medium" | "high";
  /** Stimulus complexity presented to the candidate. */
  stimulus?: "none" | "short_artifact" | "rich_multi_artifact";
  /** Number of inference steps required to reach the correct answer. */
  inferenceSteps?: number;
  /** subjective: mirrors LevelRubricDefaults profile. */
  profile?: "foundational" | "practitioner" | "expert";
  /** subjective: prose density expected in rubric anchors. */
  anchorComplexity?: "short" | "medium" | "dense";
  /** subjective: how strictly band boundaries are applied during grading. */
  bandStrictness?: "lenient" | "standard" | "strict";

  /** log_analysis: minimum number of log lines in the excerpt (descriptive only in Phase A). */
  logLinesMin?: number;
  /** log_analysis: maximum number of log lines in the excerpt (descriptive only in Phase A). */
  logLinesMax?: number;
  /** log_analysis: minimum number of expected findings (descriptive only in Phase A). */
  findingsMin?: number;
  /** log_analysis: maximum number of expected findings (descriptive only in Phase A). */
  findingsMax?: number;

  /** scenario: min words in intro + step prompts (Phase B warn-level only). */
  scenarioWordsMin?: number;
  /** scenario: max words in intro + step prompts (Phase B warn-level only). */
  scenarioWordsMax?: number;
  /** mcq: max (longest-shortest)/longest distractor length spread (Phase B warn-level only). */
  distractorSpreadMax?: number;
}

// ---------------------------------------------------------------------------
// DIFFICULTY_SPEC — the full (QuestionType × DifficultyLevel) matrix
// ---------------------------------------------------------------------------

/** AI-generated types only: numeric / multi_select / ordering / structured_case are authored by hand (no generation, no difficulty spec). */
type GeneratedQuestionType = Exclude<QuestionType, "numeric" | "multi_select" | "ordering" | "structured_case">;

/** Types the generator skills produce (the keys of DIFFICULTY_SPEC): those with a generatorSkill. */
export const GENERATED_TYPES = QUESTION_TYPES.filter(
  (t): t is GeneratedQuestionType => getQuestionType(t).generatorSkill !== null,
);

export const DIFFICULTY_SPEC: Record<GeneratedQuestionType, Record<DifficultyLevel, DifficultyTarget>> = {
  mcq: {
    L1: {
      cognitiveLevel: ["remember", "understand"],
      optionsExactly: 4,
      distractorHomogeneity: "low",
      distractorSpreadMax: 0.8,
      stimulus: "none",
      inferenceSteps: 1,
    },
    L2: {
      cognitiveLevel: ["apply", "analyze"],
      optionsExactly: 4,
      distractorHomogeneity: "medium",
      distractorSpreadMax: 0.65,
      stimulus: "short_artifact",
      inferenceSteps: 2,
    },
    L3: {
      cognitiveLevel: ["analyze", "evaluate"],
      optionsExactly: 4,
      distractorHomogeneity: "high",
      distractorSpreadMax: 0.5,
      stimulus: "rich_multi_artifact",
      inferenceSteps: 3,
    },
  },

  log_analysis: {
    L1: {
      cognitiveLevel: ["understand", "apply"],
      logLinesMin: 1,
      logLinesMax: 8,
      findingsMin: 1,
      findingsMax: 1,
    },
    L2: {
      cognitiveLevel: ["analyze"],
      logLinesMin: 10,
      logLinesMax: 20,
      findingsMin: 2,
      findingsMax: 3,
    },
    L3: {
      cognitiveLevel: ["analyze", "evaluate"],
      logLinesMin: 20,
      logLinesMax: 30,
      findingsMin: 3,
      findingsMax: 5,
    },
  },

  kql: {
    L1: {
      cognitiveLevel: ["apply"],
      tablesCountMin: 1,
      tablesCountMax: 1,
    },
    L2: {
      cognitiveLevel: ["apply", "analyze"],
      tablesCountMin: 1,
      tablesCountMax: 2,
    },
    L3: {
      cognitiveLevel: ["analyze", "create"],
      tablesCountMin: 2,
      tablesCountMax: 3,
    },
  },

  scenario: {
    L1: {
      cognitiveLevel: ["apply"],
      stepsMin: 2,
      stepsMax: 3,
      scenarioWordsMin: 40,
      scenarioWordsMax: 150,
      allowedStepDependency: ["linear"],
    },
    L2: {
      cognitiveLevel: ["analyze", "evaluate"],
      stepsMin: 3,
      stepsMax: 4,
      scenarioWordsMin: 80,
      scenarioWordsMax: 250,
      allowedStepDependency: ["linear"],
    },
    L3: {
      cognitiveLevel: ["evaluate", "create"],
      stepsMin: 4,
      stepsMax: 5,
      scenarioWordsMin: 120,
      scenarioWordsMax: 400,
      allowedStepDependency: ["linear", "parallel"],
    },
  },

  subjective: {
    L1: {
      cognitiveLevel: ["understand"],
      anchorMin: 2,
      anchorMax: 3,
      profile: "foundational",
      anchorComplexity: "short",
      bandStrictness: "lenient",
    },
    L2: {
      cognitiveLevel: ["analyze", "evaluate"],
      anchorMin: 3,
      anchorMax: 4,
      profile: "practitioner",
      anchorComplexity: "medium",
      bandStrictness: "standard",
    },
    L3: {
      cognitiveLevel: ["evaluate", "create"],
      anchorMin: 4,
      anchorMax: 6,
      profile: "expert",
      anchorComplexity: "dense",
      bandStrictness: "strict",
    },
  },
};

// ---------------------------------------------------------------------------
// resolveDifficulty — typed accessor
// ---------------------------------------------------------------------------

export function resolveDifficulty(
  type: GeneratedQuestionType,
  level: DifficultyLevel,
): DifficultyTarget {
  return DIFFICULTY_SPEC[type][level];
}

// ---------------------------------------------------------------------------
// functionToNice — coarse KbSource.function → NICE work-role name
//
// NOTE: coarse function→NICE map; refine to specific SP 800-181 task IDs later
// ---------------------------------------------------------------------------

const FUNCTION_TO_NICE_MAP: Record<string, string> = {
  triage: "Cyber Defense Analyst",
  analysis: "Cyber Defense Analyst",
  detection: "Cyber Defense Analyst",
  forensics: "Cyber Defense Forensics Analyst",
  hunting: "Threat/Warning Analyst",
  response: "Cyber Defense Incident Responder",
  intelligence: "Threat/Warning Analyst",
  governance: "Cyber Policy and Strategy Planner",
  architecture: "Security Architect",
};

export function functionToNice(fn: string): string {
  return FUNCTION_TO_NICE_MAP[fn] ?? "Cyber Defense Analyst";
}

// ---------------------------------------------------------------------------
// validateStructuralDifficulty — HARD structural gate (Phase A)
//
// Inspects raw JSON with safe narrowing only — does NOT import Zod schemas.
// D-3 RULE for subjective: if rubric is absent or has no anchors array,
// defer validation (rubric may not yet exist at generation time).
// ---------------------------------------------------------------------------

type StructuralResult = { ok: true } | { ok: false; reason: string };
type StructuralCheck = (
  level: DifficultyLevel,
  content: unknown,
  rubric: unknown,
  spec: DifficultyTarget,
) => StructuralResult;
const ok: StructuralCheck = () => ({ ok: true });

// Per-type bodies depend on 04 spec shapes, so they stay here. `satisfies` makes a
// missing question type a compile error. Hand-authored types have no difficulty gate.
const STRUCTURAL_CHECKS = {
  mcq: (level, content, rubric, spec) => {
      const c = content as Record<string, unknown> | null | undefined;
      if (!c || !Array.isArray(c["options"])) {
        return { ok: false, reason: "mcq content.options must be an array" };
      }
      const len = (c["options"] as unknown[]).length;
      if (len !== spec.optionsExactly) {
        return {
          ok: false,
          reason: `mcq content.options must have exactly ${spec.optionsExactly} items; got ${len}`,
        };
      }
      return { ok: true };
  },
  kql: (level, content, rubric, spec) => {
      const c = content as Record<string, unknown> | null | undefined;
      if (!c || !Array.isArray(c["tables"])) {
        return { ok: false, reason: "kql content.tables must be an array" };
      }
      const len = (c["tables"] as unknown[]).length;
      const min = spec.tablesCountMin ?? 0;
      const max = spec.tablesCountMax ?? Infinity;
      if (len < min || len > max) {
        return {
          ok: false,
          reason: `kql content.tables length must be between ${min} and ${max}; got ${len}`,
        };
      }
      return { ok: true };
  },
  scenario: (level, content, rubric, spec) => {
      const c = content as Record<string, unknown> | null | undefined;
      if (!c || !Array.isArray(c["steps"])) {
        return { ok: false, reason: "scenario content.steps must be an array" };
      }
      const stepsLen = (c["steps"] as unknown[]).length;
      const min = spec.stepsMin ?? 0;
      const max = spec.stepsMax ?? Infinity;
      if (stepsLen < min || stepsLen > max) {
        return {
          ok: false,
          reason: `scenario content.steps length must be between ${min} and ${max}; got ${stepsLen}`,
        };
      }
      // Only validate step_dependency if it is present and a string.
      const dep = c["step_dependency"];
      if (dep !== undefined && dep !== null && typeof dep === "string") {
        const allowed = spec.allowedStepDependency ?? [];
        if (!allowed.includes(dep)) {
          return {
            ok: false,
            reason: `scenario content.step_dependency "${dep}" is not allowed for ${level}; allowed: [${allowed.join(", ")}]`,
          };
        }
      }
      return { ok: true };
  },
  subjective: (level, content, rubric, spec) => {
      // D-3 RULE: rubric generated later — defer if absent or has no anchors array.
      if (rubric == null) return { ok: true };
      const r = rubric as Record<string, unknown>;
      if (!Array.isArray(r["anchors"])) return { ok: true };
      const anchorsLen = (r["anchors"] as unknown[]).length;
      const min = spec.anchorMin ?? 0;
      const max = spec.anchorMax ?? Infinity;
      if (anchorsLen < min || anchorsLen > max) {
        return {
          ok: false,
          reason: `subjective rubric.anchors length must be between ${min} and ${max}; got ${anchorsLen}`,
        };
      }
      return { ok: true };
  },
  log_analysis: () => {
      // No hard gate in Phase A.
      return { ok: true };
  },
  numeric: ok,
  multi_select: ok,
  ordering: ok,
  structured_case: ok,
} satisfies Record<QuestionType, StructuralCheck>;

export function validateStructuralDifficulty(
  type: QuestionType,
  level: DifficultyLevel,
  content: unknown,
  rubric: unknown,
): StructuralResult {
  // Hand-authored types have no DIFFICULTY_SPEC row; their check ignores spec.
  const spec = (DIFFICULTY_SPEC as Partial<Record<QuestionType, Record<DifficultyLevel, DifficultyTarget>>>)[type]?.[level] as DifficultyTarget;
  return STRUCTURAL_CHECKS[type](level, content, rubric, spec);
}

// ---------------------------------------------------------------------------
// Phase B warn heuristics (RW-50) - pure, lexical, NEVER reject.
//
// Each check returns warnings only; callers must not use them to block draft
// insertion. Thresholds come from the DIFFICULTY_SPEC rows (or the constant
// below); per-type dispatch is a keyed table, not a switch.
// ---------------------------------------------------------------------------

export interface DifficultyWarning {
  /** Stable machine code, safe to key UI/metrics on. */
  code: string;
  message: string;
}

type WarnCheck = (content: Record<string, unknown>, spec: DifficultyTarget) => DifficultyWarning[];

/** MCQ: correct option's stem-overlap exceeding the best distractor's by this much hints at a giveaway. */
const STEM_OVERLAP_GAP = 0.4;

const words = (t: unknown): string[] =>
  typeof t === "string" ? (t.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []) : [];

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function rangeWarning(code: string, what: string, n: number, min = 0, max = Infinity): DifficultyWarning[] {
  return n < min || n > max ? [{ code, message: `${what} ${n} outside target ${min}-${max}` }] : [];
}

const WARN_CHECKS: Partial<Record<QuestionType, WarnCheck>> = {
  log_analysis: (c, spec) => {
    const lines = typeof c["log_excerpt"] === "string" ? c["log_excerpt"].split(/\r?\n/).filter((l) => l.trim()).length : 0;
    return [
      ...rangeWarning("LOG_LINES_OUT_OF_RANGE", "log_analysis log lines", lines, spec.logLinesMin, spec.logLinesMax),
      ...rangeWarning("LOG_FINDINGS_OUT_OF_RANGE", "log_analysis findings", strs(c["expected_findings"]).length, spec.findingsMin, spec.findingsMax),
    ];
  },
  mcq: (c, spec) => {
    const opts = strs(c["options"]);
    const correct = typeof c["correct"] === "number" ? c["correct"] : -1;
    const out: DifficultyWarning[] = [];
    const lens = opts.filter((_, i) => i !== correct).map((o) => o.length);
    if (lens.length > 1 && spec.distractorSpreadMax !== undefined) {
      const hi = Math.max(...lens);
      const spread = hi === 0 ? 0 : (hi - Math.min(...lens)) / hi;
      if (spread > spec.distractorSpreadMax) {
        out.push({ code: "MCQ_DISTRACTOR_LENGTH_SPREAD", message: `mcq distractor length spread ${spread.toFixed(2)} exceeds ${spec.distractorSpreadMax}` });
      }
    }
    const stem = new Set(words(c["question"]));
    const overlap = (o: string): number => {
      const w = words(o);
      return w.length === 0 ? 0 : w.filter((x) => stem.has(x)).length / w.length;
    };
    if (opts.length > 1 && correct >= 0 && correct < opts.length) {
      const best = Math.max(...opts.filter((_, i) => i !== correct).map(overlap));
      if (overlap(opts[correct]!) - best >= STEM_OVERLAP_GAP) {
        out.push({ code: "MCQ_STEM_OVERLAP", message: "mcq correct option shares far more words with the stem than any distractor" });
      }
    }
    return out;
  },
  scenario: (c, spec) => {
    const steps = Array.isArray(c["steps"]) ? (c["steps"] as Array<Record<string, unknown>>) : [];
    const n = words(c["intro"]).length + steps.reduce((a, s) => a + words(s?.["prompt"]).length, 0);
    return rangeWarning("SCENARIO_LENGTH_OUT_OF_RANGE", "scenario words", n, spec.scenarioWordsMin, spec.scenarioWordsMax);
  },
};

/**
 * Warn-level (never blocking) lexical heuristics for a generated draft.
 * Returns [] for unknown types, non-object content, or in-range drafts. Never throws.
 */
export function warnStructuralDifficulty(
  type: QuestionType,
  level: DifficultyLevel,
  content: unknown,
): DifficultyWarning[] {
  const spec = (DIFFICULTY_SPEC as Partial<Record<QuestionType, Record<DifficultyLevel, DifficultyTarget>>>)[type]?.[level];
  const check = WARN_CHECKS[type];
  if (!spec || !check || content === null || typeof content !== "object") return [];
  try {
    return check(content as Record<string, unknown>, spec);
  } catch {
    return [];
  }
}
