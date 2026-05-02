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
}

export interface AttemptQuestion {
  attempt_id: string;
  question_id: string;
  position: number;
  question_version: number;
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
  // content with the rubric stripped (rubric is internal-only — candidates
  // must NEVER see grading anchors / band thresholds).
  content: unknown;
}

export interface CandidateAttemptView {
  attempt: Attempt;
  questions: FrozenQuestion[];
  answers: AttemptAnswer[];
  remaining_seconds: number;
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
});
const PastePayload = z.object({
  length: z.number().int().nonnegative().optional(),
});
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
  nav_back: NavBackPayload,
  time_milestone: TimeMilestonePayload,
  multi_tab_conflict: MultiTabConflictPayload,
  event_volume_capped: EventVolumeCappedPayload,
} as const;

export type EventType = keyof typeof EVENT_PAYLOAD_SCHEMAS;

export const KNOWN_EVENT_TYPES: ReadonlySet<EventType> = new Set(
  Object.keys(EVENT_PAYLOAD_SCHEMAS) as EventType[],
);

// ---------------------------------------------------------------------------
// Service-input types
// ---------------------------------------------------------------------------

export interface StartAttemptInput {
  userId: string;
  assessmentId: string;
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
} as const;

export type AeErrorCode = (typeof AE_ERROR_CODES)[keyof typeof AE_ERROR_CODES];
