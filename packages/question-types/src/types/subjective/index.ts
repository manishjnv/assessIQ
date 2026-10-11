import { z } from "zod";
import type { QuestionTypeDef } from "../../registry.js";
import { candidateViewOf, compact, pick, pickKeys, questionOrJson, questionStem, structuralOf, type Dict } from "../../helpers.js";

export const SubjectiveContentSchema = z.object({
  question: z.string().min(1),
}).strict();

export type SubjectiveContent = z.infer<typeof SubjectiveContentSchema>;

export const SubjectiveAnswerPayloadSchema = z.object({
  /** The candidates free-text response. */
  response: z.string(),
});

function coerceSubjectiveContent(c: Dict): Dict {
  return compact({
    question: pick(c, ["question", "stem", "prompt", "scenario", "task", "text", "question_text"]),
  });
}

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
  aiGradeable: true,
  rubricRequired: true,
  rubricSynthesis: "none",
  shuffleField: null,
  candidateView: candidateViewOf((c) => pickKeys(c, ["question"])),
  coerceContent: coerceSubjectiveContent,
  guidanceText: questionStem,
  rubricText: questionOrJson,
  evalStructuralCheck: structuralOf(SubjectiveContentSchema, (d) => (d.question.trim().length > 0 ? null : "subjective: question is empty")),
};
