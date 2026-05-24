import { z } from "zod";
import fs from "node:fs";
import { coerceQuestionsPayload } from "./coerce-questions.js";

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
// Canonical inline examples — shown in rejection messages so the model can
// self-correct in one retry instead of 3–4 escalating wrong attempts.
// Each is a compact but complete valid payload for the given type.
// Kept in sync with the Zod schemas below — update both together.
// ---------------------------------------------------------------------------

export const CANONICAL_EXAMPLE_BY_TYPE: Record<string, string> = {
  mcq: JSON.stringify(
    {
      questions: [
        {
          type: "mcq",
          topic: "Kerberoasting Detection via Event 4769",
          points: 3,
          knowledge_base_source_ids: ["src_l2_001"],
          content: {
            question:
              "EventID 4769 with TicketEncryptionType 0x17 from a standard user indicates what attack?",
            options: [
              "A) Kerberoasting — RC4-HMAC tickets are crackable offline",
              "B) Pass-the-Ticket using a stolen TGT",
              "C) Normal Kerberos pre-authentication — no action required",
              "D) Golden Ticket attack using the KRBTGT hash",
            ],
            correct: 0,
            rationale:
              "EventID 4769 + TicketEncryptionType 0x17 is the canonical Kerberoasting signal. correct is 0 (integer index of first option).",
          },
          rubric: null,
        },
      ],
    },
    null,
    2,
  ),

  log_analysis: JSON.stringify(
    {
      questions: [
        {
          type: "log_analysis",
          topic: "Pass-the-Hash Lateral Movement via NTLM",
          points: 5,
          knowledge_base_source_ids: ["src_l2_003"],
          content: {
            question:
              "Analyse the correlated events. Identify the MITRE technique and the two field values that confirm it.",
            log_format: "windows_event",
            log_excerpt:
              "[2026-05-13 11:47:02] EventID: 4624  LogonType: 3  AuthPkg: NTLM  Account: Administrator  Source: WORKSTATION-07\n[BENIGN] [2026-05-13 11:44:00] EventID: 4624  LogonType: 3  AuthPkg: Kerberos  Account: jsmith",
            expected_findings: [
              "T1550.002 Pass-the-Hash: NTLM forced on a domain-joined host where Kerberos is the default is anomalous",
              "LogonType 3 + Authentication Package NTLM from a workstation indicates hash-based lateral movement",
            ],
            sample_solution:
              "NTLM is forced when an attacker supplies a bare hash (no plaintext password). Domain-joined machines negotiate Kerberos by default...",
            hint: "Compare Authentication Package between the suspicious and benign entries.",
          },
          rubric: null,
        },
      ],
    },
    null,
    2,
  ),

  scenario: JSON.stringify(
    {
      questions: [
        {
          type: "scenario",
          topic: "Ransomware Containment Decision",
          points: 6,
          knowledge_base_source_ids: ["src_l2_007"],
          content: {
            title: "Ransomware Outbreak — Finance VLAN",
            intro:
              "At 14:32 UTC, EDR alerts spike on 18 Finance VLAN endpoints. vssadmin delete shadows ran on three servers.",
            step_dependency: "linear",
            steps: [
              {
                prompt: "What is your first containment priority in the first 5 minutes?",
                expected:
                  "Isolate the Finance VLAN at the network boundary to stop encryption spread.",
              },
              {
                prompt: "VSS shadow copies are deleted. How does this change your recovery strategy?",
                expected:
                  "Shift to external backup recovery; document T1490 (Inhibit System Recovery) in the incident record.",
              },
            ],
          },
          rubric: null,
        },
      ],
    },
    null,
    2,
  ),

  kql: JSON.stringify(
    {
      questions: [
        {
          type: "kql",
          topic: "Kerberoasting Detection via TGS Request Burst",
          points: 5,
          knowledge_base_source_ids: ["src_l2_003"],
          content: {
            question:
              "Write a KQL query against SecurityEvent to detect Kerberoasting: filter EventID 4769 with RC4-HMAC (0x17), exclude machine accounts (ending in $), summarise by AccountName and IpAddress in 1-hour windows sorted by request count descending.",
            tables: ["SecurityEvent"],
            expected_keywords: [
              "EventID == 4769",
              "TicketEncryptionType",
              "0x17",
              "!endswith",
              "summarize",
              "bin(TimeGenerated, 1h)",
            ],
            sample_solution:
              'SecurityEvent\n| where EventID == 4769\n| where TicketEncryptionType == "0x17"\n| where AccountName !endswith "$"\n| summarize TGSCount = count() by AccountName, IpAddress, bin(TimeGenerated, 1h)\n| sort by TGSCount desc',
          },
          rubric: null,
        },
      ],
    },
    null,
    2,
  ),

  subjective: JSON.stringify(
    {
      questions: [
        {
          type: "subjective",
          topic: "LSASS Credential Dumping Detection",
          points: 8,
          knowledge_base_source_ids: ["src_l2_005"],
          content: {
            question:
              "Your SIEM surfaces Sysmon Event ID 10 (ProcessAccess) with GrantedAccess 0x1010 targeting lsass.exe from OUTLOOK.EXE. Explain: (a) why this is a high-confidence credential dumping indicator, (b) four specific telemetry sources or Event IDs to query immediately, (c) how you would assess lateral movement blast radius.",
          },
        },
      ],
    },
    null,
    2,
  ),
};

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
// Issue formatters
// ---------------------------------------------------------------------------

function buildIssueLines(issues: z.ZodIssue[], maxCount: number): string[] {
  return issues.slice(0, maxCount).map((issue) => {
    const path = issue.path.map(String).join(".") || "(root)";
    if (issue.code === z.ZodIssueCode.unrecognized_keys) {
      const keys = (issue as Extract<z.ZodIssue, { code: "unrecognized_keys" }>).keys;
      const keyList = keys.map((k) => `'${k}'`).join(", ");
      return `${path}: unrecognized key(s) ${keyList} — rename to canonical field name`;
    }
    return `${path}: ${issue.message}`;
  });
}

/**
 * Format issues for the JSONL rejection log (operators).
 * Cap at 15 issues; no inline example; no length cap.
 */
function formatIssuesForLog(issues: z.ZodIssue[]): string {
  const lines = buildIssueLines(issues, 15);
  const overflow = Math.max(0, issues.length - 15);
  const suffix = overflow > 0 ? `\n… and ${overflow} more issue(s).` : "";
  return lines.join("\n") + suffix;
}

/**
 * Format issues for the model-facing rejection message.
 * Cap at 10 issues; append canonical example for the type; total ≤ 4 KB.
 * If the example + issues exceed 4 KB, truncate the example (not the issues).
 */
function formatIssues(issues: z.ZodIssue[], type: string): string {
  const MAX_TOTAL = 4000;

  const lines = buildIssueLines(issues, 10);
  const overflow = Math.max(0, issues.length - 10);
  const overflowText = overflow > 0 ? `\n… and ${overflow} more issue(s).` : "";
  const issueText = lines.join("\n") + overflowText;

  const example = CANONICAL_EXAMPLE_BY_TYPE[type];
  const footer =
    "\n\nCorrect the field names/values listed above and resubmit with the FULL questions array (NOT empty {}).";

  if (!example) {
    return issueText + footer;
  }

  const header = `\n\nCORRECT SHAPE EXAMPLE for type '${type}':\n`;
  const baseLen = issueText.length + header.length + footer.length;
  const available = MAX_TOTAL - baseLen;

  const exampleText =
    example.length <= available
      ? example
      : example.slice(0, Math.max(0, available - 22)) + "\n... [example truncated]";

  return issueText + header + exampleText + footer;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const SubmitQuestionsInputSchema = z.object({
  // max(12) mirrors the runtime cap (claude-code-vps.ts) and the inputSchema
  // maxItems so MCP-accepted and runtime-stored batches cannot desync.
  questions: z.array(GeneratedQuestionSchema).min(1).max(12),
}).strict();

export async function handleSubmitQuestions(args: unknown) {
  // Tolerant coercion FIRST: deterministically map the model's well-known
  // non-canonical field names/shapes (stem→question, object-options→strings,
  // log_lines→log_excerpt, prose log_format→enum, …) onto the canonical shape
  // before strict validation. Three rounds of prompt hardening failed to stop
  // the drift (RCA 2026-05-24); coercion meets the model where it is. Only
  // genuinely incomplete questions fall through to the rejection path below.
  const coerced = coerceQuestionsPayload(args);
  const parsed = SubmitQuestionsInputSchema.safeParse(coerced);
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

    const inferredType = inferType(coerced);

    // Structured rejection log — full issues text (operators, no length cap).
    // Log the ORIGINAL args (what the model actually emitted) so the rejection
    // log shows raw model output; the issues describe the post-coercion gaps.
    const issuesForLog = formatIssuesForLog(issues);
    logRejection(inferredType, issuesForLog, args);

    // Model-facing message — capped issues + inline canonical example (≤4KB).
    const issuesText = formatIssues(issues, inferredType);

    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            `submit_questions rejected — ${issues.length} validation error(s):\n\n` +
            issuesText,
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
