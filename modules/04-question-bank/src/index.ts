// AssessIQ — modules/04-question-bank public surface.
//
// Three categories of exports:
//   1. Service functions — the public API per modules/04-question-bank/SKILL.md
//      § "Public surface". Used by apps/api routes and tools/aiq-import-pack.ts.
//   2. Types and schemas — for callers that need to validate inputs or
//      describe shapes (the importer schema, content/rubric Zod schemas, the
//      QB_ERROR_CODES constants).
//   3. Route registrar — the Fastify plugin that mounts the 15 admin
//      endpoints. Lives co-located with the service so the route auth gates,
//      body shapes, and service contract evolve together.

// ---------------------------------------------------------------------------
// 1. Service functions
// ---------------------------------------------------------------------------

export {
  // pack ops
  listPacks,
  createPack,
  getPack,
  getPackWithLevels,
  updatePack,
  publishPack,
  archivePack,
  activateAllQuestionsForPack,
  // level ops
  addLevel,
  updateLevel,
  // question ops
  listQuestions,
  getQuestion,
  createQuestion,
  updateQuestion,
  listVersions,
  restoreVersion,
  // bulk import
  bulkImport,
  // ai question generation
  generateQuestions,
  // ai rubric generation
  generateRubricForQuestion,
  saveRubric,
  bulkGenerateMissingRubrics,
} from "./service.js";

// ---------------------------------------------------------------------------
// 2. Types and schemas
// ---------------------------------------------------------------------------

export {
  // content schemas
  McqContentSchema,
  SubjectiveContentSchema,
  KqlContentSchema,
  ScenarioContentSchema,
  LogAnalysisContentSchema,
  // rubric
  RubricSchema,
  // level rubric defaults
  LevelRubricDefaultsSchema,
  validateLevelRubricDefaults,
  // dispatcher / helpers
  validateQuestionContent,
  validateRubric,
  rubricRequiredFor,
  // importer
  PackImportSchema,
  // constants
  QUESTION_TYPES,
  QB_ERROR_CODES,
} from "./types.js";

export type {
  // content types
  McqContent,
  SubjectiveContent,
  KqlContent,
  ScenarioContent,
  LogAnalysisContent,
  Rubric,
  // level calibration
  LevelRubricDefaults,
  // domain types
  QuestionType,
  QuestionStatus,
  PackStatus,
  QuestionPack,
  Level,
  Question,
  QuestionVersion,
  Tag,
  KnowledgeBaseSource,
  // service-input types
  ListPacksInput,
  CreatePackInput,
  AddLevelInput,
  UpdateLevelPatch,
  ListQuestionsInput,
  CreateQuestionInput,
  UpdateQuestionPatch,
  PaginatedPacks,
  PaginatedQuestions,
  // importer types
  PackImport,
  ImportReport,
  // error code union
  QbErrorCode,
} from "./types.js";

export type { BulkGenerateMissingRubricsResult } from "./service.js";

// Knowledge base exports (for admin-generate handler and UI)
export {
  SOC_KNOWLEDGE_BASE,
  SOC_KB_VERSION,
  SOC_KB_BY_ID,
  SOC_KB_BY_LEVEL,
  SOC_KB_FUNCTIONS,
  KbSourceSchema,
} from "./knowledge-base/index.js";
export type { KbSource } from "./knowledge-base/index.js";

// ---------------------------------------------------------------------------
// 3. Route registrar
// ---------------------------------------------------------------------------

export { registerQuestionBankRoutes } from "./routes.js";
export type { RegisterQuestionBankRoutesOptions } from "./routes.js";
