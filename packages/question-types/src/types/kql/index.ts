import { z } from "zod";
import type { QuestionTypeDef } from "../../registry.js";

export const KqlContentSchema = z.object({
  question: z.string().min(1),
  tables: z.array(z.string().min(1)).min(1),
  hint: z.string().optional(),
  expected_keywords: z.array(z.string().min(1)).min(1),
  sample_solution: z.string().optional(),
}).strict();

export type KqlContent = z.infer<typeof KqlContentSchema>;

export const KqlAnswerPayloadSchema = z.object({
  /** The candidates KQL query text. */
  query: z.string(),
});

export const definition: QuestionTypeDef = {
  id: "kql",
  label: "KQL query",
  contentSchema: KqlContentSchema,
  answerSchema: KqlAnswerPayloadSchema,
  importColumns: [{ key: "question", required: true }, { key: "tables", required: true }, { key: "expected_keywords", required: true }],
  qtiInteraction: "extendedTextInteraction",
  generatorSkill: "generate-kql",
  scoring: "ai",
  helpKey: "question_type.kql",
};
