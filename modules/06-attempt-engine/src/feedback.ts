/**
 * Per-question feedback on a RELEASED result (RW-80) - GET /api/me/attempts/:id/feedback.
 *
 * Gated by assessments.settings.feedback_level (Z-145; Mock, non-embed attempts only; default 'none'):
 *   none                  - no items
 *   right_wrong           - outcome + the candidate's own answer + "what to study"
 *   with_expected_answer  - adds the expected answer for DETERMINISTIC types only
 *   with_ai_justification - adds a plain-words line for AI-graded rows
 *
 * Only for attempts that are released AND have an attempt_scores row (same rule as
 * getCandidateResult). Rows that are not final (status review_needed, error_class
 * AIG_*) are never shown. Never sent: stage_inputs, anchor_hits, rubric text, the raw
 * AI text. The plain-words line is a deterministic text transform: no AI call.
 */

import { ConflictError, NotFoundError } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { isQuestionType, licensedQuestionSql, QUESTION_TYPE_REGISTRY } from "@assessiq/question-types";
import * as repo from "./repository.js";
import { AE_ERROR_CODES } from "./types.js";
import { effectiveLevel, FEEDBACK_LEVEL_RANK, toFeedbackLevel, type FeedbackLevel } from "@assessiq/core/feedback-copy";

export type FeedbackOutcome = "correct" | "incorrect" | "partial";

export interface FeedbackItem {
  question_id: string;
  position: number;
  type: string;
  prompt: string;
  /** EXP-10: true when the prompt holds LaTeX between \( \) marks; the page draws it with the math component. */
  math: boolean;
  your_answer: string | null;
  outcome: FeedbackOutcome;
  score_earned: number;
  score_max: number;
  expected_answer: string | null;
  explanation: string | null;
  study: { unit: string | null; subject: string | null; topic: string };
}

export interface CandidateFeedback {
  level: FeedbackLevel;
  items: FeedbackItem[];
}

// ---------------------------------------------------------------------------
// plainWords - deterministic rewrite of an AI justification for a candidate
// ---------------------------------------------------------------------------

const BAND_LABELS = ["No credit", "Weak answer", "Partial answer", "Good answer", "Strong answer"] as const;

const INTERNAL_RE = /\b(stage\s*\d|stages?|anchors?|band\s*\d|banding|rubric|stage_inputs)\b/i;

export function plainWords(
  justification: string | null | undefined,
  band: number | null | undefined,
  errorClass?: string | null,
): string | null {
  const label = typeof band === "number" && Number.isInteger(band) && band >= 0 && band <= 4 ? BAND_LABELS[band]! : null;
  let text = "";
  // A row that carries an error class is not a clean grade: show the band only.
  if (typeof justification === "string" && (errorClass === null || errorClass === undefined || errorClass === "")) {
    let kept = justification
      .split(/\r?\n/)
      .filter((l) => !/^\s*(stage|anchor|band)/i.test(l) && !/^\s*[{}`]/.test(l))
      .join(" ");
    // Nested brackets/braces: repeat until nothing changes.
    for (let prev = ""; prev !== kept; ) {
      prev = kept;
      kept = kept.replace(/\[[^[\]]*\]|\{[^{}]*\}/g, " ");
    }
    kept = kept.replace(/[`{}[\]]+/g, " ").replace(/\s+/g, " ").trim();
    // Keep sentences up to the first one that mentions grader internals.
    const sentences: string[] = [];
    for (const s of kept.split(/(?<=[.!?])\s+/).filter((x) => x !== "")) {
      if (INTERNAL_RE.test(s)) break;
      sentences.push(s);
    }
    text = sentences.slice(0, 2).join(" ");
    if (text.length > 280) text = `${text.slice(0, 279).trimEnd()}…`;
  }
  if (label === null) return text === "" ? null : text;
  return text === "" ? label : `${label}: ${text}`;
}

// ---------------------------------------------------------------------------
// Answer rendering (unknown shapes -> null, never raw JSON)
// ---------------------------------------------------------------------------

type Dict = Record<string, unknown>;
const isObj = (v: unknown): v is Dict => v !== null && typeof v === "object" && !Array.isArray(v);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function indexes(v: unknown): number[] {
  const src = isObj(v) ? v.selected : v;
  return Array.isArray(src) ? src.filter((x): x is number => Number.isInteger(x)) : [];
}
function pickOptions(opts: string[], idx: number[]): string | null {
  const out = idx.map((i) => opts[i]).filter((s): s is string => s !== undefined);
  return out.length === 0 ? null : out.join("; ");
}
const text300 = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? cap(v.trim(), 300) : null);

type AnswerRenderer = (c: Dict, answer: unknown) => string | null;

// Renderer map keyed by question-type id (the registry owns the id list; a type with no
// entry here renders null, never raw JSON).
const YOUR_ANSWER: Record<string, AnswerRenderer> = {
  mcq: (c, answer) => {
    const sel = isObj(answer) ? answer.selected : answer;
    return Number.isInteger(sel) ? pickOptions(strArr(c.options), [sel as number]) : null;
  },
  multi_select: (c, answer) => pickOptions(strArr(c.options), indexes(answer)),
  numeric: (c, answer) => {
    const v = isObj(answer) ? answer.value : answer;
    const unit = typeof c.unit === "string" ? ` ${c.unit}` : "";
    return typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? `${String(v).trim()}${unit}` : null;
  },
  ordering: (c, answer) => {
    const order = isObj(answer) && Array.isArray(answer.order) ? (answer.order as unknown[]) : [];
    const items = strArr(c.items);
    const out = order.map((i) => (Number.isInteger(i) ? items[i as number] : undefined)).filter((s): s is string => s !== undefined);
    return out.length === 0 ? null : out.map((s, i) => `${i + 1}. ${s}`).join("; ");
  },
  structured_case: (c, answer) => {
    const picks: Dict = isObj(answer) && isObj(answer.steps) ? answer.steps : {};
    const out: string[] = [];
    (Array.isArray(c.steps) ? c.steps : []).forEach((s, n) => {
      if (!isObj(s) || typeof s.id !== "string") return;
      const t = pickOptions(strArr(s.options), indexes(picks[s.id]));
      if (t !== null) out.push(`Step ${n + 1}: ${t}`);
    });
    return out.length === 0 ? null : out.join("; ");
  },
  subjective: (_c, answer) => (isObj(answer) ? text300(answer.response) : null),
  kql: (_c, answer) => (isObj(answer) ? text300(answer.query) : null),
  log_analysis: (_c, answer) => (isObj(answer) ? text300(answer.explanation) : null),
  scenario: (_c, answer) => {
    const steps = isObj(answer) && Array.isArray(answer.steps) ? answer.steps : [];
    const out = steps
      .filter((s): s is Dict => isObj(s) && typeof s.response === "string" && s.response.trim() !== "")
      .map((s, n) => `Step ${Number.isInteger(s.stepIndex) ? (s.stepIndex as number) + 1 : n + 1}: ${(s.response as string).trim()}`);
    return out.length === 0 ? null : cap(out.join(" "), 300);
  },
};

export function renderYourAnswer(type: string, content: unknown, answer: unknown): string | null {
  if (answer === null || answer === undefined) return null;
  return YOUR_ANSWER[type]?.(isObj(content) ? content : {}, answer) ?? null;
}

// Expected answers: deterministic types only (the caller checks the registry flag).
const EXPECTED_ANSWER: Record<string, (c: Dict) => string | null> = {
  mcq: (c) => (Number.isInteger(c.correct) ? pickOptions(strArr(c.options), [c.correct as number]) : null),
  multi_select: (c) => pickOptions(strArr(c.options), indexes(c.correct)),
  numeric: (c) => {
    if (typeof c.answer !== "number") return null;
    const tol = typeof c.tolerance === "number" && c.tolerance > 0 ? ` (± ${c.tolerance})` : "";
    return `${c.answer}${typeof c.unit === "string" ? ` ${c.unit}` : ""}${tol}`;
  },
  ordering: (c) => {
    const items = strArr(c.items);
    const out = (Array.isArray(c.correct_order) ? c.correct_order : [])
      .map((i) => (Number.isInteger(i) ? items[i as number] : undefined))
      .filter((s): s is string => s !== undefined);
    return out.length === 0 ? null : out.map((s, i) => `${i + 1}. ${s}`).join("; ");
  },
  structured_case: (c) => {
    const out: string[] = [];
    (Array.isArray(c.steps) ? c.steps : []).forEach((s, n) => {
      if (!isObj(s)) return;
      const t = pickOptions(strArr(s.options), indexes(s.correct));
      if (t !== null) out.push(`Step ${n + 1}: ${t}`);
    });
    return out.length === 0 ? null : out.join("; ");
  },
};

export function renderExpectedAnswer(type: string, content: unknown): string | null {
  return isObj(content) ? (EXPECTED_ANSWER[type]?.(content) ?? null) : null;
}

function promptOf(type: string, content: unknown): string {
  const view = isQuestionType(type) ? QUESTION_TYPE_REGISTRY[type].candidateView(content) : null;
  if (!isObj(view)) return "";
  const t = [view.question, view.title, view.intro].find((x): x is string => typeof x === "string" && x.trim() !== "");
  return cap((t ?? "").trim(), 500);
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

interface Row {
  question_id: string;
  position: number;
  type: string;
  topic: string;
  content: unknown;
  answer: unknown;
  status: string;
  score_earned: string;
  score_max: string;
  ai_justification: string | null;
  reasoning_band: number | null;
  error_class: string | null;
  grader: string;
  licensed: boolean;
}

const ITEMS_SQL = `SELECT aq.question_id, aq.position, qv.type, q.topic, qv.content,
        aa.answer,
        g.status, g.score_earned::text AS score_earned, g.score_max::text AS score_max,
        g.ai_justification, g.reasoning_band, g.error_class, g.grader,
        ${licensedQuestionSql("q")} AS licensed
   FROM attempt_questions aq
   JOIN question_versions qv ON qv.question_id = aq.question_id AND qv.version = aq.question_version
   JOIN questions q ON q.id = aq.question_id
   LEFT JOIN attempt_answers aa ON aa.attempt_id = aq.attempt_id AND aa.question_id = aq.question_id
   JOIN LATERAL (
     SELECT status, score_earned, score_max, ai_justification, reasoning_band, error_class, grader
       FROM gradings
      WHERE attempt_id = aq.attempt_id AND question_id = aq.question_id
      ORDER BY graded_at DESC, (grader = 'admin_override') DESC, id DESC LIMIT 1
   ) g ON true
  WHERE aq.attempt_id = $1
  ORDER BY aq.position`;

const STUDY_SQL = `SELECT DISTINCT ON (qt.question_id) qt.question_id, n.label AS unit,
        CASE WHEN p.kind = 'subject' THEN p.label END AS subject
   FROM question_taxonomy qt
   JOIN taxonomy_nodes n ON n.id = qt.node_id AND n.kind = 'unit'
   LEFT JOIN taxonomy_nodes p ON p.id = n.parent_id
  WHERE qt.question_id = ANY($1::uuid[])
  ORDER BY qt.question_id, n.label`;

function outcomeOf(status: string, earned: number, max: number): FeedbackOutcome {
  if (status === "correct") return "correct";
  if (status === "partial") return "partial";
  if (status === "incorrect") return "incorrect";
  // overridden: decide from the marks
  if (max > 0 && earned >= max) return "correct";
  return earned > 0 ? "partial" : "incorrect";
}

export async function getCandidateFeedback(
  tenantId: string,
  userId: string,
  attemptId: string,
): Promise<CandidateFeedback> {
  return withTenant(tenantId, async (client) => {
    const attempt = await repo.findAttemptById(client, attemptId);
    if (attempt === null || attempt.user_id !== userId) {
      throw new NotFoundError(`Attempt not found: ${attemptId}`, {
        details: { code: AE_ERROR_CODES.ATTEMPT_NOT_FOUND },
      });
    }
    const score = await client.query(`SELECT 1 FROM attempt_scores WHERE attempt_id = $1`, [attemptId]);
    if (attempt.status !== "released" || score.rows.length === 0) {
      throw new ConflictError("The result is not ready yet.", { details: { code: "RESULT_NOT_READY" } });
    }
    // Z-172: the organisation switch is read in THIS transaction, so a toggle cannot split a read.
    const asm = await client.query<{ feedback_level: FeedbackLevel | null; org_key_on: boolean }>(
      `SELECT settings->>'feedback_level' AS feedback_level,
              COALESCE((SELECT ts.candidate_answer_key FROM tenant_settings ts WHERE ts.tenant_id = assessments.tenant_id), false) AS org_key_on
         FROM assessments WHERE id = $1`,
      [attempt.assessment_id],
    );
    // Z-145/Z-148: only a Mock attempt that is not embed gets the assessment's own level.
    const level = effectiveLevel(toFeedbackLevel(asm.rows[0]?.feedback_level), {
      isMockAttempt: attempt.delivery_mode === "mock",
      isEmbed: attempt.embed_origin,
      orgKeyOn: asm.rows[0]?.org_key_on === true,
    });
    const rank = FEEDBACK_LEVEL_RANK[level];
    if (rank === 0) return { level, items: [] };

    const rows = (await client.query<Row>(ITEMS_SQL, [attemptId])).rows
      // Not final -> never shown.
      .filter((r) => r.status !== "review_needed" && !(r.error_class ?? "").startsWith("AIG_"));
    const study = new Map<string, { unit: string; subject: string | null }>();
    if (rows.length > 0) {
      const st = await client.query<{ question_id: string; unit: string; subject: string | null }>(STUDY_SQL, [
        rows.map((r) => r.question_id),
      ]);
      for (const s of st.rows) study.set(s.question_id, { unit: s.unit, subject: s.subject });
    }

    const items: FeedbackItem[] = rows.map((r) => {
      const earned = parseFloat(r.score_earned);
      const max = parseFloat(r.score_max);
      const def = isQuestionType(r.type) ? QUESTION_TYPE_REGISTRY[r.type] : undefined;
      const st = study.get(r.question_id);
      return {
        question_id: r.question_id,
        position: r.position,
        type: r.type,
        prompt: promptOf(r.type, r.content),
        math: isObj(r.content) && r.content["math"] === true,
        your_answer: renderYourAnswer(r.type, r.content, r.answer),
        outcome: outcomeOf(r.status, earned, max),
        score_earned: earned,
        score_max: max,
        // Z-172 (FUT-2): licensed (platform-owned) content never shows its expected answer or explanation to a candidate.
        expected_answer: rank >= 2 && !r.licensed && def?.scoring === "deterministic" ? renderExpectedAnswer(r.type, r.content) : null,
        explanation:
          rank >= 3 && !r.licensed && def?.scoring === "ai" ? plainWords(r.grader === "admin_override" ? null : r.ai_justification, r.reasoning_band, r.error_class) : null,
        study: { unit: st?.unit ?? null, subject: st?.subject ?? null, topic: r.topic },
      };
    });
    return { level, items };
  });
}
