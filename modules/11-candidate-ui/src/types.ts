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
  // Candidate-facing answer-format hint ("HOW to answer"). Always a non-empty
  // string — the server resolves an authored value or a per-type default.
  // Instructional only; never a rubric/answer key.
  answer_guidance: string;
  // The rubric is intentionally NEVER serialized — the server strips it
  // before sending. Keeping `unknown` here so callers must narrow.
  content: unknown;
}

export interface CandidateAttemptViewWire {
  attempt: AttemptWire;
  questions: FrozenQuestionWire[];
  answers: AttemptAnswerWire[];
  remaining_seconds: number;
  /** Integrity v1 runner switches (assessment settings.integrity; default off). */
  integrity?: { fullscreen: boolean; block_copy_paste: boolean };
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
  /** true when an existing attempt was resumed (clock NOT reset). */
  resumed?: boolean;
  candidate?: { name: string };
  assessment: {
    id: string;
    name: string;
    duration_seconds: number;
    question_count?: number;
    company_name?: string;
  };
}

// POST /take/start { token, preview: true } — landing data only. NEVER creates
// an attempt or starts the clock; attempt_id is non-null only when the
// candidate already began (resume).
export interface TakePreviewResponseWire {
  attempt_id: string | null;
  resumed: boolean;
  candidate: { name: string };
  assessment: {
    id: string;
    name: string;
    duration_seconds: number;
    question_count: number;
    company_name: string;
  };
}

// ─── Result release (owner rules P1/P2, spec 2026-10-01 §2 SP3) ──────────────
//
// A candidate only ever sees a COMPLETE, final result: total, percent, pass/fail
// and a certificate link. Never per-question data, bands or justifications.

/** 'soon' = scored + published within about a minute; 'email' = emailed later. */
export type ResultExpectation = "soon" | "email";

/** Tenant release mode. Optional hint on the wire — see `release_mode` below. */
export type ReleaseMode = "manual" | "auto";

// POST /api/me/attempts/:id/submit
export interface SubmitAttemptResponseWire {
  attempt_id: string;
  status: "submitted";
  /** Compatibility field: 60 when result_expectation is 'soon', else null. */
  estimated_grading_seconds: number | null;
  result_expectation: ResultExpectation;
  /** Registered email, masked server-side (r***@gmail.com). */
  email_masked: string;
  /** Trailing phrase for the email message, e.g. "within 72 hours". */
  turnaround_text: string;
  /**
   * OPTIONAL hint (not in the SP3 spec): lets the Submitted page say "once
   * {tenant} releases it" for manual tenants. When absent the page falls back
   * to `turnaround_text` — the wire contract alone cannot tell manual tenants
   * from auto tenants whose attempt has written answers.
   */
  release_mode?: ReleaseMode;
}

/** Certificate reference on a released result. */
export interface ResultCertificateWire {
  credential_id: string;
  verify_url: string;
}

// GET /api/me/attempts/:id/result → 202 while the result is not published.
// Older servers answered { status: "grading_pending" }; callers must treat any
// status other than "released" as pending.
export interface AttemptResultPendingWire {
  status: "pending";
  result_expectation: ResultExpectation;
  email_masked: string;
  turnaround_text: string;
  tenant_name: string;
  /** Optional hint — see SubmitAttemptResponseWire.release_mode. */
  release_mode?: ReleaseMode;
}

// GET /api/me/attempts/:id/result → 200 once the result is published.
export interface AttemptResultReleasedWire {
  status: "released";
  total_earned: number;
  total_max: number;
  /** 0-100, one decimal place. */
  percent: number;
  passed: boolean;
  assessment_name: string;
  released_at: string;
  certificate: ResultCertificateWire | null;
}

export type AttemptResultWire =
  | AttemptResultPendingWire
  | AttemptResultReleasedWire;

// GET /api/me/results — released attempts only, newest first.
export interface MyResultItemWire {
  attempt_id: string;
  assessment_name: string;
  released_at: string;
  total_earned: number;
  total_max: number;
  percent: number;
  passed: boolean;
  certificate: ResultCertificateWire | null;
}

export interface MyResultsResponseWire {
  items: MyResultItemWire[];
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
  | "fullscreen_enter"
  | "fullscreen_exit"
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
