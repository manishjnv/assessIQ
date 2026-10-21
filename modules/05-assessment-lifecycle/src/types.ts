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
import type { QuestionType } from "@assessiq/question-types";

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

// RW-68: the five generator-backed types a blueprint may draw; typed against the registry.
export const BLUEPRINT_QUESTION_TYPES = ["mcq", "scenario", "subjective", "kql", "log_analysis"] as const satisfies readonly Extract<QuestionType, string>[];
export type BlueprintQuestionType = (typeof BLUEPRINT_QUESTION_TYPES)[number];

export const BlueprintCriterionSchema = z
  .object({
    category_id: z.string().uuid("category_id must be a UUID").optional(),
    // RW-55: a curriculum 'unit' node, resolved to the tenant's (domain_id, category_id)
    // at write time. The draw never sees node_id.
    node_id: z.string().uuid("node_id must be a UUID").optional(),
    // Z-43: optional difficulty_est range (1..5), used only by node_id criteria with no category.
    difficulty_min: z.number().int().min(1).max(5).optional(),
    difficulty_max: z.number().int().min(1).max(5).optional(),
    type: z.enum(BLUEPRINT_QUESTION_TYPES, {
      errorMap: () => ({
        message: `type must be one of: ${BLUEPRINT_QUESTION_TYPES.join(", ")}`,
      }),
    }),
    count: z.number().int().min(1, "count must be ≥ 1"),
  })
  .refine((c) => c.category_id !== undefined || c.node_id !== undefined, {
    message: "each criterion needs category_id or node_id",
  });
export type BlueprintCriterion = z.infer<typeof BlueprintCriterionSchema>;

export const AssessmentBlueprintSchema = z
  .object({
    // Optional only when every criterion has a node_id (domain derived from the unit node).
    domain_id: z.string().uuid("domain_id must be a UUID").optional(),
    level: z.enum(BLUEPRINT_LEVELS, {
      errorMap: () => ({ message: "level must be L1, L2, or L3" }),
    }),
    criteria: z
      .array(BlueprintCriterionSchema)
      .min(1, "criteria must have at least one entry"),
    // Z-51 (option b): one timer for the whole test. Absent = no whole-test timer (blueprint mocks keep their own timing).
    whole_test_minutes: z
      .number()
      .int("whole_test_minutes must be a whole number")
      .min(1, "whole_test_minutes must be at least 1")
      .max(600, "whole_test_minutes must be at most 600")
      .optional(),
    // Z-51 (option b): marks for each question drawn by this blueprint. Absent = each question keeps its own points.
    marks_per_question: z
      .number()
      .min(0, "marks_per_question must be at least 0")
      .max(1000, "marks_per_question must be at most 1000")
      .optional(),
  })
  .refine((b) => b.domain_id !== undefined || b.criteria.every((c) => c.node_id !== undefined), {
    message: "domain_id is required unless every criterion has a node_id",
  });
/** Write-time INPUT shape (loosened for RW-55). */
export type AssessmentBlueprint = z.infer<typeof AssessmentBlueprintSchema>;

/** STORED shape in settings.blueprint: always resolved. Draw/count/preview/freeze read only this. */
export interface ResolvedBlueprint {
  domain_id: string;
  level: BlueprintLevel;
  criteria: Array<{
    /** Absent for a Z-43 taxonomy criterion: that one draws by node_id and its descendants. */
    category_id?: string;
    node_id?: string;
    difficulty_min?: number;
    difficulty_max?: number;
    type: BlueprintQuestionType;
    count: number;
  }>;
  whole_test_minutes?: number;
  marks_per_question?: number;
}

// ---------------------------------------------------------------------------
// AssessmentSettings — decision #5
// ---------------------------------------------------------------------------
//
// Phase 1 settings JSONB stays empty. The schema is `z.object({}).passthrough()`
// so the column accepts arbitrary keys (forward-compat) but the empty-object
// default is what the createAssessment service writes. Phase 2 pins
// `blueprint` here — adding it to this schema is the clean approach per the
// original design note.

// Integrity v1 — candidate-runner proctoring-lite switches (both default off).
export const AssessmentIntegritySettingsSchema = z
  .object({
    fullscreen: z.boolean().optional(),
    block_copy_paste: z.boolean().optional(),
  })
  .strict();
export type AssessmentIntegritySettings = z.infer<typeof AssessmentIntegritySettingsSchema>;

// Invitation reminders (2026-10-02). Absent = OFF. `hours_before` defaults to 24 when omitted.
export const AssessmentRemindersSettingsSchema = z
  .object({
    enabled: z.boolean(),
    hours_before: z.number().int().min(1).max(168).optional(),
  })
  .strict();
export type AssessmentRemindersSettings = z.infer<typeof AssessmentRemindersSettingsSchema>;
// Test sections — each has its own server-enforced timer (module 06). A section draws
// from the pack/level pool: `category_ids` narrows it, `question_count` caps it (at
// least one of the two is required). Not combinable with `blueprint` (own parallel
// structure: blueprint is single-domain criteria with no time dimension).
export const AssessmentSectionSchema = z
  .object({
    name: z.string().trim().min(1, "section name is required").max(80),
    category_ids: z.array(z.string().uuid()).min(1).max(50).optional(),
    question_count: z.number().int().min(1).max(500).optional(),
    /** Per-section timer. Absent only when settings.whole_test_minutes sets ONE timer for the whole test (Z-42). */
    minutes: z.number().int().min(1, "minutes must be at least 1").max(300, "minutes must be at most 300").optional(),
    /** Z-42: every question of this section scores this many marks (frozen into attempt_questions at start). */
    marks_per_question: z.number().min(0).max(1000).optional(),
    /** Z-42: marks lost for a wrong answer in this section (absolute, frozen at start). Only used with marks_per_question. */
    negative_marks_per_question: z.number().min(0).max(1000).optional(),
    calculator: z.boolean().optional(),
    /** EXP-6: a qualifying section with a cutoff reports `passed_cutoff` in the result (marks, not percent). */
    qualifying: z.boolean().optional(),
    cutoff_marks: z.number().min(0).max(1_000_000).optional(),
  })
  .strict()
  .refine((s) => s.category_ids !== undefined || s.question_count !== undefined, {
    message: "each section needs question_count and/or category_ids",
  });
export type AssessmentSection = z.infer<typeof AssessmentSectionSchema>;
export const AssessmentSectionsSchema = z.array(AssessmentSectionSchema).min(1).max(10);

/**
 * Z-42: timing rule across sections. With `whole_test_minutes` there is ONE server timer and no section
 * carries `minutes`; without it every section needs `minutes` (one-at-a-time lock, as before).
 * Returns a message, or null when valid.
 */
export function sectionTimingProblem(
  sections: ReadonlyArray<{ minutes?: number | undefined }>,
  wholeTestMinutes: number | undefined,
): string | null {
  if (wholeTestMinutes !== undefined) {
    return sections.some((s) => s.minutes !== undefined) ? "with whole_test_minutes, sections must not have minutes" : null;
  }
  return sections.some((s) => s.minutes === undefined) ? "each section needs minutes (or set whole_test_minutes)" : null;
}

export const AssessmentSettingsSchema = z
  .object({
    blueprint: AssessmentBlueprintSchema.optional(),
    integrity: AssessmentIntegritySettingsSchema.optional(),
    reminders: AssessmentRemindersSettingsSchema.optional(),
    high_stakes: z.boolean().optional(),
    /** Z-39: which attempt counts when a candidate retakes. Absent = latest. */
    score_counts: z.enum(["latest", "best"]).optional(),
    sections: AssessmentSectionsSchema.optional(),
    /** Z-42: one timer for the whole test, free movement between sections. Needs sections without `minutes`. */
    whole_test_minutes: z.number().int().min(1).max(600).optional(),
    /** EX-1: default penalty for a wrong attempted answer on auto-scored questions (a question's own value wins). */
    scoring: z.object({ negative_marks_default: z.number().min(0).max(1000).optional() }).strict().optional(),
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
  /** Z-16: pass mark, integer 1..100. Pre-filled from the level; editable only while draft. */
  passing_score_pct: number;
  /** Z-39: attempts one candidate may make. null or 1 = no retake (default); 2..10 allowed. Draft-only edit. */
  max_attempts: number | null;
  /** Optional time limit in minutes (1..600) set by the admin; null = use the level time. */
  duration_minutes: number | null;
  /** Minutes the candidate gets: duration_minutes, else the level time. Set on the admin detail and list reads. */
  effective_duration_minutes?: number | null;
  /** Z-89: default test type for invitations. 'real' = laptop/desktop only; 'mock' = any device, no certificate. */
  delivery_mode: "real" | "mock";
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
  /** Z-39: extra attempts an admin granted this candidate on top of assessments.max_attempts. */
  extra_attempts?: number;
  /** Z-89: set by the admin at invite time; copied onto the attempt at start. */
  delivery_mode: "real" | "mock";
  /** Z-39: attempts used / total allowed. Populated by listInvitationRows only. */
  attempts_used?: number;
  attempts_allowed?: number;
  /** When the automatic reminder was sent (null = none yet). Populated by listInvitationRows only. */
  reminded_at?: Date | null;
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
  /**
   * Optional — populated by listInvitations (admin list view only). True when
   * POST /api/admin/invitations/:id/resend would be accepted: the assessment is
   * published/active AND the candidate has not started. Revoked and lapsed
   * invitations are resendable; started / submitted ones are not.
   */
  can_resend?: boolean;
  /** Z-39: POST /invitations/:id/reopen would be accepted (submitted, attempts left, assessment open). */
  can_reopen?: boolean;
  /** Z-39: POST /invitations/:id/extra-attempt would be accepted. */
  can_grant_extra?: boolean;
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
  /** Z-16: integer 1..100; defaults to the level's passing_score_pct. */
  passing_score_pct?: number;
  /** Z-39: null or 1 = no retake; 2..10 = attempts allowed. */
  max_attempts?: number | null;
  /** Optional time limit, integer 1..600; null or omitted = level time. */
  duration_minutes?: number | null;
  /** Z-89: 'real' (default) or 'mock'. */
  delivery_mode?: "real" | "mock";
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
  /** Z-16: integer 1..100; defaults to the chosen level's passing_score_pct. */
  passing_score_pct?: number;
  /** Z-39: null or 1 = no retake; 2..10 = attempts allowed. */
  max_attempts?: number | null;
  /** Optional time limit, integer 1..600; null or omitted = level time. */
  duration_minutes?: number | null;
  /** Z-89: 'real' (default) or 'mock'. */
  delivery_mode?: "real" | "mock";
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
  /** Z-16: integer 1..100. Draft only; any patch on a published assessment is rejected. */
  passing_score_pct?: number;
  /** Z-39: null or 1 = no retake; 2..10 = attempts allowed. Draft only. */
  max_attempts?: number | null;
  /** Optional time limit, integer 1..600; null clears it (level time). */
  duration_minutes?: number | null;
  /** Z-89: 'real' (default) or 'mock'. */
  delivery_mode?: "real" | "mock";
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
  /**
   * How many invitations of this assessment (across ALL pages, not just the
   * returned one) the bulk "resend to everyone who hasn't started" action
   * would send right now. 0 when the assessment is not published/active.
   */
  resendable: number;
}

/** Response of POST /api/admin/assessments/:id/invitations/resend. */
export interface BulkResendResult {
  /** Invitations re-issued and emailed in this call. */
  resent: number;
  /** Rows that could not be resent (race with the candidate starting, disabled account, email failure…). */
  skipped: Array<{ id: string; code: string }>;
  /** Eligible invitations beyond the per-call cap that were NOT touched — call again to continue. */
  remaining: number;
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
  category_id?: string | undefined;
  node_id?: string | undefined;
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
  /** true when counts/sample come from assessment_frozen_pool (published/closed/reopened); false = live pool. */
  frozen?: boolean;
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
  SECTIONS_LOCKED: "SECTIONS_LOCKED",
  ASSESSMENT_NOT_ACTIVE: "ASSESSMENT_NOT_ACTIVE",
  ASSESSMENT_NOT_CLOSED: "ASSESSMENT_NOT_CLOSED",
  // Hard-delete guard: assessment has ≥1 attempt → block delete, suggest cancel.
  ASSESSMENT_HAS_ATTEMPTS: "ASSESSMENT_HAS_ATTEMPTS",
  INVALID_PAGE_SIZE: "INVALID_PAGE_SIZE",
  INVALID_PARAM: "INVALID_PARAM",
  MISSING_REQUIRED: "MISSING_REQUIRED",
  TENANT_NAME_MISSING: "TENANT_NAME_MISSING",
  // Phase 2 Slice A — blueprint
  CROSS_TENANT_FK_REJECTED: "CROSS_TENANT_FK_REJECTED",
  BLUEPRINT_INVALID: "BLUEPRINT_INVALID",
  BLUEPRINT_NODE_UNRESOLVED: "BLUEPRINT_NODE_UNRESOLVED",
  BLUEPRINT_NODE_KIND_UNSUPPORTED: "BLUEPRINT_NODE_KIND_UNSUPPORTED",
  BLUEPRINT_NODE_MISMATCH: "BLUEPRINT_NODE_MISMATCH",
  BLUEPRINT_MIXED_DOMAINS: "BLUEPRINT_MIXED_DOMAINS",
  BLUEPRINT_DOMAIN_REQUIRED: "BLUEPRINT_DOMAIN_REQUIRED",
  BLUEPRINT_NODE_EMPTY: "BLUEPRINT_NODE_EMPTY",
  BLUEPRINT_DIFFICULTY_INVALID: "BLUEPRINT_DIFFICULTY_INVALID",
  POOL_TOO_SMALL_CRITERION: "POOL_TOO_SMALL_CRITERION",
  // EXP-18 — publish blocked while a pool question has an explicit review_state other than verified
  QUESTIONS_NOT_VERIFIED: "QUESTIONS_NOT_VERIFIED",
  /** Z-52: Postgres deadlock (40P01) on the pool share-lock; safe to retry. */
  DEADLOCK_RETRY: "DEADLOCK_RETRY",
  // Slice A.2 — opens_at mandatory
  OPENS_AT_REQUIRED: "OPENS_AT_REQUIRED",
  // Invitation resend / re-invite (2026-10-01)
  // 409 — the candidate already has an attempt (or the invitation is started /
  // submitted), so the link can no longer be replaced.
  INVITATION_ALREADY_STARTED: "INVITATION_ALREADY_STARTED",
  // Z-39 retake policy. 409 — every allowed attempt is used (max_attempts + extra), so the
  // invitation can't be re-opened. 409 — this candidate already has the most extra attempts.
  ATTEMPTS_EXHAUSTED: "ATTEMPTS_EXHAUSTED",
  EXTRA_ATTEMPT_LIMIT: "EXTRA_ATTEMPT_LIMIT",
  // 409 — re-open needs a submitted invitation with no unfinished attempt.
  RETAKE_NOT_AVAILABLE: "RETAKE_NOT_AVAILABLE",
  // 409 — the invited user is disabled / not a candidate any more.
  USER_INACTIVE: "USER_INACTIVE",
  // 409 — the candidate was erased (DPDP/GDPR, users.erased_at); no invitation may be sent.
  CANDIDATE_ERASED: "CANDIDATE_ERASED",
  // 502 — the link was re-issued and committed but the email could not be queued.
  INVITATION_EMAIL_FAILED: "INVITATION_EMAIL_FAILED",
} as const;

export type AlErrorCode = (typeof AL_ERROR_CODES)[keyof typeof AL_ERROR_CODES];
