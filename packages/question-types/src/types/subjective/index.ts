import { z } from "zod";
import type { QuestionTypeDef } from "../../registry.js";

export const SubjectiveContentSchema = z.object({
  question: z.string().min(1),
}).strict();

export type SubjectiveContent = z.infer<typeof SubjectiveContentSchema>;

export const SubjectiveAnswerPayloadSchema = z.object({
  /** The candidates free-text response. */
  response: z.string(),
});

export const definition: QuestionTypeDef = {
  id: "subjective",
  label: "Subjective",
  contentSchema: SubjectiveContentSchema,
  answerSchema: SubjectiveAnswerPayloadSchema,
  importColumns: [{ key: "question", required: true }],
  qtiInteraction: "extendedTextInteraction",
  generatorSkill: "generate-subjective",
  scoring: "ai",
  helpKey: "question_type.subjective",
};
