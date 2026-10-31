// AssessIQ — modules/06-attempt-engine public types and Zod schemas.
//
// Three layers:
//   1. Domain types — DB row shapes (Attempt, AttemptQuestion, AttemptAnswer,
//      AttemptEvent).
//   2. Service-input types — what callers pass into the public surface.
//   3. Event payload Zod schemas (decision #14) — every event_type that
//      appears in attempt_events has a Zod schema enforced at recordEvent
//      time. Schemas live here so they're discoverable from the package
//      barrel; their narrative documentation lives in EVENTS.md.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Status enum — Phase 1 + Phase 2 union (CHECK constraint accepts both)
// ---------------------------------------------------------------------------
//
// Phase 1 writes only 'in_progress', 'submitted', 'auto_submitted'. Phase 2+
// adds 'pending_admin_grading', 'graded', 'released'. 'draft' is the row
// default but never observed in Phase 1 (startAttempt creates rows directly
// as 'in_progress'). 'cancelled' is reserved for an admin "cancel candidate
// attempt" action that lands later.

export const ATTEMPT_STATUSES = [
  "draft",
  "in_progress",
  "submitted",
  "auto_submitted",
  "cancelled",
  "pending_admin_grading",
  "graded",
  "released",
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

/** Attempt statuses that are terminal — no further transitions allowed. */
export const TERMINAL_ATTEMPT_STATUSES: ReadonlySet<AttemptStatus> = new Set([
  "submitted",
  "auto_submitted",
  "cancelled",
  "graded",
  "released",
]);

/** Attempt statuses that accept answer/flag/event writes from the candidate. */
export const WRITABLE_ATTEMPT_STATUSES: ReadonlySet<AttemptStatus> = new Set([
  "in_progress",
]);

// ---------------------------------------------------------------------------
// Domain types — DB row shapes (after repository mapping)
// ---------------------------------------------------------------------------

export interface Attempt {
  id: string;
  tenant_id: string;
  assessment_id: string;
  user_id: string;
  status: AttemptStatus;
  started_at: Date | null;
  ends_at: Date | null;
  submitted_at: Date | null;
  duration_seconds: number | null;
  created_at: Date;
  /** True when the attempt was started via the embed JWT flow (Phase 4). */
  embed_origin: boolean;
  /** Z-39: 1 for the first attempt, 2 for the first retake, and so on. */
  attempt_number: number;
  /** Z-89: copied from the invitation at start. 'mock' = any device, no certificate. */
  delivery_mode: "real" | "mock";
  /** Z-89: camera is a Wave 2 feature; always false today. */
  camera_enabled: boolean;
  /** EXP-9: reading language ('hi' = Hindi overlay); NULL in the DB reads as 'en'. */
  language: "en" | "hi";
}

export interface AttemptQuestion {
  attempt_id: string;
  question_id: string;
  position: number;
  question_version: number;
  /**
   * INTERNAL — never serialised to a candidate. Per-attempt MCQ option shuffle
   * (migration 0119): option_order[displayPosition] = originalIndex, or null =
   * original order (legacy / non-MCQ / options that refer to each other).
   * See option-shuffle.ts.
   */
  option_order: number[] | null;
  /** Test sections: index into assessments.settings.sections (migration 0132); null = no sections. */
  section_index: number | null;
}

export interface AttemptAnswer {
  attempt_id: string;
  question_id: string;
  answer: unknown | null;
  flagged: boolean;
  time_spent_seconds: number;
  edits_count: number;
  client_revision: number;
  saved_at: Date | null;
}

export interface AttemptEvent {
  id: string;
  attempt_id: string;
  event_type: string;
  question_id: string | null;
  payload: unknown | null;
  at: Date;
}

// ---------------------------------------------------------------------------
// Frozen-question shape — what getAttemptForCandidate returns to the candidate
// ---------------------------------------------------------------------------
//
// The frozen content (question_versions.content + .rubric) is JOINed with
// attempt_questions.position so the candidate sees a stable, ordered set
// regardless of any subsequent admin edits to the live question row.

export interface FrozenQuestion {
  question_id: string;
  position: number;
  question_version: number;
  type: string;
  topic: string;
  points: number;
  /** Test sections: which section the question sits in; null = assessment has no sections. */
  section_index?: number | null;
  // Candidate-facing answer-format hint ("HOW to answer", e.g. "Select the one
  // best option."). Always resolved server-side (authored value or a per-type
  // default) so it is never null. Instructional only — never a rubric / answer
  // key. Read LIVE from the question row (like topic/points), not the snapshot.
  answer_guidance: string;
  /** EXP-8: shared passage frozen with the attempt; absent when the question has none. */
  passage?: { id: string; title: string | null; body: string };
  /** EXP-10: alt text and size of the images this question names (no bytes). Absent when it has none. */
  assets?: Array<{ id: string; alt_text: string; width: number; height: number }>;
  /** A3-1: stub only. The candidate may not read this question yet; content comes from POST /position. */
  withheld?: true;
  // content with the rubric stripped (rubric is internal-only — candidates
  // must NEVER see grading anchors / band thresholds).
  content: unknown;
}

export interface CandidateAttemptView {
  attempt: Attempt;
  questions: FrozenQuestion[];
  answers: AttemptAnswer[];
  remaining_seconds: number;
  /** Integrity v1: runner switches from assessments.settings.integrity (default off). */
  integrity: { fullscreen: boolean; block_copy_paste: boolean };
  /**
   * Test sections: present only for sectioned assessments while in progress.
   * `questions`/`answers` are already limited to the current section.
   */
  sections?: CandidateSectionsView;
  /** Z-42 whole-test mode only: section names indexed by each question's section_index. Key absent otherwise. */
  section_names?: string[];
  /** FUT-4 / FUT-7 read-only: per section, whether it is locked and its seconds per question. Key absent unless a section sets one. */
  section_timing?: Array<{ locked: boolean; seconds_per_question: number | null }>;
  /** Test sections: counts per section for the final-submit dialog. Counts only, no content/ids. */
  sections_summary?: Array<{
    index: number;
    name: string;
    question_count: number;
    answered_count: number;
    status: "done" | "current" | "upcoming";
  }>;
}

export interface CandidateSectionsView {
  /** 0-based index of the running section. */
  current: number;
  total: number;
  name: string;
  calculator: boolean;
  /** ISO deadline of the running section (server-authoritative). */
  ends_at: string;
  remaining_seconds: number;
}

/** Admin integrity card: counts of recorded attempt_events. Not scores. */
export interface AttemptIntegritySummary {
  tab_switches: number;
  copy: number;
  paste: number;
  paste_blocked: number;
  fullscreen_exits: number;
  multi_tab_conflicts: number;
}

// ---------------------------------------------------------------------------
// Event payload Zod schemas (decision #14)
// ---------------------------------------------------------------------------
//
// recordEvent dispatches to the matching schema by event_type. Unknown
// event_types are rejected with UNKNOWN_EVENT_TYPE so the catalog stays
// closed — adding a new event_type is a code change, not an ad-hoc
// candidate-driven payload.
//
// Source-of-truth narrative: modules/06-attempt-engine/EVENTS.md.

const QuestionViewPayload = z.object({});
const AnswerSavePayload = z.object({
  edits_count: z.number().int().nonnegative().optional(),
  client_revision: z.number().int().nonnegative().optional(),
});
const FlagPayload = z.object({
  flagged: z.boolean(),
});
const TabBlurPayload = z.object({
  duration_ms: z.number().int().nonnegative().optional(),
});
const TabFocusPayload = z.object({});
const CopyPayload = z.object({
  length: z.number().int().nonnegative().optional(),
  blocked: z.boolean().optional(),
});
const PastePayload = z.object({
  length: z.number().int().nonnegative().optional(),
  blocked: z.boolean().optional(),
});
const FullscreenPayload = z.object({});
const NavBackPayload = z.object({
  from_position: z.number().int().nonnegative().optional(),
  to_position: z.number().int().nonnegative().optional(),
});
const TimeMilestonePayload = z.object({
  seconds: z.number().int().nonnegative(),
  kind: z.enum(["per_question", "auto_submit"]).optional(),
});
const MultiTabConflictPayload = z.object({
  incoming_revision: z.number().int().nonnegative(),
  stored_revision: z.number().int().nonnegative(),
});
const EventVolumeCappedPayload = z.object({
  cap: z.number().int().positive(),
});

/**
 * Event type → payload schema. Adding a new event_type means adding a row
 * here AND a section to EVENTS.md. Both updates land in the same PR per the
 * project DoD.
 */
export const EVENT_PAYLOAD_SCHEMAS = {
  question_view: QuestionViewPayload,
  answer_save: AnswerSavePayload,
  flag: FlagPayload,
  unflag: FlagPayload,
  tab_blur: TabBlurPayload,
  tab_focus: TabFocusPayload,
  copy: CopyPayload,
  paste: PastePayload,
  fullscreen_enter: FullscreenPayload,
  fullscreen_exit: FullscreenPayload,
  nav_back: NavBackPayload,
  time_milestone: TimeMilestonePayload,
  multi_tab_conflict: MultiTabConflictPayload,
  event_volume_capped: EventVolumeCappedPayload,
} as const;

export type EventType = keyof typeof EVENT_PAYLOAD_SCHEMAS;

/** A3-4: server-written event types; a client POST of these is refused like an unknown type. */
export const SERVER_ONLY_EVENT_TYPES: ReadonlySet<string> = new Set([
  "answer_save",
  "time_milestone",
  "multi_tab_conflict",
  "event_volume_capped",
]);

export const KNOWN_EVENT_TYPES: ReadonlySet<EventType> = new Set(
  Object.keys(EVENT_PAYLOAD_SCHEMAS) as EventType[],
);

// ---------------------------------------------------------------------------
// Service-input types
// ---------------------------------------------------------------------------

export interface StartAttemptInput {
  userId: string;
  assessmentId: string;
  /**
   * When true, the attempt was started via the embed JWT flow.
   * Skips the invitation check (the embed JWT IS the authorization),
   * and sets attempts.embed_origin = TRUE (Phase 4 migration 0073).
   */
  embedOrigin?: boolean;
  /**
   * Z-39: the caller asks for the NEXT attempt after a finished one (a retake). Without it,
   * startAttempt keeps its old meaning: return the latest attempt (resume or finished).
   * With it, a new attempt is created only while attempts used < max_attempts + extras.
   */
  newAttempt?: boolean;
  /**
   * Z-91: readiness check result to store on the NEW attempt. The route evaluates the signals
   * server-side before this is set; startAttempt only stores it.
   */
  readiness?: unknown;
  /**
   * Z-87 / Z-91: set by every NON-embed route that starts an attempt. `mobile` = the request came from
   * a phone or tablet. A NEW attempt of a REAL exam is refused here (not only in the route) when `gate`
   * is missing, `mobile` is true, or `readiness.passed` is not true. Embed starts are exempt
   * (host-asserted, same as consent). Mock tests are never refused.
   */
  gate?: { mobile: boolean };
}

export interface SaveAnswerInput {
  attemptId: string;
  questionId: string;
  answer: unknown;
  client_revision?: number;
  edits_count?: number;
  time_spent_seconds?: number;
}

export interface ToggleFlagInput {
  attemptId: string;
  questionId: string;
  flagged: boolean;
}

export interface RecordEventInput {
  attemptId: string;
  event_type: string;
  question_id?: string | null;
  payload?: unknown;
}

// ---------------------------------------------------------------------------
// Canonical candidate-answer payload schemas (Stage 1.5d shape lock)
// ---------------------------------------------------------------------------
//
// Zod schemas for the five canonical answer shapes. The service layer stores
// answers as `unknown`; grading and reporting callers use these schemas to
// safely narrow the stored answer to its canonical type.
//
// Field names are locked to the sharded-generation output — do NOT rename.

import {
  McqAnswerPayloadSchema,
  LogAnalysisAnswerPayloadSchema,
  ScenarioStepAnswerSchema,
  ScenarioAnswerPayloadSchema,
  StructuredCaseAnswerPayloadSchema,
  KqlAnswerPayloadSchema,
  SubjectiveAnswerPayloadSchema,
  checkAnswerFor,
} from "@assessiq/question-types";

// Moved to @assessiq/question-types (RW-54a); re-exported under the same names.
export {
  McqAnswerPayloadSchema,
  LogAnalysisAnswerPayloadSchema,
  ScenarioStepAnswerSchema,
  ScenarioAnswerPayloadSchema,
  StructuredCaseAnswerPayloadSchema,
  KqlAnswerPayloadSchema,
  SubjectiveAnswerPayloadSchema,
};

/**
 * Save-time shape check, keyed on the question TYPE (never on the answer shape).
 * Only `scenario` is checked: the grader reads `steps`, so a wrong shape was stored
 * without an error and evaluated as an empty answer (N15). null = no answer and
 * passes for every type. On success `answer` is the value to store (for scenario:
 * the canonical object, unknown keys removed).
 */
export function checkAnswerForSave(
  questionType: string | null,
  answer: unknown,
  frozenContent?: unknown,
): { ok: true; answer: unknown } | { ok: false } {
  const r = checkAnswerFor(questionType, answer, frozenContent);
  return r.ok ? r : { ok: false };
}

/**
 * GATE-8 A4-6: a candidate answer is capped at 20,000 characters of text in total
 * (every string inside the answer JSON). The grading CLI gets the prompt as argv and
 * fails with E2BIG far above this; before this cap a save was unbounded.
 */
export const MAX_ANSWER_CHARS = 20000;

/** Total characters of all strings inside an answer (depth-limited walk; numbers, booleans and null count 0). */
export function answerTextLength(answer: unknown, depth = 0): number {
  if (typeof answer === "string") return answer.length;
  if (depth > 8 || answer === null || typeof answer !== "object") return 0;
  let n = 0;
  for (const v of Array.isArray(answer) ? answer : Object.values(answer as Record<string, unknown>)) n += answerTextLength(v, depth + 1);
  return n;
}

export type McqAnswerPayload = z.infer<typeof McqAnswerPayloadSchema>;
export type LogAnalysisAnswerPayload = z.infer<typeof LogAnalysisAnswerPayloadSchema>;
export type ScenarioAnswerPayload = z.infer<typeof ScenarioAnswerPayloadSchema>;
export type KqlAnswerPayload = z.infer<typeof KqlAnswerPayloadSchema>;
export type SubjectiveAnswerPayload = z.infer<typeof SubjectiveAnswerPayloadSchema>;

/** Discriminated union of all five canonical candidate-answer payload types. */
export type CandidateAnswerPayload =
  | McqAnswerPayload
  | LogAnalysisAnswerPayload
  | ScenarioAnswerPayload
  | KqlAnswerPayload
  | SubjectiveAnswerPayload;

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const AE_ERROR_CODES = {
  ATTEMPT_NOT_FOUND: "AE_ATTEMPT_NOT_FOUND",
  ASSESSMENT_NOT_FOUND: "AE_ASSESSMENT_NOT_FOUND",
  ASSESSMENT_NOT_ACTIVE: "AE_ASSESSMENT_NOT_ACTIVE",
  INVITATION_NOT_FOUND: "AE_INVITATION_NOT_FOUND",
  INVITATION_INVALID: "AE_INVITATION_INVALID",
  INVITATION_EXPIRED: "AE_INVITATION_EXPIRED",
  ALREADY_SUBMITTED: "AE_ALREADY_SUBMITTED",
  NOT_OWNED_BY_USER: "AE_NOT_OWNED_BY_USER",
  POOL_TOO_SMALL: "AE_POOL_TOO_SMALL",
  TIMER_EXPIRED: "AE_TIMER_EXPIRED",
  WRITES_LOCKED: "AE_WRITES_LOCKED",
  UNKNOWN_QUESTION: "AE_UNKNOWN_QUESTION",
  UNKNOWN_EVENT_TYPE: "AE_UNKNOWN_EVENT_TYPE",
  INVALID_EVENT_PAYLOAD: "AE_INVALID_EVENT_PAYLOAD",
  EVENTS_CAPPED: "AE_EVENTS_CAPPED",
  INVALID_PARAM: "AE_INVALID_PARAM",
  CONSENT_REQUIRED: "CONSENT_REQUIRED",
  /** Test sections: the question's section is finished (or not open yet). */
  SECTION_LOCKED: "AE_SECTION_LOCKED",
  /** Finish-section on an assessment without sections, or on the last section. */
  SECTION_NOT_FINISHABLE: "AE_SECTION_NOT_FINISHABLE",
  SECTIONS_INVALID: "AE_SECTIONS_INVALID",
  /** FUT-4: the section cannot be entered (not a free-movement test, or it is a locked block already left). */
  SECTION_NOT_ENTERABLE: "AE_SECTION_NOT_ENTERABLE",
  /** FUT-7: the question's own time is up; it takes no more answers or flags. */
  QUESTION_TIME_UP: "AE_QUESTION_TIME_UP",
  /** Z-39: every allowed attempt (max_attempts + extra attempts) is used. */
  ATTEMPTS_EXHAUSTED: "AE_ATTEMPTS_EXHAUSTED",
} as const;

export type AeErrorCode = (typeof AE_ERROR_CODES)[keyof typeof AE_ERROR_CODES];
