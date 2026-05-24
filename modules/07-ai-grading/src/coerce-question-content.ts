// ---------------------------------------------------------------------------
// Tolerant coercion for submit_questions payloads (runtime-side copy).
//
// WHY THIS EXISTS
// The runtime reads the model's RAW tool_use input via parseToolInput — NOT the
// MCP server's coerced/accepted output. To store canonical `content` in the DB
// it must coerce that raw input with the exact same logic the MCP gate applies,
// so the persisted shape matches what the MCP accepted. See the MCP-side rationale
// in tools/assessiq-mcp/src/tools/coerce-questions.ts.
//
// It only RENAMES / RESTRUCTURES existing values — it never invents content, and
// FAILS CLOSED on the MCQ answer key (resolveCorrectIndex). The runtime ALSO runs
// strict per-type content validation after coercion (see claude-code-vps.ts) as
// defence-in-depth, so it never persists content the MCP would have rejected.
//
// IMPORTANT — KEEP IN SYNC with tools/assessiq-mcp/src/tools/coerce-questions.ts.
// The two copies exist because the standalone MCP server package has no
// dependency on this ai-grading module (and vice versa). Any change here must be
// mirrored there, and both test suites re-run.
// ---------------------------------------------------------------------------

type Dict = Record<string, unknown>;

function isObj(v: unknown): v is Dict {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** First defined value among the candidate keys, else undefined. */
function pick(obj: Dict, keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

/** Drop undefined values so strict() validation sees a clean object. */
function compact(obj: Dict): Dict {
  const out: Dict = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Coerce an MCQ option entry (string or object) to a plain string. */
function optionToString(o: unknown): string | undefined {
  if (typeof o === "string") return o;
  if (isObj(o)) return asStr(pick(o, ["text", "label", "option", "value", "answer", "content", "choice"]));
  return undefined;
}

// ---------------------------------------------------------------------------
// MCQ answer-key resolution — FAIL CLOSED.
//
// A wrong answer key silently mis-grades every candidate, so this never guesses.
// Each answer signal (explicit field or embedded option flag) is resolved to a
// 0-based index only when UNAMBIGUOUS. Indices from all signals are unioned; the
// answer is accepted only if exactly one distinct index results. Empty strings,
// quoted numbers (0-based vs 1-based is ambiguous), prose, duplicate option-text
// matches, multiple flagged options, and any disagreement between signals all
// collapse to `undefined` — which drops `correct` and lets strict Zod reject the
// question rather than store a guessed key.
// ---------------------------------------------------------------------------

/** Resolve ONE answer signal to a 0-based index, or undefined if ambiguous/unresolvable. */
function signalToIndex(sig: unknown, stringOptions: string[]): number | undefined {
  if (typeof sig === "number") return Number.isInteger(sig) ? sig : undefined;
  if (typeof sig === "string") {
    const s = sig.trim();
    if (s === "") return undefined;
    // Single option letter (A-H), optionally followed by ) . : ]
    const letterChar = /^([A-Ha-h])[).:\]]?$/.exec(s)?.[1];
    if (letterChar) return letterChar.toUpperCase().charCodeAt(0) - 65;
    // Exact, UNIQUE option-text match (case-insensitive). Ambiguous/no match → undefined.
    const matches: number[] = [];
    stringOptions.forEach((o, i) => {
      if (o.trim().toLowerCase() === s.toLowerCase()) matches.push(i);
    });
    if (matches.length === 1) return matches[0];
    // Quoted numbers ("1") are intentionally NOT coerced: 0-based vs 1-based is
    // ambiguous, so we fail closed and let the model resubmit an integer/letter.
    return undefined;
  }
  return undefined;
}

/** Indices of option objects explicitly flagged correct. */
function flaggedOptionIndices(rawOptions: unknown): number[] {
  if (!Array.isArray(rawOptions)) return [];
  const out: number[] = [];
  rawOptions.forEach((o, i) => {
    if (isObj(o) && (o.correct === true || o.is_correct === true || o.isCorrect === true)) {
      out.push(i);
    }
  });
  return out;
}

/** Resolve the MCQ correct index across all signals; undefined ⇒ fail closed. */
function resolveCorrectIndex(c: Dict, rawOptions: unknown, stringOptions: string[]): number | undefined {
  const indices = new Set<number>();
  const explicitSignals = [
    c.correct, c.correct_index, c.correct_option, c.correct_answer,
    c.answer, c.correct_option_id, c.answer_index, c.answer_key,
  ];
  for (const sig of explicitSignals) {
    if (sig === undefined || sig === null) continue; // absent signal — fine
    const idx = signalToIndex(sig, stringOptions);
    // A PRESENT answer-key signal we cannot unambiguously resolve (prose, quoted
    // number, ambiguous/duplicate text) MUST fail closed — never let another
    // signal silently win and store a guessed key (codex 2026-05-24 round 2).
    if (idx === undefined) return undefined;
    indices.add(idx);
  }
  for (const fi of flaggedOptionIndices(rawOptions)) indices.add(fi);
  return indices.size === 1 ? [...indices][0] : undefined;
}

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

/** Coerce an array of finding/keyword entries to an array of strings. */
function toStringArray(v: unknown, objKeys: string[]): unknown {
  if (!Array.isArray(v)) return v;
  return v.map((e) => {
    if (typeof e === "string") return e;
    if (isObj(e)) return asStr(pick(e, objKeys)) ?? "";
    return String(e);
  });
}

/** Map a boolean / synonym step_dependency onto the canonical enum (present values only). */
function coerceStepDependency(v: unknown): unknown {
  if (typeof v === "boolean") return v ? "dag" : "linear";
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "linear" || s === "dag") return s;
    if (s === "true") return "dag";
    if (s === "false" || /sequential|order|chain|step.?by.?step/.test(s)) return "linear";
    if (/graph|tree|branch|depend/.test(s)) return "dag";
  }
  return v; // absent / unrecognised → leave for Zod (do not invent for missing)
}

function coerceMcqContent(c: Dict): Dict {
  const rawOptions = pick(c, ["options", "choices", "answers", "answer_options"]);
  // Coercible option objects → strings; keep non-coercible elements verbatim so
  // strict Zod reports the real "expected string, received object" error.
  const options = Array.isArray(rawOptions)
    ? rawOptions.map((o) => optionToString(o) ?? o)
    : rawOptions;
  const stringOptions = Array.isArray(options) ? options.filter((o): o is string => typeof o === "string") : [];
  return compact({
    question: pick(c, ["question", "stem", "prompt", "text", "question_text"]),
    options,
    correct: resolveCorrectIndex(c, rawOptions, stringOptions),
    rationale: pick(c, ["rationale", "explanation", "rationale_text", "justification", "reason", "answer_explanation"]),
  });
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

function coerceScenarioContent(c: Dict): Dict {
  const rawSteps = pick(c, ["steps", "tasks", "parts", "questions"]);
  const steps = Array.isArray(rawSteps)
    ? rawSteps.map((s) => {
        if (isObj(s)) {
          return compact({
            prompt: pick(s, ["prompt", "question", "task", "step", "text", "instruction"]),
            expected: pick(s, ["expected", "expected_answer", "answer", "answer_key", "model_answer", "solution", "ideal_answer"]),
          });
        }
        // A plain-string step carries no expected answer; leave expected absent
        // so validation drops the malformed scenario rather than storing half.
        return compact({ prompt: typeof s === "string" ? s : undefined });
      })
    : rawSteps;
  return compact({
    title: pick(c, ["title", "stem", "name", "heading", "scenario_title"]),
    intro: pick(c, ["intro", "description", "scenario", "scenario_text", "context", "background", "situation"]),
    step_dependency: coerceStepDependency(pick(c, ["step_dependency", "steps_dependency", "dependency", "dependency_type", "step_dependencies"])),
    steps,
  });
}

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

function coerceSubjectiveContent(c: Dict): Dict {
  return compact({
    question: pick(c, ["question", "stem", "prompt", "scenario", "task", "text", "question_text"]),
  });
}

function coerceContent(type: unknown, content: Dict): Dict {
  switch (type) {
    case "mcq":
      return coerceMcqContent(content);
    case "log_analysis":
      return coerceLogAnalysisContent(content);
    case "scenario":
      return coerceScenarioContent(content);
    case "kql":
      return coerceKqlContent(content);
    case "subjective":
      return coerceSubjectiveContent(content);
    default:
      return content;
  }
}

/** Normalise knowledge_base_source_ids: accept id strings, or objects with .id. */
function coerceSourceIds(v: unknown): unknown {
  if (!Array.isArray(v)) return v;
  return v.map((e) => {
    if (typeof e === "string") return e;
    if (isObj(e)) return asStr(pick(e, ["id", "source_id", "src_id"])) ?? e;
    return e;
  });
}

/** Clamp a points value to the canonical 1-10 integer range when coercible. */
function coercePoints(v: unknown): unknown {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return v;
  return Math.min(10, Math.max(1, Math.round(n)));
}

/**
 * Coerce a single question object: rebuild the wrapper with only canonical keys
 * (dropping stray wrapper-level keys that .strict() would otherwise reject) and
 * coerce its content. Non-object questions are passed through unchanged so Zod
 * produces the correct structural error.
 */
export function coerceQuestion(q: unknown): unknown {
  if (!isObj(q)) return q;
  const type = q.type;
  const content = q.content;
  const wrapper: Dict = compact({
    type,
    topic: ((): unknown => {
      const t = pick(q, ["topic", "title", "subject", "name"]);
      return typeof t === "string" ? t.slice(0, 200) : t;
    })(),
    points: coercePoints(pick(q, ["points", "point", "score", "marks", "weight"])),
    content: isObj(content) ? coerceContent(type, content) : content,
    knowledge_base_source_ids: coerceSourceIds(
      pick(q, ["knowledge_base_source_ids", "kb_source_ids", "source_ids", "sources", "knowledge_base_sources", "citations"]),
    ),
  });
  if (q.rubric !== undefined) wrapper.rubric = q.rubric;
  return wrapper;
}

/**
 * Coerce a full submit_questions argument object: `{ questions: [...] }`.
 * Returns a NEW object (never mutates the input, which may be logged verbatim).
 * Pass-through when the shape is not `{ questions: array }` so the existing Zod
 * structural errors still fire.
 */
export function coerceQuestionsPayload(args: unknown): unknown {
  if (!isObj(args)) return args;
  const questions = args.questions;
  if (!Array.isArray(questions)) return args;
  return { ...args, questions: questions.map((q) => coerceQuestion(q)) };
}
