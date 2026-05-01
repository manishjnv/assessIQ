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
  // ai stub (decision #11)
  generateDraft,
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
  // domain types
  QuestionType,
  QuestionStatus,
  PackStatus,
  QuestionPack,
  Level,
  Question,
  QuestionVersion,
  Tag,
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

// ---------------------------------------------------------------------------
// 3. Route registrar
// ---------------------------------------------------------------------------

export { registerQuestionBankRoutes } from "./routes.js";
export type { RegisterQuestionBankRoutesOptions } from "./routes.js";
