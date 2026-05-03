// AssessIQ — modules/07-ai-grading public types.
//
// Phase 2 G2.A Session 1.a — type contracts only. Runtime + handlers ship in
// 1.b/1.c. Types live here so module 09 (scoring), module 10 (admin
// dashboard), and apps/api can already import the shapes they'll consume
// from the runtime once it lands.
//
// Source-of-truth for the shapes: docs/05-ai-pipeline.md § "Implementation
// skeleton — Phase 1" (lines 357-432) and D4 (prompt SHA + model column shape).

import { z } from "zod";

// ---------------------------------------------------------------------------
// AnchorFinding — Stage 1 output (claude-haiku-4-5 via grade-anchors skill)
// ---------------------------------------------------------------------------

export const AnchorFindingSchema = z.object({
  anchor_id: z.string(),
  hit: z.boolean(),
  evidence_quote: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type AnchorFinding = z.infer<typeof AnchorFindingSchema>;

// ---------------------------------------------------------------------------
// BandFinding — Stage 2 output (claude-sonnet-4-6 via grade-band skill)
// ---------------------------------------------------------------------------

export const BandFindingSchema = z.object({
  reasoning_band: z.number().int().min(0).max(4),
  ai_justification: z.string(),
  error_class: z.string().nullable().optional(),
  /**
   * When the Stage 2 model self-reports it lacks confidence in the band
   * assignment (e.g., reasoning that crossed multiple thresholds), it
   * sets this flag to request the Stage 3 escalation.
   */
  needs_escalation: z.boolean().optional(),
});
export type BandFinding = z.infer<typeof BandFindingSchema>;

// ---------------------------------------------------------------------------
// GradingProposal — full Stage-1+2 output for one (attempt, question)
// ---------------------------------------------------------------------------
//
// Returned by `gradeSubjective(input)` — the runtime never writes to DB.
// The admin reviews the proposal and POSTs to `/admin/attempts/:id/accept`
// before any `gradings` row materialises.

export const GradingProposalSchema = z.object({
  attempt_id: z.string().uuid(),
  question_id: z.string().uuid(),
  anchors: z.array(AnchorFindingSchema),
  band: BandFindingSchema,
  /** Computed via finalScore() from @assessiq/rubric-engine. */
  score_earned: z.number(),
  score_max: z.number(),
  /** D4: prompt SHA pinning — `anchors:<8hex>;band:<8hex>;escalate:<8hex|->`. */
  prompt_version_sha: z.string(),
  /** D4: human-readable from skill frontmatter. */
  prompt_version_label: z.string(),
  /** D4: concatenated model identifiers, e.g. `haiku-4.5+sonnet-4.6`. */
  model: z.string(),
  /** Stage actually used: 2 (Sonnet band), 3 (Opus escalate), or `null` for deterministic / pattern grader (Phase 1: always 2 unless escalated). */
  escalation_chosen_stage: z.enum(["2", "3", "manual"]).nullable(),
  /** ISO-8601 server timestamp of proposal generation. */
  generated_at: z.string().datetime(),
});
export type GradingProposal = z.infer<typeof GradingProposalSchema>;

// ---------------------------------------------------------------------------
// GradingsRow — DB row shape after admin accept
// ---------------------------------------------------------------------------

export interface GradingsRow {
  id: string;
  tenant_id: string;
  attempt_id: string;
  question_id: string;
  grader: "deterministic" | "pattern" | "ai" | "admin_override";
  score_earned: number;
  score_max: number;
  status: "correct" | "incorrect" | "partial" | "review_needed" | "overridden";
  anchor_hits: AnchorFinding[] | null;
  reasoning_band: number | null;
  ai_justification: string | null;
  error_class: string | null;
  prompt_version_sha: string;
  prompt_version_label: string;
  model: string;
  escalation_chosen_stage: "2" | "3" | "manual" | null;
  graded_at: Date;
  graded_by: string | null;
  override_of: string | null;
  override_reason: string | null;
}

// ---------------------------------------------------------------------------
// GradingInput — what the handler hands to the runtime
// ---------------------------------------------------------------------------

export interface GradingInput {
  attempt_id: string;
  question_id: string;
  /** Question content frozen at attempt-start time (from question_versions). */
  question_content: unknown;
  /** Rubric frozen at attempt-start time. */
  rubric: unknown;
  /** Candidate answer payload from attempt_answers.answer. */
  answer: unknown;
  /**
   * When true, the runtime skips the Stage-2 `needs_escalation` gate and
   * always runs Stage 3 (grade-escalate skill). Used by `handleAdminRerun`
   * to give the admin an Opus second-opinion on demand. Default false —
   * Stage 3 still triggers automatically when Stage 2 sets
   * `needs_escalation: true`.
   */
  force_escalate?: boolean;
}

// ---------------------------------------------------------------------------
// SkillVersion — what `listSkills()` returns
// ---------------------------------------------------------------------------

export interface SkillVersion {
  /** Skill name, e.g. `grade-anchors`. */
  name: string;
  /** Full sha256 of SKILL.md. */
  sha256: string;
  /** First 8 hex chars — the form embedded in `prompt_version_sha`. */
  short: string;
  /** Frontmatter `version:` value, e.g. `v1`. */
  label: string;
  /** Frontmatter `model:` value, e.g. `claude-haiku-4-5`. */
  model: string;
}

// ---------------------------------------------------------------------------
// Tenant grading budget — D6 row shape
// ---------------------------------------------------------------------------

export interface TenantGradingBudget {
  tenant_id: string;
  monthly_budget_usd: number;
  used_usd: number;
  period_start: Date;
  alert_threshold_pct: number;
  alerted_at: Date | null;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const AI_GRADING_ERROR_CODES = {
  /** Mode mismatch: handler called when AI_PIPELINE_MODE != 'claude-code-vps' */
  MODE_NOT_CLAUDE_CODE_VPS: "AIG_MODE_NOT_CLAUDE_CODE_VPS",
  /** Single-flight: another grading is already in flight for this attempt or process */
  GRADING_IN_PROGRESS: "AIG_GRADING_IN_PROGRESS",
  /** Heartbeat: admin session inactive > 60s — fresh click required */
  HEARTBEAT_STALE: "AIG_HEARTBEAT_STALE",
  /** Skill file missing or unreadable on the VPS */
  SKILL_NOT_FOUND: "AIG_SKILL_NOT_FOUND",
  /** Schema-violation in `claude` stream-json output */
  SCHEMA_VIOLATION: "AIG_SCHEMA_VIOLATION",
  /** `claude` subprocess exited non-zero or timed out */
  RUNTIME_FAILURE: "AIG_RUNTIME_FAILURE",
  /** Stage 2 returned needs_escalation=true and escalate path failed too */
  ESCALATION_FAILURE: "AIG_ESCALATION_FAILURE",
  /** Phase 2+ runtime called in a Phase 1 build */
  RUNTIME_NOT_IMPLEMENTED: "AIG_RUNTIME_NOT_IMPLEMENTED",
  /** D6 budget exhaustion — only fires in anthropic-api runtime */
  BUDGET_EXHAUSTED: "AIG_BUDGET_EXHAUSTED",
  /** Attempt is not in a gradeable status (must be submitted | pending_admin_grading) */
  ATTEMPT_NOT_GRADEABLE: "AIG_ATTEMPT_NOT_GRADEABLE",
  /** Idempotency: row already exists for (attempt, question, sha) */
  ALREADY_GRADED: "AIG_ALREADY_GRADED",
  /** Override requires fresh MFA; session.lastTotpAt > 5min ago */
  FRESH_MFA_REQUIRED: "AIG_FRESH_MFA_REQUIRED",
  /** Override / accept body validation */
  INVALID_BODY: "AIG_INVALID_BODY",
  /** Cross-user / cross-tenant attempt to grade an attempt not visible under RLS */
  ATTEMPT_NOT_FOUND: "AIG_ATTEMPT_NOT_FOUND",
  /** No prior grading row found to override */
  GRADING_NOT_FOUND: "AIG_GRADING_NOT_FOUND",
  /** Eval harness: case ID format invalid */
  INVALID_EVAL_CASE: "AIG_INVALID_EVAL_CASE",
} as const;

export type AiGradingErrorCode =
  (typeof AI_GRADING_ERROR_CODES)[keyof typeof AI_GRADING_ERROR_CODES];
