import { z } from "zod";
import type { QuestionTypeDef } from "../../registry.js";

export const StructuredCaseStepSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  select: z.enum(["one", "many"]),
  options: z.array(z.string().min(1)).min(2).max(8),
  correct: z.array(z.number().int().min(0)).min(1),
}).strict();

export const StructuredCaseContentSchema = z.object({
  title: z.string().min(1),
  context: z.string().min(1),
  log_excerpt: z.string().min(1).max(20000).optional(),
  steps: z.array(StructuredCaseStepSchema).min(1).max(12),
  scoring: z.enum(["all_or_nothing", "partial"]).optional(),
  explanation: z.string().min(1).optional(),
}).strict()
  .superRefine((val, ctx) => {
    if (new Set(val.steps.map((s) => s.id)).size !== val.steps.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: "step ids must be unique" });
    }
    val.steps.forEach((s, i) => {
      if (new Set(s.correct).size !== s.correct.length || s.correct.some((c) => c >= s.options.length)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", i, "correct"], message: "correct must be unique, valid indexes into options" });
      }
      if (s.select === "one" && s.correct.length !== 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", i, "correct"], message: "select 'one' needs exactly one correct index" });
      }
    });
  });

export type StructuredCaseContent = z.infer<typeof StructuredCaseContentSchema>;

/** structured_case answer: picked option indexes per step id. Range / id checks need the frozen content (checkAnswerForSave). */
export const StructuredCaseAnswerPayloadSchema = z.object({
  steps: z.record(z.string(), z.array(z.number().int().min(0))),
});

export const definition: QuestionTypeDef = {
  id: "structured_case",
  label: "Structured case",
  contentSchema: StructuredCaseContentSchema,
  answerSchema: StructuredCaseAnswerPayloadSchema,
  importColumns: [{ key: "title", required: true }, { key: "context", required: true }, { key: "steps", required: true }],
  qtiInteraction: "choiceInteraction",
  generatorSkill: null,
  scoring: "deterministic",
  helpKey: "question_type.structured_case",
};
