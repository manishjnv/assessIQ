// AssessIQ — modules/05-assessment-lifecycle public types and Zod schemas.
//
// Three layers:
//   1. Domain types — DB row shapes (Assessment, AssessmentInvitation).
//   2. Service-input types — what callers pass into the public surface
//      (CreateAssessmentInput, ListAssessmentsInput, etc.).
//   3. Error codes — the AL_ERROR_CODES constants used by service-thrown
//      AppError-derived exceptions. The Fastify error handler in apps/api
//      maps these to JSON envelopes.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Status enums — mirror the Postgres enum + CHECK constraints
// ---------------------------------------------------------------------------

export const ASSESSMENT_STATUSES = [
  "draft",
  "published",
  "active",
  "closed",
  "cancelled",
] as const;
export type AssessmentStatus = (typeof ASSESSMENT_STATUSES)[number];

export const INVITATION_STATUSES = [
  "pending",
  "viewed",
  "started",
  "submitted",
  "expired",
] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

// ---------------------------------------------------------------------------
// AssessmentSettings — decision #5
// ---------------------------------------------------------------------------
//
// Phase 1 settings JSONB stays empty. The schema is `z.object({}).passthrough()`
// so the column accepts arbitrary keys (forward-compat) but the empty-object
// default is what the createAssessment service writes. Phase 2+ may pin
// specific keys (e.g. `proctoringMode`, `bandThreshold`) — pinning happens by
// extending this schema, not by reading raw JSONB scattered across the code.

export const AssessmentSettingsSchema = z.object({}).passthrough();
export type AssessmentSettings = z.infer<typeof AssessmentSettingsSchema>;

// ---------------------------------------------------------------------------
// Domain types — DB row shapes (after repository mapping)
// ---------------------------------------------------------------------------

export interface Assessment {
  id: string;
  tenant_id: string;
  pack_id: string;
  level_id: string;
  /**
   * Snapshot of `question_packs.version` taken at createAssessment time.
   * The (pack_id, pack_version) tuple is the assessment's frozen content
   * contract — republishing the pack does NOT re-bind existing assessments.
   * See migrations/0021_assessments.sql for the rationale.
   */
  pack_version: number;
  name: string;
  description: string | null;
  status: AssessmentStatus;
  question_count: number;
  randomize: boolean;
  opens_at: Date | null;
  closes_at: Date | null;
  settings: AssessmentSettings;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface AssessmentInvitation {
  id: string;
  assessment_id: string;
  user_id: string;
  /**
   * sha256(plaintext) — plaintext is delivered ONLY in the email body and
   * never persisted or logged. The accept flow looks up by sha256 of the
   * incoming token.
   */
  token_hash: string;
  expires_at: Date;
  status: InvitationStatus;
  invited_by: string;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Service-input types
// ---------------------------------------------------------------------------

export interface ListAssessmentsInput {
  status?: AssessmentStatus;
  packId?: string;
  page?: number;
  pageSize?: number;
}

export interface CreateAssessmentInput {
  pack_id: string;
  level_id: string;
  name: string;
  description?: string;
  question_count: number;
  randomize?: boolean;     // defaults true
  opens_at?: Date | null;
  closes_at?: Date | null;
  settings?: AssessmentSettings;
}

export interface UpdateAssessmentPatch {
  // Only mutable in 'draft' state; service rejects with INVALID_STATE_TRANSITION
  // if status !== 'draft'.
  name?: string;
  description?: string | null;
  question_count?: number;
  randomize?: boolean;
  opens_at?: Date | null;
  closes_at?: Date | null;
  settings?: AssessmentSettings;
}

export interface PaginatedAssessments {
  items: Assessment[];
  page: number;
  pageSize: number;
  total: number;
}

export interface InviteUsersResult {
  invited: AssessmentInvitation[];
  skipped: Array<{ userId: string; reason: string }>;
}

export interface ListInvitationsInput {
  status?: InvitationStatus;
  page?: number;
  pageSize?: number;
}

export interface PaginatedInvitations {
  items: AssessmentInvitation[];
  page: number;
  pageSize: number;
  total: number;
}

/**
 * Preview return from previewAssessment. The admin sees a deterministic
 * sample of the question pool — same pack/level filter the candidate flow
 * would use, but does NOT create an attempt (no row in `attempts`, no
 * snapshot in `attempt_questions`).
 *
 * The `questions` field is intentionally typed as `unknown[]` — the
 * assessment-lifecycle module does not own question shape (that's
 * `04-question-bank`), and re-exporting that module's `Question` type would
 * couple the two. Callers that want the typed shape should import from
 * `@assessiq/question-bank`.
 */
export interface PreviewQuestionSet {
  assessment_id: string;
  pack_id: string;
  pack_version: number;
  level_id: string;
  pool_size: number;       // total available questions in the pool
  question_count: number;  // how many will be chosen at attempt.start
  questions: unknown[];    // sample preview (limited to question_count entries)
}

// ---------------------------------------------------------------------------
// Error code constants
// ---------------------------------------------------------------------------

export const AL_ERROR_CODES = {
  ASSESSMENT_NOT_FOUND: "ASSESSMENT_NOT_FOUND",
  INVITATION_NOT_FOUND: "INVITATION_NOT_FOUND",
  INVALID_STATE_TRANSITION: "INVALID_STATE_TRANSITION",
  POOL_TOO_SMALL: "POOL_TOO_SMALL",
  WINDOW_INVALID: "WINDOW_INVALID",
  PACK_NOT_FOUND: "PACK_NOT_FOUND",
  PACK_NOT_PUBLISHED: "PACK_NOT_PUBLISHED",
  LEVEL_NOT_FOUND: "LEVEL_NOT_FOUND",
  LEVEL_NOT_IN_PACK: "LEVEL_NOT_IN_PACK",
  USER_NOT_FOUND: "USER_NOT_FOUND",
  USER_NOT_CANDIDATE: "USER_NOT_CANDIDATE",
  INVITATION_EXISTS: "INVITATION_EXISTS",
  REOPEN_PAST_CLOSES_AT: "REOPEN_PAST_CLOSES_AT",
  ASSESSMENT_NOT_DRAFT: "ASSESSMENT_NOT_DRAFT",
  ASSESSMENT_NOT_ACTIVE: "ASSESSMENT_NOT_ACTIVE",
  ASSESSMENT_NOT_CLOSED: "ASSESSMENT_NOT_CLOSED",
  INVALID_PAGE_SIZE: "INVALID_PAGE_SIZE",
  INVALID_PARAM: "INVALID_PARAM",
  MISSING_REQUIRED: "MISSING_REQUIRED",
} as const;

export type AlErrorCode = (typeof AL_ERROR_CODES)[keyof typeof AL_ERROR_CODES];
