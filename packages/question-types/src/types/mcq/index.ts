import { z } from "zod";
import type { QuestionTypeDef } from "../../registry.js";

export const McqContentSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string().min(1)).min(2).max(8),
  correct: z.number().int().min(0),
  rationale: z.string().min(1),
}).strict()
  .superRefine((val, ctx) => {
    if (val.correct >= val.options.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["correct"],
        message: "correct must be a valid index into options",
      });
    }
  });

export type McqContent = z.infer<typeof McqContentSchema>;

export const McqAnswerPayloadSchema = z.object({
  /** Index into content.options[], 0-3. */
  selected: z.number().int().min(0).max(3),
});

export const definition: QuestionTypeDef = {
  id: "mcq",
  label: "Multiple choice",
  contentSchema: McqContentSchema,
  answerSchema: McqAnswerPayloadSchema,
  importColumns: [{ key: "question", required: true }, { key: "options", required: true }, { key: "correct", required: true }, { key: "rationale", required: true }],
  qtiInteraction: "choiceInteraction",
  generatorSkill: "generate-mcq",
  scoring: "deterministic",
  helpKey: "question_type.mcq",
};
