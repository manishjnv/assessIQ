import type { z } from "zod";

export const QUESTION_TYPES = [
  "mcq",
  "subjective",
  "kql",
  "scenario",
  "log_analysis",
  "numeric",
  "multi_select",
  "ordering",
  "structured_case",
] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];

export interface ImportColumn {
  key: string;
  required: boolean;
}

export interface QuestionTypeDef {
  id: QuestionType;
  label: string;
  contentSchema: z.ZodTypeAny;
  /** Narrowing only. Never used to reject a stored answer. */
  answerSchema: z.ZodTypeAny;
  importColumns: readonly ImportColumn[];
  qtiInteraction: string;
  generatorSkill: string | null;
  scoring: "deterministic" | "ai";
  helpKey: string;

  // ---- Flags (RW-68) ----
  /** Graded by the AI pipeline on admin click (subjective, scenario, log_analysis). */
  aiGradeable: boolean;
  /** A stored rubric is required before the question can be activated (subjective, scenario). */
  rubricRequired: boolean;
  /** Where a grade-time ephemeral rubric gets its reference concepts from. */
  rubricSynthesis: "none" | "expected_findings" | "steps_expected";
  /** Content field the attempt engine shuffles per student; null = never shuffled. */
  shuffleField: "options" | "items" | null;

  // ---- Behaviours: pure functions, no DB, no React ----
  /** Content a candidate may see. Allowlist, fail-closed. Non-object content is returned unchanged. */
  candidateView(content: unknown): unknown;
  /** Tolerant key aliasing for generator output. Identity for types with no aliasing. */
  coerceContent(raw: Record<string, unknown>): Record<string, unknown>;
  /** Answer-key-free stem for the answer-format hint generator. */
  guidanceText(content: unknown): string;
  /** Question text handed to the rubric generator (may include reference answers). */
  rubricText(content: unknown): string;
  /** Reference concepts for a grade-time synthesised rubric. Present only when rubricSynthesis !== "none". */
  synthConcepts?(content: unknown): string[];
  /** 0..1 fraction of the points earned. Present ONLY when scoring === "deterministic". */
  deterministicScore?(content: unknown, answer: unknown): number;
  /** Structural completeness of a content object for the eval harness (also reports schema failure). */
  evalStructuralCheck(content: unknown): { ok: boolean; reason?: string };
  /**
   * Save-time check of an answer against the type (and frozen content). null always passes.
   * On success `answer` is the canonical value to store. Undefined for types with no extra check.
   */
  checkAnswer?(answer: unknown, frozenContent?: unknown): CheckAnswerResult;
}

export type CheckAnswerResult = { ok: true; answer: unknown } | { ok: false; reason: string };

import { definition as mcqDef } from "./types/mcq/index.js";
import { definition as subjectiveDef } from "./types/subjective/index.js";
import { definition as kqlDef } from "./types/kql/index.js";
import { definition as scenarioDef } from "./types/scenario/index.js";
import { definition as log_analysisDef } from "./types/log_analysis/index.js";
import { definition as numericDef } from "./types/numeric/index.js";
import { definition as multi_selectDef } from "./types/multi_select/index.js";
import { definition as orderingDef } from "./types/ordering/index.js";
import { definition as structured_caseDef } from "./types/structured_case/index.js";

export const QUESTION_TYPE_REGISTRY: Readonly<Record<QuestionType, QuestionTypeDef>> = {
  mcq: mcqDef,
  subjective: subjectiveDef,
  kql: kqlDef,
  scenario: scenarioDef,
  log_analysis: log_analysisDef,
  numeric: numericDef,
  multi_select: multi_selectDef,
  ordering: orderingDef,
  structured_case: structured_caseDef,
};

export function isQuestionType(id: unknown): id is QuestionType {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(QUESTION_TYPE_REGISTRY, id);
}

export function getQuestionType(id: string): QuestionTypeDef {
  if (!isQuestionType(id)) throw new Error(`UNKNOWN_QUESTION_TYPE: ${id}`);
  return QUESTION_TYPE_REGISTRY[id];
}

/** Types scored with no AI. Feeds the scoring SQL (`qv.type = ANY($n)`). */
export const DETERMINISTIC_IDS: readonly QuestionType[] = QUESTION_TYPES.filter(
  (t) => QUESTION_TYPE_REGISTRY[t].scoring === "deterministic",
);

if (DETERMINISTIC_IDS.length === 0) throw new Error("DETERMINISTIC_IDS must not be empty");

/** All ids, as a plain array (iteration helper; same order as QUESTION_TYPES). */
export function questionTypeIds(): readonly QuestionType[] {
  return QUESTION_TYPES;
}

const idsWhere = (f: (d: QuestionTypeDef) => boolean): readonly QuestionType[] =>
  QUESTION_TYPES.filter((t) => f(QUESTION_TYPE_REGISTRY[t]));

/** Types graded by the AI pipeline (admin click). */
export const AI_GRADEABLE_IDS: readonly QuestionType[] = idsWhere((d) => d.aiGradeable);
/** Types that need a stored rubric before activation. */
export const RUBRIC_REQUIRED_IDS: readonly QuestionType[] = idsWhere((d) => d.rubricRequired);
/** Types that can get an ephemeral rubric synthesised at grade time. */
export const RUBRIC_SYNTHESIS_IDS: readonly QuestionType[] = idsWhere((d) => d.rubricSynthesis !== "none");

export function isDeterministicType(id: string): boolean {
  return isQuestionType(id) && QUESTION_TYPE_REGISTRY[id].scoring === "deterministic";
}

// ---- String-typed wrappers: callers hold `type: string` from the DB. Unknown types fail closed. ----

/** Candidate view for a stored type string. Unknown type: question only (fail-closed). */
export function candidateViewFor(type: string, content: unknown): unknown {
  if (isQuestionType(type)) return QUESTION_TYPE_REGISTRY[type].candidateView(content);
  if (content === null || typeof content !== "object" || Array.isArray(content)) return content;
  const q = (content as Record<string, unknown>)["question"];
  return Object.prototype.hasOwnProperty.call(content, "question") ? { question: q } : {};
}

/** Coerce generator content; unknown type or non-object content passes through unchanged. */
export function coerceContentFor(type: unknown, content: Record<string, unknown>): Record<string, unknown> {
  return typeof type === "string" && isQuestionType(type) ? QUESTION_TYPE_REGISTRY[type].coerceContent(content) : content;
}

/** 0..1 fraction for a deterministic type; 0 for any other type. */
export function deterministicScoreFor(type: string, content: unknown, answer: unknown): number {
  return isQuestionType(type) ? (QUESTION_TYPE_REGISTRY[type].deterministicScore?.(content, answer) ?? 0) : 0;
}

/** Answer save check; types without checkAnswer, and unknown types, pass. */
export function checkAnswerFor(type: string | null, answer: unknown, frozenContent?: unknown): CheckAnswerResult {
  if (type !== null && isQuestionType(type)) {
    const r = QUESTION_TYPE_REGISTRY[type].checkAnswer?.(answer, frozenContent);
    if (r) return r;
  }
  return { ok: true, answer };
}
