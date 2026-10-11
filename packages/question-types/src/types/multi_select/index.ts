import { z } from "zod";
import type { QuestionTypeDef } from "../../registry.js";
import { candidateViewOf, pickKeys, questionOrJson, questionStem, structuralOf } from "../../helpers.js";

export const MultiSelectContentSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string().min(1)).min(2).max(10),
  correct: z.array(z.number().int().min(0)).min(1),
  scoring: z.enum(["all_or_nothing", "partial"]).optional(),
  rationale: z.string().min(1).optional(),
}).strict()
  .superRefine((val, ctx) => {
    if (new Set(val.correct).size !== val.correct.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["correct"], message: "correct must not repeat an index" });
    }
    if (val.correct.some((i) => i >= val.options.length)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["correct"], message: "correct must be valid indexes into options" });
    }
  });

export type MultiSelectContent = z.infer<typeof MultiSelectContentSchema>;

/** LOOSE (narrowing only): mirrors multiSelectFraction in 09 - a bare index array or { selected }. */
export const MultiSelectAnswerPayloadSchema = z.union([
  z.array(z.number()),
  z.object({ selected: z.array(z.number()) }).passthrough(),
]);

/**
 * multi_select: fraction of the points earned, 0..1. all_or_nothing (default): 1 iff the
 * selected set equals the correct set. partial: max(0, (right - wrong) / |correct|).
 * Malformed answers (non-array, non-integer, out-of-range, duplicate) score 0.
 */
export function multiSelectFraction(content: unknown, answer: unknown): number {
  if (content === null || typeof content !== "object") return 0;
  const c = content as { correct?: unknown; options?: unknown; scoring?: unknown };
  if (!Array.isArray(c.correct) || c.correct.length === 0) return 0;
  const n = Array.isArray(c.options) ? c.options.length : Infinity;
  const ok = (a: unknown): a is number[] =>
    Array.isArray(a) && a.every((i) => typeof i === "number" && Number.isInteger(i) && i >= 0 && i < n) && new Set(a).size === a.length;
  if (!ok(c.correct)) return 0;
  let sel: unknown = answer;
  if (answer !== null && typeof answer === "object" && !Array.isArray(answer)) sel = (answer as { selected?: unknown }).selected;
  if (!ok(sel)) return 0;
  const key = new Set(c.correct);
  const right = sel.filter((i) => key.has(i)).length;
  const wrong = sel.length - right;
  if (c.scoring === "partial") return Math.max(0, (right - wrong) / key.size);
  return wrong === 0 && right === key.size ? 1 : 0;
}

export const definition: QuestionTypeDef = {
  id: "multi_select",
  label: "Multi select",
  contentSchema: MultiSelectContentSchema,
  answerSchema: MultiSelectAnswerPayloadSchema,
  importColumns: [{ key: "question", required: true }, { key: "options", required: true }, { key: "correct", required: true }, { key: "scoring", required: false }],
  qtiInteraction: "choiceInteraction",
  generatorSkill: null,
  scoring: "deterministic",
  helpKey: "question_type.multi_select",
  aiGradeable: false,
  rubricRequired: false,
  rubricSynthesis: "none",
  shuffleField: "options",
  // correct, scoring and rationale never leave the server.
  candidateView: candidateViewOf((c) => pickKeys(c, ["question", "options"])),
  coerceContent: (raw) => raw,
  guidanceText: questionStem,
  rubricText: questionOrJson,
  deterministicScore: multiSelectFraction,
  evalStructuralCheck: structuralOf(MultiSelectContentSchema, () => null),
};
