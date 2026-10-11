import { z } from "zod";
import type { QuestionTypeDef } from "../../registry.js";
import { candidateViewOf, compact, pick, pickKeys, str, structuralOf, toStringArray, type Dict } from "../../helpers.js";

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

/** Map free-text / synonym log_format values onto the canonical enum. */
function coerceLogFormat(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const s = v.trim().toLowerCase();
  if (s === "json" || s === "syslog" || s === "windows_event" || s === "freeform") return s;
  if (/windows|event\s*id|evtx|sysmon|security\s*(event|log)|\b4\d{3}\b/.test(s)) return "windows_event";
  if (/syslog|rfc\s*5424|rfc\s*3164|cef|leef/.test(s)) return "syslog";
  if (/json/.test(s)) return "json";
  return "freeform"; // non-graded display hint; "freeform" is the safe default for any present-but-unrecognised string
}

/** Join an array (or pass a string through) into a single newline-delimited string. */
function joinLines(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
  }
  return v;
}

function coerceLogAnalysisContent(c: Dict): Dict {
  return compact({
    question: pick(c, ["question", "stem", "prompt", "task", "question_text"]),
    log_format: coerceLogFormat(pick(c, ["log_format", "format", "log_type"])),
    log_excerpt: joinLines(pick(c, ["log_excerpt", "log_snippet", "log_lines", "log_data", "snippet", "logs", "log"])),
    expected_findings: toStringArray(
      pick(c, ["expected_findings", "findings", "expected_anchors", "anchors", "key_findings"]),
      ["finding", "text", "description", "concept", "anchor"],
    ),
    sample_solution: pick(c, ["sample_solution", "answer_key", "model_answer", "walkthrough", "solution", "expected_answer", "answer"]),
    hint: ((): unknown => {
      const h = pick(c, ["hint", "hints", "tip"]);
      return Array.isArray(h) ? h.filter((x) => typeof x === "string").join(" ") : h;
    })(),
  });
}

/** question + log_format only. Never expected_findings, sample_solution or log_excerpt. */
function logAnalysisGuidanceText(content: unknown): string {
  const c = (content ?? {}) as Dict;
  return [str(c.question), str(c.log_format)].filter(Boolean).join("\n").trim();
}

/** Reference concepts a synthesised rubric anchors on: expected_findings (strings, no trim). */
function logAnalysisSynthConcepts(content: unknown): string[] {
  const raw = (content as Dict | null | undefined)?.["expected_findings"];
  return Array.isArray(raw) ? raw.filter((f): f is string => typeof f === "string") : [];
}

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
  aiGradeable: true,
  rubricRequired: false,
  rubricSynthesis: "expected_findings",
  shuffleField: null,
  candidateView: candidateViewOf((c) => pickKeys(c, ["question", "log_format", "log_excerpt", "hint"])),
  coerceContent: coerceLogAnalysisContent,
  guidanceText: logAnalysisGuidanceText,
  // The rubric skill reads question + log_format + log_excerpt + expected_findings + sample_solution + hint.
  rubricText: (content) => JSON.stringify(content),
  synthConcepts: logAnalysisSynthConcepts,
  evalStructuralCheck: structuralOf(LogAnalysisContentSchema, (d) => (d.expected_findings.length >= 2 ? null : "log_analysis: expected_findings.length < 2")),
};
