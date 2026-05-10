import { z } from "zod";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// MCP Rejection Logger
// ---------------------------------------------------------------------------

const DEFAULT_REJECTION_LOG = "/var/log/assessiq/mcp-rejections.log";

/**
 * Append a single JSONL entry to the rejection log.
 * Failures are reported to stderr only — never thrown.
 */
function logRejection(
  type: string,
  issues: string,
  payloadExcerpt: unknown,
): void {
  // Re-read env at call time so tests can override MCP_REJECTION_LOG per-case.
  const logPath = process.env.MCP_REJECTION_LOG ?? DEFAULT_REJECTION_LOG;
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    pid: process.pid,
    type,
    issues,
    payload_excerpt: JSON.stringify(payloadExcerpt).slice(0, 2048),
  });
  // fs.appendFile is async; we intentionally do NOT await — any write failure
  // is caught below and routed to stderr so it cannot affect the return value.
  fs.appendFile(logPath, entry + "\n", (err) => {
    if (err) {
      process.stderr.write(
        `[assessiq-mcp] rejection-log write failed: ${err.message} (path=${logPath})\n`,
      );
    }
  });
}

/**
 * Infer the question type from a raw (possibly invalid) args object.
 * Falls back to "unknown" so the log entry is always useful.
 */
function inferType(args: unknown): string {
  if (
    args !== null &&
    typeof args === "object" &&
    "questions" in args &&
    Array.isArray((args as { questions: unknown }).questions) &&
    (args as { questions: unknown[] }).questions.length > 0
  ) {
    const first = (args as { questions: unknown[] }).questions[0];
    if (first !== null && typeof first === "object" && "type" in first) {
      const t = (first as { type: unknown }).type;
      if (typeof t === "string") return t;
    }
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Per-type content schemas — .strict() rejects any unrecognised key.
// This is the primary enforcement of canonical field names: a model emitting
// "stem" instead of "question", "log_snippet" instead of "log_excerpt", etc.
// gets an immediate validation failure with the bad key named in the error.
// Forbidden synonyms caught by strict():
//   ANY type: stem (use "question" / "title")
//   mcq: explanation, correct_answer, answer, answer_key
//   log_analysis: log_snippet, log_data, snippet, answer_key, findings,
//                 walkthrough, expected_anchors
//   kql: task, answer_key, query, target_query, keywords
//   scenario: description, steps_dependency, dag_steps
//   subjective: task, prompt
// ---------------------------------------------------------------------------

const McqContent = z
  .object({
    question: z.string().min(1),
    options: z.array(z.string().min(1)).length(4),
    correct: z.number().int().min(0).max(3),
    rationale: z.string().min(1),
  })
  .strict();

const LogAnalysisContent = z
  .object({
    question: z.string().min(1),
    log_format: z.enum(["json", "syslog", "windows_event", "freeform"]),
    log_excerpt: z.string().min(1),
    expected_findings: z.array(z.string().min(1)).min(2),
    sample_solution: z.string().min(1),
    hint: z.string().min(1),
  })
  .strict();

const ScenarioContent = z
  .object({
    title: z.string().min(1),
    intro: z.string().min(1),
    step_dependency: z.enum(["linear", "dag"]),
    steps: z
      .array(
        z
          .object({
            prompt: z.string().min(1),
            expected: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const KqlContent = z
  .object({
    question: z.string().min(1),
    tables: z.array(z.string().min(1)).min(1),
    expected_keywords: z.array(z.string().min(1)).min(1),
    sample_solution: z.string().min(1),
  })
  .strict();

const SubjectiveContent = z
  .object({
    question: z.string().min(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// Per-type question wrapper objects — also .strict() to catch extra keys at
// the question level (e.g. "difficulty", "explanation" attached to the wrapper
// rather than inside content). rubric: z.unknown() is intentionally loose —
// rubric shape is validated by submit_rubric / the grading pipeline separately.
// ---------------------------------------------------------------------------

const McqQuestion = z
  .object({
    type: z.literal("mcq"),
    topic: z.string().min(1),
    points: z.number().int().positive(),
    content: McqContent,
    knowledge_base_source_ids: z.array(z.string().min(1)).min(1),
    rubric: z.unknown().optional(),
  })
  .strict();

const LogAnalysisQuestion = z
  .object({
    type: z.literal("log_analysis"),
    topic: z.string().min(1),
    points: z.number().int().positive(),
    content: LogAnalysisContent,
    knowledge_base_source_ids: z.array(z.string().min(1)).min(1),
    rubric: z.unknown().optional(),
  })
  .strict();

const ScenarioQuestion = z
  .object({
    type: z.literal("scenario"),
    topic: z.string().min(1),
    points: z.number().int().positive(),
    content: ScenarioContent,
    knowledge_base_source_ids: z.array(z.string().min(1)).min(1),
    rubric: z.unknown().optional(),
  })
  .strict();

const KqlQuestion = z
  .object({
    type: z.literal("kql"),
    topic: z.string().min(1),
    points: z.number().int().positive(),
    content: KqlContent,
    knowledge_base_source_ids: z.array(z.string().min(1)).min(1),
    rubric: z.unknown().optional(),
  })
  .strict();

const SubjectiveQuestion = z
  .object({
    type: z.literal("subjective"),
    topic: z.string().min(1),
    points: z.number().int().positive(),
    content: SubjectiveContent,
    knowledge_base_source_ids: z.array(z.string().min(1)).min(1),
    rubric: z.unknown().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Discriminated union — Zod selects the schema to validate against using the
// `type` discriminant, then reports precise field-level errors for that type.
// Using discriminatedUnion (vs z.union) means the model receives a targeted
// error ("questions[0].content: unrecognized key 'stem'") rather than a
// generic "input does not match any option" from z.union.
// ---------------------------------------------------------------------------

export const GeneratedQuestionSchema = z.discriminatedUnion("type", [
  McqQuestion,
  LogAnalysisQuestion,
  ScenarioQuestion,
  KqlQuestion,
  SubjectiveQuestion,
]);

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
  questions: z.array(GeneratedQuestionSchema).min(1),
}).strict();

/**
 * Format Zod issues as a concise, model-readable string listing field paths
 * and problem descriptions. Max ~1500 chars to fit cleanly in one tool_result.
 * Unrecognised-key issues name the offending key(s) explicitly so the model
 * knows which synonym to replace.
 */
function formatIssues(issues: z.ZodIssue[]): string {
  const lines = issues.slice(0, 15).map((issue) => {
    const path = issue.path.map(String).join(".") || "(root)";
    if (issue.code === z.ZodIssueCode.unrecognized_keys) {
      const keys = (issue as Extract<z.ZodIssue, { code: "unrecognized_keys" }>).keys;
      const keyList = keys.map((k) => `'${k}'`).join(", ");
      return `${path}: unrecognized key(s) ${keyList} — rename to canonical field name`;
    }
    return `${path}: ${issue.message}`;
  });
  const suffix =
    issues.length > 15 ? `\n… and ${issues.length - 15} more issue(s).` : "";
  return lines.join("\n") + suffix;
}

export async function handleSubmitQuestions(args: unknown) {
  const parsed = SubmitQuestionsInputSchema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues;
    const firstIssue = issues[0];
    const firstIssuePath = firstIssue.path.map(String).join(".") || "(root)";
    const firstIssueText = `${firstIssuePath}: ${firstIssue.message}`;

    // One-line JSON to stderr — captured in generation_attempts.stderr_tail.
    process.stderr.write(
      JSON.stringify({
        event: "submit_questions.rejected",
        issue_count: issues.length,
        first_issue: firstIssueText.slice(0, 200),
      }) + "\n",
    );

    // Structured rejection log — full payload excerpt for DB-free diagnosis.
    const issuesText = formatIssues(issues);
    logRejection(inferType(args), issuesText, args);

    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            `submit_questions rejected — ${issues.length} validation error(s):\n\n` +
            issuesText +
            "\n\nCorrect the field names/values listed above and resubmit.",
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
