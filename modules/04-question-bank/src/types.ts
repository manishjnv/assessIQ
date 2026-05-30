import { z } from "zod";
import {
  AnchorSchema,
  RubricSchema,
  type Anchor,
  type Rubric,
} from "@assessiq/rubric-engine";

// Phase 2 G2.B Session 2: rubric DSL canonical home is @assessiq/rubric-engine
// per PHASE_2_KICKOFF.md § P2.D12. Re-exported from 04 so existing consumers
// (`import { RubricSchema } from '@assessiq/question-bank'`) keep working
// without churn.
export {
  AnchorSchema,
  RubricSchema,
  type Anchor,
  type Rubric,
};

// ---------------------------------------------------------------------------
// Question-content schemas — one per type, keyed to docs/02-data-model.md
// § "questions.content shapes by type"
// ---------------------------------------------------------------------------

// MCQ (data-model lines 273-281)
// correct is an index into options; superRefine guards the upper bound.
export const McqContentSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string().min(1)).min(2).max(8),
  correct: z.number().int().min(0),
  rationale: z.string().min(1),
}).strict()
  .superRefine((val, ctx) => {
    if (val.correct >= val.options.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["correct"],
        message: "correct must be a valid index into options",
      });
    }
  });

export type McqContent = z.infer<typeof McqContentSchema>;

// Subjective (data-model lines 284-288)
// rubric lives in the separate column — not embedded in content.
export const SubjectiveContentSchema = z.object({
  question: z.string().min(1),
}).strict();

export type SubjectiveContent = z.infer<typeof SubjectiveContentSchema>;

// KQL (data-model lines 308-320)
export const KqlContentSchema = z.object({
  question: z.string().min(1),
  tables: z.array(z.string().min(1)).min(1),
  hint: z.string().optional(),
  expected_keywords: z.array(z.string().min(1)).min(1),
  sample_solution: z.string().optional(),
}).strict();

export type KqlContent = z.infer<typeof KqlContentSchema>;

// Scenario — multi-step incident chain (data-model lines 322-334)
// Each step is a discriminated union on "type".
const ScenarioStepSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().min(1),
    type: z.literal("mcq"),
    prompt: z.string().min(1),
    options: z.array(z.string().min(1)).min(2),
    correct: z.number().int().min(0),
    trap: z.boolean().optional(),
  }).strict(),
  z.object({
    id: z.string().min(1),
    type: z.literal("subjective"),
    prompt: z.string().min(1),
    rubric_ref: z.string().optional(),
  }).strict(),
  z.object({
    id: z.string().min(1),
    type: z.literal("kql"),
    prompt: z.string().min(1),
    expected_keywords: z.array(z.string().min(1)).min(1),
  }).strict(),
]);

export const ScenarioContentSchema = z.object({
  title: z.string().min(1),
  intro: z.string().min(1),
  steps: z.array(ScenarioStepSchema).min(1),
  step_dependency: z.enum(["linear", "parallel"]),
}).strict();

export type ScenarioContent = z.infer<typeof ScenarioContentSchema>;

// Log_analysis (data-model lines 337-354)
// Mirrors KQL shape: log_excerpt replaces tables, expected_findings replaces
// expected_keywords. log_format drives the candidate UI syntax viewer.
export const LogAnalysisContentSchema = z.object({
  question: z.string().min(1),
  log_excerpt: z.string().min(1),
  log_format: z.enum(["syslog", "json", "csv", "freeform"]),
  expected_findings: z.array(z.string().min(1)).min(1),
  hint: z.string().optional(),
  sample_solution: z.string().optional(),
}).strict();

export type LogAnalysisContent = z.infer<typeof LogAnalysisContentSchema>;

// ---------------------------------------------------------------------------
// Per-type union dispatcher
// ---------------------------------------------------------------------------

export const QUESTION_TYPES = [
  "mcq",
  "subjective",
  "kql",
  "scenario",
  "log_analysis",
] as const;

export type QuestionType = typeof QUESTION_TYPES[number];

const CONTENT_SCHEMA_MAP = {
  mcq: McqContentSchema,
  subjective: SubjectiveContentSchema,
  kql: KqlContentSchema,
  scenario: ScenarioContentSchema,
  log_analysis: LogAnalysisContentSchema,
} as const satisfies Record<QuestionType, z.ZodTypeAny>;

export function validateQuestionContent(
  type: QuestionType,
  content: unknown,
):
  | { ok: true; data: McqContent | SubjectiveContent | KqlContent | ScenarioContent | LogAnalysisContent }
  | { ok: false; errors: z.ZodIssue[] } {
  const result = CONTENT_SCHEMA_MAP[type].safeParse(content);
  if (result.success) {
    return { ok: true, data: result.data as McqContent | SubjectiveContent | KqlContent | ScenarioContent | LogAnalysisContent };
  }
  return { ok: false, errors: result.error.issues };
}

export function rubricRequiredFor(type: QuestionType): boolean {
  return type === "subjective" || type === "scenario";
}

export function validateRubric(
  content: unknown,
):
  | { ok: true; data: Rubric }
  | { ok: false; errors: z.ZodIssue[] } {
  const result = RubricSchema.safeParse(content);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return { ok: false, errors: result.error.issues };
}

// ---------------------------------------------------------------------------
// LevelRubricDefaults — calibration hints stored in levels.rubric_defaults
// ---------------------------------------------------------------------------
//
// When admin sets a profile on a level, the AI rubric generator uses it to
// bias its output (more anchors, stricter band-4 bar, denser language).
// NULL → generator falls back to ordinal-only calibration.

export const LevelRubricDefaultsSchema = z.object({
  profile: z.enum(["foundational", "practitioner", "expert"]),
  anchorComplexity: z.enum(["short", "medium", "dense"]),
  bandStrictness: z.enum(["lenient", "standard", "strict"]),
}).strict();

export type LevelRubricDefaults = z.infer<typeof LevelRubricDefaultsSchema>;

export function validateLevelRubricDefaults(
  content: unknown,
): { ok: true; data: LevelRubricDefaults } | { ok: false; errors: z.ZodIssue[] } {
  const result = LevelRubricDefaultsSchema.safeParse(content);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, errors: result.error.issues };
}

// ---------------------------------------------------------------------------
// Domain types — mapped from DB rows
// ---------------------------------------------------------------------------

export type PackStatus = "draft" | "published" | "archived";
/**
 * 'ai_draft' — generated by the AI question generator, pending admin review.
 * Admin must promote to 'draft' before candidates can see the question.
 * Distinct from 'draft' so the admin queue can filter AI-generated vs
 * human-authored drafts without an extra column.
 */
export type QuestionStatus = "draft" | "active" | "archived" | "ai_draft";

export interface QuestionPack {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  domain: string;
  description: string | null;
  status: PackStatus;
  version: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface Level {
  id: string;
  pack_id: string;
  position: number;
  label: string;
  description: string | null;
  duration_minutes: number;
  default_question_count: number;
  passing_score_pct: number;
  /** Calibration hints for the AI rubric generator. NULL = ordinal-only calibration. */
  rubric_defaults: LevelRubricDefaults | null;
}

/**
 * A single entry from the SOC knowledge base embedded in the generator prompt.
 * Mirrors the shape of soc-l{1,2,3}.json entries so the admin UI can render
 * source-citation chips on ai_draft question cards.
 */
export interface KnowledgeBaseSource {
  id: string;
  name: string;
  citation: string;
  url: string;
  level_fit: "L1" | "L2" | "L3";
  function: string;
  kb_version: string;
}

export interface Question {
  id: string;
  pack_id: string;
  level_id: string;
  type: QuestionType;
  topic: string;
  points: number;
  status: QuestionStatus;
  version: number;
  content: unknown;       // validated via validateQuestionContent
  rubric: unknown | null;
  /**
   * Candidate-facing answer-format hint ("HOW to answer"). Instructional and
   * candidate-safe — never a rubric/answer key. NULL → a per-type default is
   * applied at serve time (module 06). Live-read like topic/points: editing it
   * is a metadata change with no version bump and it is NOT snapshotted.
   */
  answer_guidance: string | null;
  /** Sources from the SOC KB used when generating this question. Empty for human-authored questions. */
  knowledge_base_sources: KnowledgeBaseSource[];
  /**
   * Human-readable level code (e.g. "L1"/"L2"/"L3"), resolved from the parent
   * level row. Populated only by list projections that join it (listQuestionRows);
   * undefined on single-question reads that do not select it. Read-only display
   * convenience — not a stored column on `questions`.
   */
  level_label?: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  /** Domain tag — set for AI-generated questions, null for human-authored. Added Slice 2.2/D5. */
  domain_id: string | null;
  /** Category tag — set for AI-generated questions, null for human-authored. Added Slice 2.2/D5. */
  category_id: string | null;
}

export interface QuestionVersion {
  id: string;
  question_id: string;
  version: number;
  content: unknown;
  rubric: unknown | null;
  saved_by: string;
  saved_at: Date;
}

export interface Tag {
  id: string;
  tenant_id: string;
  name: string;
  category: string | null;
}

// ---------------------------------------------------------------------------
// Service-input types
// ---------------------------------------------------------------------------

export interface ListPacksInput {
  domain?: string;
  status?: PackStatus;
  /** Case-insensitive substring match on pack name OR slug. */
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface CreatePackInput {
  slug?: string;        // optional — auto-generated from name when omitted; [a-z0-9-]+ 3-80 chars when provided
  name: string;
  domain: string;
  description?: string;
}

export interface AddLevelInput {
  position?: number;               // auto-assigned as max(position)+1 when omitted
  label: string;
  description?: string;
  duration_minutes?: number;        // defaults to 30 when omitted
  default_question_count?: number;  // defaults to 10 when omitted
  passing_score_pct?: number;
}

export interface UpdateLevelPatch {
  label?: string;
  description?: string | null;
  duration_minutes?: number;
  default_question_count?: number;
  passing_score_pct?: number;
  rubric_defaults?: LevelRubricDefaults | null;
}

export interface ListQuestionsInput {
  pack_id?: string;
  level_id?: string;
  type?: QuestionType;
  status?: QuestionStatus;
  tag?: string;         // tag NAME, not id
  search?: string;      // case-insensitive prefix on topic
  page?: number;
  pageSize?: number;
  /** Filter by domain UUID — read-only, RLS-scoped. Added Slice 2.2/D5. */
  domain_id?: string;
  /** Filter by category UUID — read-only, RLS-scoped. Added Slice 2.2/D5. */
  category_id?: string;
}

export interface CreateQuestionInput {
  pack_id: string;
  level_id: string;
  type: QuestionType;
  topic: string;
  points: number;
  content: unknown;       // validated against per-type schema in service
  rubric?: unknown;       // required for subjective/scenario
  /** Optional candidate-facing answer-format hint. Empty/whitespace → stored as NULL (per-type default applies). */
  answer_guidance?: string;
  tags?: string[];        // tag names
}

export interface UpdateQuestionPatch {
  topic?: string;
  points?: number;
  status?: QuestionStatus;
  content?: unknown;
  rubric?: unknown | null;
  /** Metadata-only change (no version bump). `null` clears it back to the per-type default. */
  answer_guidance?: string | null;
  tags?: string[];
}

/**
 * A pack as returned by the list endpoint — the base pack row plus two derived
 * counts the admin Question Bank grid renders as sortable columns.
 */
export interface PackListItem extends QuestionPack {
  /** Number of questions in this pack, all statuses. */
  question_count: number;
  /** Number of levels (e.g. L1/L2/L3) defined in this pack. */
  level_count: number;
  /**
   * Times a candidate in the current tenant finished an assessment built on
   * this pack. Counts attempts in a completed state: submitted, auto_submitted,
   * pending_admin_grading, graded, or released. Excludes draft/in_progress/
   * cancelled. RLS scopes the count to the current tenant.
   */
  completed_count: number;
}

export interface PaginatedPacks {
  items: PackListItem[];
  page: number;
  pageSize: number;
  total: number;
}

export interface PaginatedQuestions {
  items: Question[];
  page: number;
  pageSize: number;
  total: number;
}

// ---------------------------------------------------------------------------
// Importer types — Zod for runtime validation of the JSON import file
// ---------------------------------------------------------------------------

export const PackImportSchema = z.object({
  $schema: z.string().optional(),
  pack: z.object({
    slug: z.string().regex(/^[a-z0-9-]{3,80}$/),
    name: z.string().min(1),
    domain: z.string().min(1),
    description: z.string().optional(),
  }).strict(),
  levels: z.array(
    z.object({
      position: z.number().int().min(1),
      label: z.string().min(1),
      description: z.string().optional(),
      duration_minutes: z.number().int().min(1),
      default_question_count: z.number().int().min(1),
      passing_score_pct: z.number().int().min(0).max(100).optional(),
    }).strict(),
  ).min(1),
  questions: z.array(
    z.object({
      level_position: z.number().int().min(1),
      type: z.enum(QUESTION_TYPES),
      topic: z.string().min(1),
      points: z.number().int().min(1),
      content: z.unknown(),
      rubric: z.unknown().nullable().optional(),
      tags: z.array(z.string().min(1)).optional(),
    }).strict(),
  ).min(1),
}).strict();

export type PackImport = z.infer<typeof PackImportSchema>;

export interface ImportReport {
  packId: string;
  packSlug: string;
  packVersion: number;
  levelsCreated: number;
  questionsCreated: number;
  tagsCreated: number;
  tagsReused: number;
}

// ---------------------------------------------------------------------------
// Error code constants
// ---------------------------------------------------------------------------

export const QB_ERROR_CODES = {
  PACK_NOT_FOUND: "PACK_NOT_FOUND",
  PACK_SLUG_EXISTS: "PACK_SLUG_EXISTS",
  PACK_NOT_DRAFT: "PACK_NOT_DRAFT",
  PACK_NOT_PUBLISHED: "PACK_NOT_PUBLISHED",
  PACK_ALREADY_ARCHIVED: "PACK_ALREADY_ARCHIVED",
  PACK_HAS_ASSESSMENTS: "PACK_HAS_ASSESSMENTS",
  LEVEL_NOT_FOUND: "LEVEL_NOT_FOUND",
  LEVEL_POSITION_EXISTS: "LEVEL_POSITION_EXISTS",
  QUESTION_NOT_FOUND: "QUESTION_NOT_FOUND",
  QUESTION_PACK_ARCHIVED: "QUESTION_PACK_ARCHIVED",
  INVALID_CONTENT: "INVALID_CONTENT",
  INVALID_RUBRIC: "INVALID_RUBRIC",
  RUBRIC_REQUIRED: "RUBRIC_REQUIRED",
  RUBRIC_NOT_ALLOWED: "RUBRIC_NOT_ALLOWED",
  IMPORT_VALIDATION_FAILED: "IMPORT_VALIDATION_FAILED",
  IMPORT_LEVEL_REF_INVALID: "IMPORT_LEVEL_REF_INVALID",
  VERSION_NOT_FOUND: "VERSION_NOT_FOUND",
  GENERATE_DRAFT_DEFERRED: "GENERATE_DRAFT_DEFERRED",
  INVALID_PAGE_SIZE: "INVALID_PAGE_SIZE",
  NO_DRAFT_QUESTIONS_TO_ACTIVATE: "NO_DRAFT_QUESTIONS_TO_ACTIVATE",
  INVALID_NAME_FOR_SLUG: "INVALID_NAME_FOR_SLUG",
  INVALID_TOPIC: "INVALID_TOPIC",
  INVALID_BULK_SIZE: "INVALID_BULK_SIZE",
  INVALID_STATUS_TRANSITION: "INVALID_STATUS_TRANSITION",
  UNSUPPORTED_TYPE_FOR_RUBRIC: "UNSUPPORTED_TYPE_FOR_RUBRIC",
} as const;

export type QbErrorCode = typeof QB_ERROR_CODES[keyof typeof QB_ERROR_CODES];
