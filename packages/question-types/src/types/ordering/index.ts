import { z } from "zod";
import type { QuestionTypeDef } from "../../registry.js";
import { candidateViewOf, pickKeys, questionOrJson, questionStem, structuralOf } from "../../helpers.js";

export const OrderingContentSchema = z.object({
  question: z.string().min(1),
  items: z.array(z.string().min(1)).min(2).max(10),
  correct_order: z.array(z.number().int().min(0)),
  scoring: z.enum(["all_or_nothing", "partial"]).optional(),
  explanation: z.string().min(1).optional(),
}).strict()
  .superRefine((val, ctx) => {
    const n = val.items.length;
    const co = val.correct_order;
    if (co.length !== n || new Set(co).size !== n || co.some((i) => i >= n)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["correct_order"], message: "correct_order must be a permutation of 0..items.length-1" });
    }
  });

export type OrderingContent = z.infer<typeof OrderingContentSchema>;

/** LOOSE (narrowing only): mirrors orderingFraction in 09 - { order } of original item indexes. */
export const OrderingAnswerPayloadSchema = z.object({ order: z.array(z.number()) }).passthrough();

/**
 * ordering: fraction of the points earned, 0..1. correct_order and answer.order are
 * ORIGINAL item indexes. Malformed (not a permutation of 0..n-1 of the right length) -> 0.
 * all_or_nothing (default): 1 iff identical. partial: share of positions that match.
 */
export function orderingFraction(content: unknown, answer: unknown): number {
  if (content === null || typeof content !== "object") return 0;
  const c = content as { correct_order?: unknown; scoring?: unknown };
  const isPerm = (a: unknown, n: number): a is number[] =>
    Array.isArray(a) && a.length === n && new Set(a).size === n &&
    a.every((i) => typeof i === "number" && Number.isInteger(i) && i >= 0 && i < n);
  const key = c.correct_order;
  if (!Array.isArray(key) || key.length < 2 || !isPerm(key, key.length)) return 0;
  const given = answer !== null && typeof answer === "object" && !Array.isArray(answer)
    ? (answer as { order?: unknown }).order
    : undefined;
  if (!isPerm(given, key.length)) return 0;
  const hits = given.filter((v, i) => v === key[i]).length;
  if (c.scoring === "partial") return hits / key.length;
  return hits === key.length ? 1 : 0;
}

export const definition: QuestionTypeDef = {
  id: "ordering",
  label: "Ordering",
  contentSchema: OrderingContentSchema,
  answerSchema: OrderingAnswerPayloadSchema,
  importColumns: [{ key: "question", required: true }, { key: "items", required: true }, { key: "correct_order", required: true }, { key: "scoring", required: false }],
  qtiInteraction: "orderInteraction",
  generatorSkill: null,
  scoring: "deterministic",
  helpKey: "question_type.ordering",
  aiGradeable: false,
  rubricRequired: false,
  rubricSynthesis: "none",
  shuffleField: "items",
  // correct_order, scoring and explanation never leave the server. Items are re-arranged into the
  // attempt's (never-correct) display order by the attempt engine.
  candidateView: candidateViewOf((c) => pickKeys(c, ["question", "items"])),
  coerceContent: (raw) => raw,
  guidanceText: questionStem,
  rubricText: questionOrJson,
  deterministicScore: orderingFraction,
  evalStructuralCheck: structuralOf(OrderingContentSchema, () => null),
};
