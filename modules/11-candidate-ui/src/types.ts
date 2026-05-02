// Candidate-UI wire types — what /api/me/* and /api/take/* return on the
// HTTP boundary. Distinct from modules/06-attempt-engine/src/types.ts
// (which uses Date objects in service-layer return values) because the
// JSON wire serializes them to ISO strings. The candidate-ui never
// touches the service layer; it consumes JSON.
//
// Intentionally NOT re-exporting from @assessiq/attempt-engine — that
// would couple this presentation package to the server's Postgres
// repository and zod schemas.

export type AttemptStatus =
  | "draft"
  | "in_progress"
  | "submitted"
  | "auto_submitted"
  | "cancelled"
  | "pending_admin_grading"
  | "graded"
  | "released";

export interface AttemptWire {
  id: string;
  tenant_id: string;
  assessment_id: string;
  user_id: string;
  status: AttemptStatus;
  started_at: string | null;
  ends_at: string | null;
  submitted_at: string | null;
  duration_seconds: number | null;
  created_at: string;
}

export interface AttemptAnswerWire {
  attempt_id: string;
  question_id: string;
  answer: unknown | null;
  flagged: boolean;
  time_spent_seconds: number;
  edits_count: number;
  client_revision: number;
  saved_at: string | null;
}

export interface FrozenQuestionWire {
  question_id: string;
  position: number;
  question_version: number;
  type: string;
  topic: string;
  points: number;
  // The rubric is intentionally NEVER serialized — the server strips it
  // before sending. Keeping `unknown` here so callers must narrow.
  content: unknown;
}

export interface CandidateAttemptViewWire {
  attempt: AttemptWire;
  questions: FrozenQuestionWire[];
  answers: AttemptAnswerWire[];
  remaining_seconds: number;
}

export interface InvitedAssessmentWire {
  id: string;
  name: string;
  duration_seconds: number;
  question_count: number;
  opens_at: string | null;
  closes_at: string | null;
}

// POST /api/take/start — Session 4b territory. Phase 1 G1.D ships the
// caller; the backend mints a candidate session via the magic-link token
// and returns the assessment + freshly-minted attempt. Until 4b lands
// the endpoint returns 404 / 501; the page handles that as an error
// state. Shape matches docs/03-api-contract.md § Magic-link.
export interface TakeStartResponseWire {
  attempt_id: string;
  assessment: {
    id: string;
    name: string;
    duration_seconds: number;
  };
}

// POST /api/me/attempts/:id/submit — Phase 1 placeholder shape per
// docs/03-api-contract.md § Candidate.
export interface SubmitAttemptResponseWire {
  attempt_id: string;
  status: "submitted";
  estimated_grading_seconds: number | null;
}

// GET /api/me/attempts/:id/result — Phase 1 placeholder; module 07/08
// will return real results in Phase 2.
export interface AttemptResultPendingWire {
  status: "grading_pending";
  message?: string;
}

// Event types the candidate UI emits. Matches the closed catalog in
// modules/06-attempt-engine/EVENTS.md — UNKNOWN_EVENT_TYPE is rejected
// server-side, so this list is the contract. Not all are emitted by
// the UI (e.g. multi_tab_conflict + event_volume_capped are server
// records); we list only the ones the UI is allowed to send.
export type CandidateEventType =
  | "question_view"
  | "answer_save"
  | "flag"
  | "unflag"
  | "tab_blur"
  | "tab_focus"
  | "copy"
  | "paste"
  | "nav_back"
  | "time_milestone";

export interface CandidateEventInput {
  event_type: CandidateEventType;
  question_id?: string | null;
  payload?: Record<string, unknown>;
}

// API error envelope per docs/03-api-contract.md § Convention.
export interface ApiErrorEnvelope {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}
