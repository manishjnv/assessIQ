import { z } from "zod";
import type { QuestionTypeDef } from "../../registry.js";
import { candidateViewOf, compact, pick, pickKeys, questionOrJson, questionStem, structuralOf, toStringArray, type Dict } from "../../helpers.js";

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

function coerceKqlContent(c: Dict): Dict {
  const rawTables = pick(c, ["tables", "table", "data_tables", "table_names"]);
  let tables: unknown = rawTables;
  if (typeof rawTables === "string") tables = [rawTables];
  else if (Array.isArray(rawTables)) tables = toStringArray(rawTables, ["name", "table", "table_name"]);
  return compact({
    question: pick(c, ["question", "task", "stem", "prompt", "question_text"]),
    tables,
    expected_keywords: toStringArray(
      pick(c, ["expected_keywords", "keywords", "key_components", "expected_tokens", "must_include"]),
      ["keyword", "text", "token", "value"],
    ),
    sample_solution: pick(c, ["sample_solution", "answer_key", "model_answer", "query", "target_query", "solution", "expected_query"]),
  });
}

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
  aiGradeable: false,
  rubricRequired: false,
  rubricSynthesis: "none",
  shuffleField: null,
  candidateView: candidateViewOf((c) => pickKeys(c, ["question", "tables"])),
  coerceContent: coerceKqlContent,
  guidanceText: questionStem,
  rubricText: questionOrJson,
  evalStructuralCheck: structuralOf(KqlContentSchema, (d) => (d.expected_keywords.length >= 1 ? null : "kql: expected_keywords.length < 1")),
};
