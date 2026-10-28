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
  /** Test sections: index into the section list; null/absent = not sectioned. */
  section_index?: number | null;
  /** EXP-8: shared passage (plain text). Shown above the question; absent when the question has none. */
  passage?: { id: string; title: string | null; body: string };
  /** A3-1: stub; content is not sent yet. The position call returns it. */
  withheld?: true;
}

export interface CandidateAttemptViewWire {
  attempt: AttemptWire;
  questions: FrozenQuestionWire[];
  answers: AttemptAnswerWire[];
  remaining_seconds: number;
  /** Integrity v1 runner switches (assessment settings.integrity; default off). */
  integrity?: { fullscreen: boolean; block_copy_paste: boolean };
  /** Test sections: present only for sectioned tests; questions/answers are already this section's. */
  sections?: SectionsViewWire;
  /** Test sections: per-section counts for the final-submit dialog (counts only). */
  sections_summary?: SectionSummaryWire[];
  /** Whole-test timer (Z-42): section names by index; lets the page group the flat question list. */
  section_names?: string[];
  /** FUT-4 / FUT-7 read-only: per section, locked flag and seconds per question; absent for older assessments. */
  section_timing?: SectionTimingWire[];
  /** Logo L3a: organisation name + logo URL for the attempt top bar; absent on older servers. */
  company_name?: string;
  company_logo_url?: string | null;
  /** Z-167: shown in the attempt top bar when the server sends them (not sent yet; the bar falls back to short ids). */
  candidate_name?: string;
  assessment_name?: string;
}

export interface SectionTimingWire {
  locked: boolean;
  seconds_per_question: number | null;
}

export interface SectionSummaryWire {
  index: number;
  name: string;
  question_count: number;
  answered_count: number;
  status: 'done' | 'current' | 'upcoming';
}

export interface SectionsViewWire {
  /** 0-based running section. */
  current: number;
  total: number;
  name: string;
  calculator: boolean;
  /** ISO deadline of the running section. */
  ends_at: string;
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
  /** true when an existing attempt was resumed (clock NOT reset). */
  resumed?: boolean;
  candidate?: { name: string };
  assessment: {
    id: string;
    name: string;
    duration_seconds: number;
    question_count?: number;
    company_name?: string;
    /** Logo L3a: tenant logo URL; null/absent = name only. */
    company_logo_url?: string | null;
    /** Z-82: a real exam that needs the camera. Absent on older servers. */
    camera_required?: boolean;
    camera_notice_version?: string;
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
    /** Logo L3a: tenant logo URL; null/absent (older servers) = name only. */
    company_logo_url?: string | null;
    /** Z-39: the attempt this page is about and how many the candidate may make. Absent on older servers. */
    attempt_number?: number;
    attempts_allowed?: number;
    /** Z-89: set by the admin; the page shows the right screen before start. Absent on older servers. */
    delivery_mode?: "real" | "mock";
    /** Z-82: the camera rule for this test. Absent on older servers. */
    camera_required?: boolean;
    camera_notice_version?: string;
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

/** EX-1: negative-marking summary on a released result. total_earned is net of the penalty and may be negative. */
export interface ResultNegativeMarkingWire {
  enabled: boolean;
  penalty_total: number;
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
  /** Logo L3a: tenant logo URL; null/absent = name only. */
  company_logo_url?: string | null;
  /** Optional hint — see SubmitAttemptResponseWire.release_mode. */
  release_mode?: ReleaseMode;
}

/** Z-42: marks of one test section in the released result. cutoff fields only for a qualifying section with a cutoff. */
export interface ResultSectionWire {
  index: number;
  name: string;
  earned: number;
  max: number;
  cutoff_marks?: number;
  passed_cutoff?: boolean;
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
  /** Z-16: pass mark (1-100) snapshot for this result. Absent on older servers: hide the number. */
  pass_mark_pct?: number;
  /** Z-89: 'mock' results are labelled Mock. Absent on older servers = real. */
  delivery_mode?: "real" | "mock";
  certificate: ResultCertificateWire | null;
  negative_marking?: ResultNegativeMarkingWire;
  /** Z-42: marks per section; absent when the test has no sections or the server is older. */
  sections?: ResultSectionWire[];
  /** Z-39: attempt n of m and whether another try is open. Absent on older servers. */
  retake?: ResultRetakeWire;
  /** Z-44/Z-145: assessment feedback level for the plain feedback sentence. Absent on older servers: no sentence. */
  feedback_level?: FeedbackLevelWire;
  /** Logo L3a: organisation name and logo URL for the Submitted page; absent on older servers. */
  tenant_name?: string;
  company_logo_url?: string | null;
}

/** Z-39: GET /api/me/attempts/:id/result `retake`. can_retake is the whole server-side rule. */
export interface ResultRetakeWire {
  assessment_id: string;
  attempt_number: number;
  attempts_allowed: number;
  can_retake: boolean;
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
  /** Z-16: pass mark (1-100) snapshot for this result. Absent on older servers: hide the number. */
  pass_mark_pct?: number;
  /** Z-89: 'mock' results get a Mock badge. */
  delivery_mode?: "real" | "mock";
  certificate: ResultCertificateWire | null;
  negative_marking?: ResultNegativeMarkingWire;
  /** Z-12: true until the candidate opens this result. */
  is_new?: boolean;
  /** Z-145: this attempt's feedback level (none for Real and embed). Absent or "none": no review section. */
  feedback_level?: FeedbackLevelWire;
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

// GET /api/me/attempts/:id/feedback (RW-80) - per-question review of a released result.
export type FeedbackLevelWire = "none" | "right_wrong" | "with_expected_answer" | "with_ai_justification";

export interface FeedbackItemWire {
  question_id: string;
  position: number;
  type: string;
  prompt: string;
  your_answer: string | null;
  outcome: "correct" | "incorrect" | "partial";
  score_earned: number;
  score_max: number;
  expected_answer: string | null;
  explanation: string | null;
  study: { unit: string | null; subject: string | null; topic: string };
}

export interface AttemptFeedbackWire {
  level: FeedbackLevelWire;
  items: FeedbackItemWire[];
}
