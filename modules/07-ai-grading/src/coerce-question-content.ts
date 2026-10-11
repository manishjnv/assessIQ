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

import { coerceContentFor } from "@assessiq/question-types";

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

function coerceContent(type: unknown, content: Dict): Dict {
  return coerceContentFor(type, content);
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
