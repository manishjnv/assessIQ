import { z } from "zod";
import type { QuestionTypeDef } from "../../registry.js";

export const NumericContentSchema = z.object({
  question: z.string().min(1),
  answer: z.number().finite(),
  tolerance: z.number().finite().min(0).optional(),
  unit: z.string().min(1).max(20).optional(),
  rationale: z.string().min(1).optional(),
}).strict();

export type NumericContent = z.infer<typeof NumericContentSchema>;

/** LOOSE (narrowing only, never rejects a stored answer): mirrors parseNumericAnswer in 09. */
export const NumericAnswerPayloadSchema = z.union([
  z.number(),
  z.string(),
  z.object({ value: z.union([z.number(), z.string()]) }).passthrough(),
]);

export const definition: QuestionTypeDef = {
  id: "numeric",
  label: "Numeric",
  contentSchema: NumericContentSchema,
  answerSchema: NumericAnswerPayloadSchema,
  importColumns: [{ key: "question", required: true }, { key: "answer", required: true }, { key: "tolerance", required: false }, { key: "unit", required: false }],
  qtiInteraction: "textEntryInteraction",
  generatorSkill: null,
  scoring: "deterministic",
  helpKey: "question_type.numeric",
};
