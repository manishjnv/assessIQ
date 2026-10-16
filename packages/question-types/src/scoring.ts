// Pure scoring primitives, re-exported for callers that need the building blocks (module 09).
export { isMcqAnswerCorrect } from "./types/mcq/index.js";
export { isNumericAnswerCorrect, parseNumericAnswer } from "./types/numeric/index.js";
export { multiSelectFraction } from "./types/multi_select/index.js";
export { orderingFraction } from "./types/ordering/index.js";
export { structuredCaseFraction, structuredCaseMarks } from "./types/structured_case/index.js";

import { QUESTION_TYPE_REGISTRY, isAnswerAttemptedFor, isQuestionType } from "./registry.js";

export type MarksStatus = "correct" | "partial" | "incorrect";

/**
 * EX-1: marks for one deterministic question. fraction >= 1 -> full points; 0 < fraction < 1 ->
 * round2(points x fraction), no penalty; fraction 0 and attempted -> -negativeMarks; not attempted -> 0.
 * Pure, never throws. `max` is always `points`.
 */
export function deterministicMarks(
  type: string,
  content: unknown,
  answer: unknown,
  ctx: { points: number; negativeMarks: number },
): { earned: number; max: number; status: MarksStatus } {
  const { points, negativeMarks } = ctx;
  const def = isQuestionType(type) ? QUESTION_TYPE_REGISTRY[type] : undefined;
  if (def?.deterministicMarks) return def.deterministicMarks(content, answer, ctx);
  const fraction = def?.deterministicScore?.(content, answer) ?? 0;
  if (fraction >= 1) return { earned: points, max: points, status: "correct" };
  const earned = Math.round(points * fraction * 100) / 100;
  if (earned > 0) return { earned, max: points, status: "partial" };
  const penalty = def?.deterministicScore !== undefined && fraction === 0 && negativeMarks > 0 && isAnswerAttemptedFor(type, answer) ? Math.min(Math.round(negativeMarks * 100) / 100, points) : 0; // never below -points
  return { earned: penalty > 0 ? -penalty : 0, max: points, status: "incorrect" };
}
