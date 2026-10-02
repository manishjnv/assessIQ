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
  /** SP5: where the proposal came from; absent = AI (legacy cached proposals). */
  source: z.enum(["rule", "reuse", "ai"]).optional(),
  /** SP5: for source 'reuse', the gradings.id whose band was reused. */
  reused_from_grading_id: z.string().uuid().optional(),
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
  /**
   * High-stakes assessment (settings.high_stakes): Stage 3 always runs and must agree
   * with Stage 2 exactly; any band difference or Stage-3 failure routes to review.
   */
  high_stakes?: boolean;
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
// GenerateQuestions — input / output types for the AI question generator
// ---------------------------------------------------------------------------

/**
 * Input to generateQuestions() via the runtime-selector.
 * Constructed by handlers/admin-generate.ts.
 */
export interface GenerateQuestionsInput {
  /** SOC analyst level — controls KB slice and question depth. */
  level: "L1" | "L2" | "L3";
  /** Target question count, 1-10. */
  count: number;
  /** Optional KbSource.function category to prefer. */
  topicFocus?: string;
  /** Existing topic strings to avoid duplication. */
  existingTopics: string[];
  /**
   * Curated KB sources to embed in the generator prompt.
   * Selected by the handler from SOC_KNOWLEDGE_BASE filtered by level/topicFocus.
   * The runtime never imports the KB directly — sources are passed in as data.
   */
  sources: Array<{
    id: string;
    name: string;
    citation: string;
    url: string;
    level_fit: "L1" | "L2" | "L3";
    function: string;
    description: string;
    tags: string[];
    kb_version: string;
  }>;
  /** For structured logging only — not sent to the model. */
  packId: string;
  levelId: string;
  /**
   * Optional difficulty target vector for this level (Phase A3) — the full
   * per-type map. Serializable plain data, injected into the skill prompt so
   * the model targets the intended intrinsic difficulty. Absent for back-compat
   * (callers that do not inject difficulty).
   */
  difficulty?: unknown;
}

/**
 * One question draft returned by the generate-questions skill's
 * submit_questions MCP tool call.
 */
export interface GeneratedQuestionDraft {
  type: "mcq" | "subjective" | "kql" | "scenario" | "log_analysis";
  topic: string;
  points: number;
  content: unknown;
  rubric: unknown | null;
  /**
   * Raw source IDs exactly as emitted by the model via submit_questions.
   * Preserved through the runtime so the handler can enforce the citation
   * HARD RULE mechanically (any ID not in input.sources[].id causes the
   * question to be dropped). See admin-generate.ts filterByCitation().
   */
  knowledge_base_source_ids: string[];
  /** KbSource.id values from the KB slice — for provenance chips. */
  knowledgeBaseSources: Array<{
    id: string;
    name: string;
    citation: string;
    url: string;
    level_fit: "L1" | "L2" | "L3";
    function: string;
    kb_version: string;
  }>;
}

/**
 * Question type union — canonical alias used across generation & weighting logic.
 */
export type QuestionType = "mcq" | "subjective" | "kql" | "scenario" | "log_analysis";

/**
 * Returned by generateQuestions() — the full set of generated drafts plus
 * the skill SHA for provenance recording.
 */
export interface GenerateQuestionsOutput {
  questions: GeneratedQuestionDraft[];
  /** First 8 hex chars of the generate-questions SKILL.md sha256. */
  skillSha: string;
  /** Model identifier from skill frontmatter — populated for generation_attempts observability. */
  model?: string;
  /**
   * Count of questions dropped because their `type` field did not match the
   * requested type. Populated by the sharded path only; omnibus path leaves
   * this undefined.
   */
  wrongTypeDropped?: number;
}

// ---------------------------------------------------------------------------
// GenerateByTypeInput — per-type sharded generation (Stage 1)
// ---------------------------------------------------------------------------

/**
 * Input to generateQuestionsByType() — one call per question type in the
 * sharded fan-out. See docs/design/2026-05-09-type-sharded-generation.md.
 *
 * Stage 3: `subjective` is now a first-class type in the sharded path,
 * served by the dedicated generate-subjective skill. All 5 question types
 * are supported.
 */
export interface GenerateByTypeInput {
  level: "L1" | "L2" | "L3";
  /** Type of question this call will generate. */
  type: QuestionType;
  count: number;
  topicFocus?: string | null;
  existingTopics: string[];
  sources: Array<{
    id: string;
    name: string;
    citation: string;
    url: string;
    level_fit: "L1" | "L2" | "L3";
    function: string;
    description: string;
    tags: string[];
    kb_version: string;
  }>;
  packId: string;
  levelId: string;
  /** Per-type difficulty target for this level (Phase A3); serializable, injected into the skill prompt. Absent for back-compat. */
  difficulty?: unknown;
}

// ---------------------------------------------------------------------------
// GenerateRubric — input / output types for the AI rubric generator
// ---------------------------------------------------------------------------

export interface LevelRubricDefaults {
  profile: "foundational" | "practitioner" | "expert";
  anchorComplexity: "short" | "medium" | "dense";
  bandStrictness: "lenient" | "standard" | "strict";
}

/**
 * Input to generateRubricDraft() via the runtime selector.
 * Constructed by the question-bank service layer.
 */
export interface GenerateRubricInput {
  /** Full question prompt text — passed verbatim into the skill.
   * For log_analysis questions this is the JSON-serialized content object
   * (question, log_format, log_excerpt, expected_findings, sample_solution, hint)
   * so the skill can derive one anchor per expected_finding. */
  questionText: string;
  /** Question type — controls anchor depth guidance.
   * mcq and kql are excluded: they use deterministic grading and have no rubric semantics. */
  questionType: "subjective" | "scenario" | "log_analysis";
  /** Level ordinal (1-5) — calibrates complexity when levelDefaults is null. */
  levelOrdinal: number;
  /** Optional level-defaults from levels.rubric_defaults JSONB. */
  levelDefaults: LevelRubricDefaults | null;
  /** If set, this is a re-generation request — include in skill prompt. */
  existingRubric?: unknown;
  /** For structured logging only — not sent to the model. */
  questionId: string;
}

/**
 * Output of generateRubricDraft(): the proposal + audit metadata.
 * The proposal is NOT persisted — the handler returns it to the admin for review.
 */
export interface GenerateRubricOutput {
  /** The generated Rubric JSON (satisfies RubricSchema). */
  rubric: import("@assessiq/rubric-engine").Rubric;
  /** Skill file SHA (8 hex chars). */
  skillSha: string;
  /** Prompt SHA (SHA256 of JSON.stringify(promptVars), first 8 hex chars). */
  promptSha: string;
  /** Hash of levelDefaults as used at generation time (SHA256 of sorted JSON; empty string if null). */
  levelDefaultsHash: string;
  /** Model identifier from skill frontmatter. */
  model: string;
}

// ---------------------------------------------------------------------------
// GenerateAnswerGuidance — input / output for the AI answer-format hint
// generator (feature #4, Phase B). Distinct from rubric generation: the hint
// is candidate-facing and instructional, applies to ALL question types, and
// the generator is handed an answer-key-FREE question stem so it cannot leak
// the answer. The proposal is NOT persisted by the generator — the admin
// reviews it and saves via the existing answer_guidance PATCH (admin-in-the-
// loop gate before any candidate sees it).
// ---------------------------------------------------------------------------

/** Input to generateAnswerGuidanceDraft() via the runtime selector. */
export interface GenerateAnswerGuidanceInput {
  /** Candidate-visible question stem ONLY — never the answer key. Built by the
   *  question-bank service's answer-key-free deriver. */
  questionText: string;
  /** Question type — drives the per-type baseline hint (all 5 types supported). */
  questionType: "mcq" | "subjective" | "kql" | "scenario" | "log_analysis";
  /** Short topic label for light context (e.g. "alert-triage"). */
  topic: string;
  /** For structured logging only — not sent to the model. */
  questionId: string;
}

/** Output of generateAnswerGuidanceDraft(): the proposal + audit metadata. */
export interface GenerateAnswerGuidanceOutput {
  /** The generated candidate-facing hint (1..280 chars). NOT persisted here. */
  answerGuidance: string;
  /** Skill file SHA (8 hex chars). */
  skillSha: string;
  /** Prompt SHA (SHA256 of JSON.stringify(promptVars), first 8 hex chars). */
  promptSha: string;
  /** Model identifier from skill frontmatter. */
  model: string;
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
  /** Eval gate (E2): grading prompts changed since the last blessed eval; AI_EVAL_GATE=enforce blocks grading */
  EVAL_GATE: "AIG_EVAL_GATE",
  /** Schema-violation in `claude` stream-json output */
  SCHEMA_VIOLATION: "AIG_SCHEMA_VIOLATION",
  /**
   * Stage 1 (`submit_anchors`) payload failed validation even after tolerant
   * coercion — the runtime degraded to `anchors=[]` and let Stage 2 run
   * holistically (rather than hard-failing the whole question). The resulting
   * proposal has anchor-weight × 0 in its score, so the band verdict alone
   * carries the grade. Admin must Re-run or Override to recover full anchor
   * evidence. Set by claude-code-vps.ts after Stage 2 produces a band.
   * Phase 3 Bug B fix, 2026-05-28.
   */
  STAGE1_DEGRADED: "AIG_STAGE1_DEGRADED",
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
  /**
   * Release blocked: the attempt's candidate has been DPDP/GDPR-erased
   * (users.erased_at IS NOT NULL). Releasing would email a dead tombstone
   * address and — via issueCertificateOnRelease — mint a fresh certificate
   * for a "forgotten" candidate. Fail-closed at the release gate. 2026-05-30.
   */
  ATTEMPT_NOT_RELEASABLE_ERASED: "AIG_ATTEMPT_NOT_RELEASABLE_ERASED",
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
  /**
   * SP1 (2026-10-01): the attempt is already 'released' — a published result is
   * final, so override / manual score are refused (409). Wire value is the bare
   * name from the build spec (not AIG_-prefixed).
   */
  RESULT_ALREADY_PUBLISHED: "RESULT_ALREADY_PUBLISHED",
  /** Manual first score refused: the question already has an effective grading (override it instead). */
  QUESTION_ALREADY_GRADED: "AIG_QUESTION_ALREADY_GRADED",
  /**
   * Phase II (2026-10-01): AI evaluation is run only by AssessIQ staff (the
   * platform super admin, from the platform evaluation queue). The tenant routes
   * grade / accept / rerun / manual-score / grading-jobs retry answer 403 with
   * this code for every caller. Wire value is the bare name from the build spec.
   */
  AI_EVALUATION_BY_ASSESSIQ: "AI_EVALUATION_BY_ASSESSIQ",
  /**
   * 409: a tenant action that needs a released evaluation (override, send-back)
   * was attempted while the platform has not released it to the tenant yet.
   */
  EVALUATION_NOT_RELEASED: "EVALUATION_NOT_RELEASED",
  /** 409: release-to-tenant refused — not graded yet, or a grade is still flagged for review. */
  EVALUATION_NOT_COMPLETE: "EVALUATION_NOT_COMPLETE",
  /** 409: release-to-tenant on an evaluation that is already with the tenant. */
  EVALUATION_ALREADY_RELEASED: "EVALUATION_ALREADY_RELEASED",
  /** Eval harness: case ID format invalid */
  INVALID_EVAL_CASE: "AIG_INVALID_EVAL_CASE",
} as const;

export type AiGradingErrorCode =
  (typeof AI_GRADING_ERROR_CODES)[keyof typeof AI_GRADING_ERROR_CODES];

// ---------------------------------------------------------------------------
// RuntimeFailureDetails — typed shape for AppError.details on RUNTIME_FAILURE
// ---------------------------------------------------------------------------

/**
 * Typed details attached to AppError when AI_GRADING_ERROR_CODES.RUNTIME_FAILURE
 * is thrown by the claude-code-vps runtime.  Cast to this shape when extracting
 * stderrTail in handler code.
 */
export interface RuntimeFailureDetails {
  skill?: string;
  attemptId?: string;
  exitCode?: number | null;
  /** Last ≤1024 bytes of the subprocess stderr. Present only for generation
   *  skills (privacy gate: grading skill stderr is never persisted). */
  stderrTail?: string;
}
