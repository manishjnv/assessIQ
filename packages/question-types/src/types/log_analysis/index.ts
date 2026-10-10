import { z } from "zod";
import type { QuestionTypeDef } from "../../registry.js";

export const LogAnalysisContentSchema = z.object({
  question: z.string().min(1),
  log_excerpt: z.string().min(1),
  log_format: z.enum(["syslog", "json", "csv", "freeform"]),
  expected_findings: z.array(z.string().min(1)).min(1),
  hint: z.string().optional(),
  sample_solution: z.string().optional(),
}).strict();

export type LogAnalysisContent = z.infer<typeof LogAnalysisContentSchema>;

export const LogAnalysisAnswerPayloadSchema = z.object({
  /** Candidate anchor list - each item is a cited log field / value. */
  findings: z.array(z.string()),
  /** Candidate reasoning paragraph explaining what the findings indicate. */
  explanation: z.string(),
});

export const definition: QuestionTypeDef = {
  id: "log_analysis",
  label: "Log analysis",
  contentSchema: LogAnalysisContentSchema,
  answerSchema: LogAnalysisAnswerPayloadSchema,
  importColumns: [{ key: "question", required: true }, { key: "log_excerpt", required: true }, { key: "log_format", required: true }, { key: "expected_findings", required: true }],
  qtiInteraction: "extendedTextInteraction",
  generatorSkill: "generate-log-analysis",
  scoring: "ai",
  helpKey: "question_type.log_analysis",
};
