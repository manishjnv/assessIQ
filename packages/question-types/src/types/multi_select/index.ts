import { z } from "zod";
import type { QuestionTypeDef } from "../../registry.js";

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
};
