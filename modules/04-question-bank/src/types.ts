import { z } from "zod";

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
// Rubric schema — required for subjective and scenario; null for others
// (data-model lines 289-306)
// anchor_weight_total + reasoning_weight_total must equal 100.
// ---------------------------------------------------------------------------

const AnchorSchema = z.object({
  id: z.string().min(1),
  concept: z.string().min(1),
  weight: z.number().int().min(0).max(100),
  synonyms: z.array(z.string().min(1)).min(1),
}).strict();

export const RubricSchema = z.object({
  anchors: z.array(AnchorSchema).min(1),
  reasoning_bands: z.object({
    band_4: z.string(),
    band_3: z.string(),
    band_2: z.string(),
    band_1: z.string(),
    band_0: z.string(),
  }).strict(),
  anchor_weight_total: z.number().int().min(0).max(100),
  reasoning_weight_total: z.number().int().min(0).max(100),
}).strict()
  .refine(
    (r) => r.anchor_weight_total + r.reasoning_weight_total === 100,
    { message: "anchor_weight_total + reasoning_weight_total must equal 100" },
  );

export type Rubric = z.infer<typeof RubricSchema>;

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
// Domain types — mapped from DB rows
// ---------------------------------------------------------------------------

export type PackStatus = "draft" | "published" | "archived";
export type QuestionStatus = "draft" | "active" | "archived";

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
  created_by: string;
  created_at: Date;
  updated_at: Date;
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
  page?: number;
  pageSize?: number;
}

export interface CreatePackInput {
  slug: string;         // [a-z0-9-]+ between 3 and 80 chars
  name: string;
  domain: string;
  description?: string;
}

export interface AddLevelInput {
  position: number;
  label: string;
  description?: string;
  duration_minutes: number;
  default_question_count: number;
  passing_score_pct?: number;
}

export interface UpdateLevelPatch {
  label?: string;
  description?: string | null;
  duration_minutes?: number;
  default_question_count?: number;
  passing_score_pct?: number;
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
}

export interface CreateQuestionInput {
  pack_id: string;
  level_id: string;
  type: QuestionType;
  topic: string;
  points: number;
  content: unknown;       // validated against per-type schema in service
  rubric?: unknown;       // required for subjective/scenario
  tags?: string[];        // tag names
}

export interface UpdateQuestionPatch {
  topic?: string;
  points?: number;
  status?: QuestionStatus;
  content?: unknown;
  rubric?: unknown | null;
  tags?: string[];
}

export interface PaginatedPacks {
  items: QuestionPack[];
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
} as const;

export type QbErrorCode = typeof QB_ERROR_CODES[keyof typeof QB_ERROR_CODES];
