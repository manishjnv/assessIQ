import { z } from "zod";

// ---------------------------------------------------------------------------
// Per-type content schemas (mirrors modules/04-question-bank/src/types.ts
// shapes without importing the module — MCP server has no dep on question-bank)
// ---------------------------------------------------------------------------

const McqContentSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string().min(1)).min(2).max(8),
  correct: z.number().int().min(0),
  rationale: z.string().min(1),
});

const SubjectiveContentSchema = z.object({
  question: z.string().min(1),
});

const KqlContentSchema = z.object({
  question: z.string().min(1),
  tables: z.array(z.string().min(1)).min(1),
  hint: z.string().optional(),
  expected_keywords: z.array(z.string().min(1)).min(1),
  sample_solution: z.string().optional(),
});

const ScenarioStepSchema = z.union([
  z.object({
    id: z.string().min(1),
    type: z.literal("mcq"),
    prompt: z.string().min(1),
    options: z.array(z.string().min(1)).min(2),
    correct: z.number().int().min(0),
    trap: z.boolean().optional(),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("subjective"),
    prompt: z.string().min(1),
    rubric_ref: z.string().optional(),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("kql"),
    prompt: z.string().min(1),
    expected_keywords: z.array(z.string().min(1)).min(1),
  }),
]);

const ScenarioContentSchema = z.object({
  title: z.string().min(1),
  intro: z.string().min(1),
  steps: z.array(ScenarioStepSchema).min(1),
  step_dependency: z.enum(["linear", "parallel"]),
});

const LogAnalysisContentSchema = z.object({
  question: z.string().min(1),
  log_excerpt: z.string().min(1),
  log_format: z.enum(["syslog", "json", "csv", "freeform"]),
  expected_findings: z.array(z.string().min(1)).min(1),
  hint: z.string().optional(),
  sample_solution: z.string().optional(),
});

const AnchorSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
});

const BandSchema = z.object({
  band: z.number().int().min(0).max(4),
  label: z.string().min(1),
  description: z.string().min(1),
});

const RubricSchema = z.object({
  anchors: z.array(AnchorSchema).min(1),
  bands: z.array(BandSchema).min(1),
});

// ---------------------------------------------------------------------------
// GeneratedQuestionSchema — one element of the submit_questions array
// ---------------------------------------------------------------------------

export const GeneratedQuestionSchema = z.object({
  type: z.enum(["mcq", "subjective", "kql", "scenario", "log_analysis"]),
  topic: z.string().min(3).max(200),
  points: z.number().int().min(1).max(10),
  knowledge_base_source_ids: z.array(z.string().min(1)).min(1),
  content: z.union([
    McqContentSchema,
    SubjectiveContentSchema,
    KqlContentSchema,
    ScenarioContentSchema,
    LogAnalysisContentSchema,
  ]),
  rubric: RubricSchema.nullable().optional(),
});

export type GeneratedQuestion = z.infer<typeof GeneratedQuestionSchema>;

// ---------------------------------------------------------------------------
// MCP tool descriptor
// ---------------------------------------------------------------------------

export const submitQuestionsTool = {
  name: "submit_questions",
  description:
    "Submit an array of generated assessment questions. Each element must include type, topic, points, knowledge_base_source_ids (at least one), content (type-specific shape), and optionally a rubric (required for subjective/scenario types).",
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        items: {
          type: "object",
          required: ["type", "topic", "points", "knowledge_base_source_ids", "content"],
          properties: {
            type: {
              type: "string",
              enum: ["mcq", "subjective", "kql", "scenario", "log_analysis"],
            },
            topic: { type: "string", minLength: 3, maxLength: 200 },
            points: { type: "integer", minimum: 1, maximum: 10 },
            knowledge_base_source_ids: {
              type: "array",
              minItems: 1,
              items: { type: "string" },
            },
            content: { type: "object" },
            rubric: { type: ["object", "null"] },
          },
        },
      },
    },
    required: ["questions"],
  },
} as const;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const SubmitQuestionsInputSchema = z.object({
  questions: z.array(GeneratedQuestionSchema).min(1).max(12),
});

export async function handleSubmitQuestions(args: unknown) {
  const parsed = SubmitQuestionsInputSchema.safeParse(args);
  if (!parsed.success) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `submit_questions validation failed: ${JSON.stringify(parsed.error.issues)}`,
        },
      ],
    };
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ accepted: true, questions: parsed.data.questions }),
      },
    ],
  };
}
