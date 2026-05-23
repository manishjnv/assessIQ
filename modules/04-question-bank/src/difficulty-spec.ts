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
 */

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
}

// ---------------------------------------------------------------------------
// DIFFICULTY_SPEC — the full (QuestionType × DifficultyLevel) matrix
// ---------------------------------------------------------------------------

export const DIFFICULTY_SPEC: Record<QuestionType, Record<DifficultyLevel, DifficultyTarget>> = {
  mcq: {
    L1: {
      cognitiveLevel: ["remember", "understand"],
      optionsExactly: 4,
      distractorHomogeneity: "low",
      stimulus: "none",
      inferenceSteps: 1,
    },
    L2: {
      cognitiveLevel: ["apply", "analyze"],
      optionsExactly: 4,
      distractorHomogeneity: "medium",
      stimulus: "short_artifact",
      inferenceSteps: 2,
    },
    L3: {
      cognitiveLevel: ["analyze", "evaluate"],
      optionsExactly: 4,
      distractorHomogeneity: "high",
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
      allowedStepDependency: ["linear"],
    },
    L2: {
      cognitiveLevel: ["analyze", "evaluate"],
      stepsMin: 3,
      stepsMax: 4,
      allowedStepDependency: ["linear"],
    },
    L3: {
      cognitiveLevel: ["evaluate", "create"],
      stepsMin: 4,
      stepsMax: 5,
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
  type: QuestionType,
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

export function validateStructuralDifficulty(
  type: QuestionType,
  level: DifficultyLevel,
  content: unknown,
  rubric: unknown,
): { ok: true } | { ok: false; reason: string } {
  const spec = DIFFICULTY_SPEC[type][level];

  switch (type) {
    case "mcq": {
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
    }

    case "kql": {
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
    }

    case "scenario": {
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
    }

    case "subjective": {
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
    }

    case "log_analysis":
      // No hard gate in Phase A.
      return { ok: true };

    default:
      return { ok: true };
  }
}
