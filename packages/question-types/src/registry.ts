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
}

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
