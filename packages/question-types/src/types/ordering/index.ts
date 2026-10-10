import { z } from "zod";
import type { QuestionTypeDef } from "../../registry.js";

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
};
