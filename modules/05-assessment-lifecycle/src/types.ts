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
// Blueprint schema — Phase 2 Slice A (settings.blueprint JSONB, no migration)
// ---------------------------------------------------------------------------
//
// A blueprint is an optional settings sub-key that lets an admin declare a
// domain + level + per-category/type question selection contract. When present,
// each candidate's attempt draws independently per criterion (Fisher-Yates,
// decision #20). When absent, the existing full-pool draw is unchanged.
//
// Single-domain v1 (multi-domain deferred). Cross-tenant guard at BOTH write
// (C1 service) and draw (C3 defensive note).
//
// SECURITY: blueprint.domain_id / criterion.category_id are JSONB — no Postgres
// FK enforces tenant isolation. The service layer (createAssessment /
// updateAssessment) must verify each id belongs to the session tenant BEFORE
// persisting. That explicit guard is the primary security control.

export const BLUEPRINT_LEVELS = ["L1", "L2", "L3"] as const;
export type BlueprintLevel = (typeof BLUEPRINT_LEVELS)[number];

export const BLUEPRINT_QUESTION_TYPES = [
  "mcq",
  "scenario",
  "subjective",
  "kql",
  "log_analysis",
] as const;
export type BlueprintQuestionType = (typeof BLUEPRINT_QUESTION_TYPES)[number];

export const BlueprintCriterionSchema = z.object({
  category_id: z.string().uuid("category_id must be a UUID"),
  type: z.enum(BLUEPRINT_QUESTION_TYPES, {
    errorMap: () => ({
      message: `type must be one of: ${BLUEPRINT_QUESTION_TYPES.join(", ")}`,
    }),
  }),
  count: z.number().int().min(1, "count must be ≥ 1"),
});
export type BlueprintCriterion = z.infer<typeof BlueprintCriterionSchema>;

export const AssessmentBlueprintSchema = z.object({
  domain_id: z.string().uuid("domain_id must be a UUID"),
  level: z.enum(BLUEPRINT_LEVELS, {
    errorMap: () => ({ message: "level must be L1, L2, or L3" }),
  }),
  criteria: z
    .array(BlueprintCriterionSchema)
    .min(1, "criteria must have at least one entry"),
});
export type AssessmentBlueprint = z.infer<typeof AssessmentBlueprintSchema>;

// ---------------------------------------------------------------------------
// AssessmentSettings — decision #5
// ---------------------------------------------------------------------------
//
// Phase 1 settings JSONB stays empty. The schema is `z.object({}).passthrough()`
// so the column accepts arbitrary keys (forward-compat) but the empty-object
// default is what the createAssessment service writes. Phase 2 pins
// `blueprint` here — adding it to this schema is the clean approach per the
// original design note.

export const AssessmentSettingsSchema = z
  .object({
    blueprint: AssessmentBlueprintSchema.optional(),
  })
  .passthrough();
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
  /** Optional — populated by findAssessmentByIdWithMeta (detail) + listAssessmentRows (list). */
  level_label?: string | null;
  /** Optional — populated by findAssessmentByIdWithMeta (detail view only). */
  pack_name?: string | null;
  /**
   * Optional — the bound pack's domain as a human-readable NAME, resolved from
   * the tenant-scoped `domains` table (domains.name, e.g. "SOC", "Application
   * Security"), falling back to the raw question_packs.domain slug when no
   * domains row matches. Populated by listAssessmentRows (list view). Uniform
   * across blueprint and non-blueprint assessments because every assessment is
   * bound to a pack and every pack carries a domain slug. Resolved server-side
   * (not via the FE static map) so it tracks super-admin domain renames.
   */
  domain?: string | null;
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
  /** Optional — populated by listInvitationRows (list view only, not single-row reads). */
  user_name?: string | null;
  user_email?: string | null;
  attempt_id?: string | null;
  attempt_status?: string | null;
  started_at?: Date | null;
  submitted_at?: Date | null;
  total_earned?: number | null;
  total_max?: number | null;
  auto_pct?: number | null;
  pending_review?: boolean | null;
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

/**
 * Step 2 — input for createAssessmentFromSet (clone-on-use): build an
 * assessment from a licensed PLATFORM-library set. `source_pack_id` is the
 * platform pack id; `level_position` selects a level within it (1-based,
 * resolved against the cloned pack after materialisation).
 */
export interface CreateAssessmentFromSetInput {
  source_pack_id: string;
  level_position: number;
  name: string;
  description?: string;
  question_count: number;
  randomize?: boolean;
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
 *
 * When the assessment has `settings.blueprint`, the response includes
 * `blueprint_criteria` — per-criterion adequacy + sample.
 */
export interface PreviewCriterionResult {
  criterion_index: number;
  category_id: string;
  type: string;
  required: number;
  available: number;
  sample: unknown[];  // up to `required` representative topics
}

export interface PreviewQuestionSet {
  assessment_id: string;
  pack_id: string;
  pack_version: number;
  level_id: string;
  pool_size: number;       // total available questions in the pool
  question_count: number;  // how many will be chosen at attempt.start
  questions: unknown[];    // sample preview (limited to question_count entries)
  /** Present only when assessment has settings.blueprint */
  blueprint_criteria?: PreviewCriterionResult[];
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
  TENANT_NAME_MISSING: "TENANT_NAME_MISSING",
  // Phase 2 Slice A — blueprint
  CROSS_TENANT_FK_REJECTED: "CROSS_TENANT_FK_REJECTED",
  BLUEPRINT_INVALID: "BLUEPRINT_INVALID",
  POOL_TOO_SMALL_CRITERION: "POOL_TOO_SMALL_CRITERION",
  // Slice A.2 — opens_at mandatory
  OPENS_AT_REQUIRED: "OPENS_AT_REQUIRED",
} as const;

export type AlErrorCode = (typeof AL_ERROR_CODES)[keyof typeof AL_ERROR_CODES];
