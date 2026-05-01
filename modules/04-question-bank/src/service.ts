/**
 * Service layer for module 04-question-bank.
 *
 * IMPORTANT — RLS-only scoping (same rule as 03-users):
 * All queries run through a PoolClient that has already received
 * `SET LOCAL ROLE assessiq_app` and `set_config('app.current_tenant', $tenantId, true)`
 * from withTenant(). Row-Level Security enforces tenant isolation at the Postgres layer.
 * Do NOT add redundant tenant_id WHERE filters in this file — that would mask RLS bugs.
 *
 * Transaction semantics:
 * withTenant wraps its callback in BEGIN / COMMIT so every multi-step operation
 * (publishPack, updateQuestion, restoreVersion, bulkImport) that runs inside a
 * single withTenant call is automatically a single database transaction.
 */

import {
  streamLogger,
  NotFoundError,
  ValidationError,
  ConflictError,
  AppError,
  uuidv7,
} from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import * as repo from "./repository.js";
import {
  validateQuestionContent,
  validateRubric,
  rubricRequiredFor,
  PackImportSchema,
  QB_ERROR_CODES,
} from "./types.js";
import type {
  AddLevelInput,
  CreatePackInput,
  CreateQuestionInput,
  ImportReport,
  Level,
  ListPacksInput,
  ListQuestionsInput,
  PaginatedPacks,
  PaginatedQuestions,
  Question,
  QuestionPack,
  QuestionType,
  QuestionVersion,
  UpdateLevelPatch,
  UpdateQuestionPatch,
} from "./types.js";

const log = streamLogger("app");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SLUG_REGEX = /^[a-z0-9-]{3,80}$/;
const MAX_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function assertValidSlug(slug: string): void {
  if (!SLUG_REGEX.test(slug)) {
    throw new ValidationError(
      `Pack slug must match /^[a-z0-9-]{3,80}$/: got '${slug}'`,
      { details: { code: QB_ERROR_CODES.IMPORT_VALIDATION_FAILED, field: "slug" } },
    );
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new ValidationError(
      `'${field}' must not be empty`,
      { details: { code: "MISSING_REQUIRED", field } },
    );
  }
}

function assertPageSize(pageSize: number): void {
  if (pageSize > MAX_PAGE_SIZE) {
    throw new ValidationError(
      `pageSize must not exceed ${MAX_PAGE_SIZE}`,
      { details: { code: QB_ERROR_CODES.INVALID_PAGE_SIZE, pageSize, max: MAX_PAGE_SIZE } },
    );
  }
}

/**
 * Translate a Postgres unique-violation (23505) to a ConflictError with the
 * given domain error code. Re-throws all other errors unchanged.
 */
function rethrowUnique(err: unknown, code: string, message: string): never {
  if (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  ) {
    throw new ConflictError(message, { details: { code } });
  }
  throw err;
}

/**
 * Validate content + rubric for a question type and throw typed ValidationErrors.
 * Used by both createQuestion and updateQuestion.
 */
function assertValidContent(type: QuestionType, content: unknown): void {
  const result = validateQuestionContent(type, content);
  if (!result.ok) {
    throw new ValidationError(
      `Invalid content for question type '${type}'`,
      { details: { code: QB_ERROR_CODES.INVALID_CONTENT, errors: result.errors } },
    );
  }
}

function assertValidRubric(rubric: unknown): void {
  const result = validateRubric(rubric);
  if (!result.ok) {
    throw new ValidationError(
      `Invalid rubric`,
      { details: { code: QB_ERROR_CODES.INVALID_RUBRIC, errors: result.errors } },
    );
  }
}

/**
 * Full rubric-gate: checks required/not-allowed, validates shape if present.
 * rubricValue is the incoming patch.rubric or input.rubric (may be undefined =
 * "not supplied", null = "explicitly cleared").
 */
function assertRubricGate(
  type: QuestionType,
  rubricValue: unknown,
  rubricSupplied: boolean,
): void {
  const required = rubricRequiredFor(type);
  if (required) {
    // rubric is required — null or absent is an error
    if (!rubricSupplied || rubricValue == null) {
      throw new ValidationError(
        `Rubric is required for question type '${type}'`,
        { details: { code: QB_ERROR_CODES.RUBRIC_REQUIRED, type } },
      );
    }
    assertValidRubric(rubricValue);
  } else {
    // rubric is NOT allowed — non-null value is an error
    if (rubricSupplied && rubricValue != null) {
      throw new ValidationError(
        `Rubric is not allowed for question type '${type}'`,
        { details: { code: QB_ERROR_CODES.RUBRIC_NOT_ALLOWED, type } },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// generateDraft stub factory
// ---------------------------------------------------------------------------

function notImplemented(message: string, code: string): AppError {
  return new AppError(message, code, 501, { details: { code, httpStatus: 501 } });
}

// ===========================================================================
// PACK OPERATIONS
// ===========================================================================

// ---------------------------------------------------------------------------
// listPacks
// ---------------------------------------------------------------------------

export async function listPacks(
  tenantId: string,
  filters: ListPacksInput = {},
): Promise<PaginatedPacks> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;

  assertPageSize(pageSize);

  return withTenant(tenantId, async (client) => {
    const { items, total } = await repo.listPackRows(client, {
      ...filters,
      page,
      pageSize,
    });
    return { items, page, pageSize, total };
  });
}

// ---------------------------------------------------------------------------
// createPack
// ---------------------------------------------------------------------------

export async function createPack(
  tenantId: string,
  input: CreatePackInput,
  createdByUserId: string,
): Promise<QuestionPack> {
  assertValidSlug(input.slug);
  assertNonEmpty(input.name, "name");
  assertNonEmpty(input.domain, "domain");

  const id = uuidv7();
  log.info({ tenantId, id, slug: input.slug }, "createPack");

  try {
    return await withTenant(tenantId, (client) =>
      repo.insertPack(client, {
        id,
        tenantId,
        slug: input.slug,
        name: input.name,
        domain: input.domain,
        ...(input.description !== undefined ? { description: input.description } : {}),
        createdBy: createdByUserId,
      }),
    );
  } catch (err: unknown) {
    rethrowUnique(
      err,
      QB_ERROR_CODES.PACK_SLUG_EXISTS,
      `A pack with slug '${input.slug}' already exists in this tenant.`,
    );
  }
}

// ---------------------------------------------------------------------------
// getPack
// ---------------------------------------------------------------------------

export async function getPack(tenantId: string, id: string): Promise<QuestionPack> {
  const pack = await withTenant(tenantId, (client) => repo.findPackById(client, id));
  if (pack === null) {
    throw new NotFoundError(`Pack not found: ${id}`, {
      details: { code: QB_ERROR_CODES.PACK_NOT_FOUND },
    });
  }
  return pack;
}

// ---------------------------------------------------------------------------
// getPackWithLevels — bundle pack + ordered levels in a single tenant scope
// ---------------------------------------------------------------------------
// docs/03-api-contract.md § Admin — Question bank: GET /admin/packs/:id returns
// "Pack with levels". Single withTenant round-trip; levels ordered by position.
export async function getPackWithLevels(
  tenantId: string,
  id: string,
): Promise<{ pack: QuestionPack; levels: Level[] }> {
  return withTenant(tenantId, async (client) => {
    const pack = await repo.findPackById(client, id);
    if (pack === null) {
      throw new NotFoundError(`Pack not found: ${id}`, {
        details: { code: QB_ERROR_CODES.PACK_NOT_FOUND },
      });
    }
    const levels = await repo.listLevelsByPack(client, id);
    return { pack, levels };
  });
}

// ---------------------------------------------------------------------------
// updatePack
// ---------------------------------------------------------------------------

export async function updatePack(
  tenantId: string,
  id: string,
  patch: { name?: string; domain?: string; description?: string },
): Promise<QuestionPack> {
  log.info({ tenantId, id }, "updatePack");

  return withTenant(tenantId, async (client) => {
    const current = await repo.findPackById(client, id);
    if (current === null) {
      throw new NotFoundError(`Pack not found: ${id}`, {
        details: { code: QB_ERROR_CODES.PACK_NOT_FOUND },
      });
    }

    // Build conditional patch — exactOptionalPropertyTypes: never pass undefined
    const repoPatch: Parameters<typeof repo.updatePackRow>[2] = {};
    if (patch.name !== undefined) repoPatch.name = patch.name;
    if (patch.domain !== undefined) repoPatch.domain = patch.domain;
    if (patch.description !== undefined) repoPatch.description = patch.description;

    return repo.updatePackRow(client, id, repoPatch);
  });
}

// ---------------------------------------------------------------------------
// publishPack
// ---------------------------------------------------------------------------

export async function publishPack(
  tenantId: string,
  id: string,
  savedByUserId: string,
): Promise<QuestionPack> {
  log.info({ tenantId, id }, "publishPack");

  return withTenant(tenantId, async (client) => {
    // 1. Read pack + verify status = 'draft'
    const pack = await repo.findPackById(client, id);
    if (pack === null) {
      throw new NotFoundError(`Pack not found: ${id}`, {
        details: { code: QB_ERROR_CODES.PACK_NOT_FOUND },
      });
    }
    if (pack.status !== "draft") {
      throw new ConflictError(
        `Pack '${id}' must be in 'draft' status to publish (current: '${pack.status}')`,
        { details: { code: QB_ERROR_CODES.PACK_NOT_DRAFT } },
      );
    }

    // 2. Fetch all questions in this pack
    const questions = await repo.listAllQuestionsForPack(client, id);

    // 3. Snapshot every question into question_versions, then bump the
    //    question's version. Bumping is necessary so a subsequent
    //    updateQuestion's snapshot-before-update rule lands on a NEW
    //    (question_id, version) pair instead of colliding with the snapshot
    //    we just inserted (UNIQUE constraint would otherwise reject the
    //    edit). Per decision #21: publish freezes the current state into a
    //    permanent snapshot row; subsequent edits add MORE rows. The bump
    //    treats publish as the implicit version-1-write.
    for (const q of questions) {
      await repo.insertQuestionVersion(client, {
        id: uuidv7(),
        questionId: q.id,
        version: q.version,
        content: q.content,
        rubric: q.rubric,
        savedBy: savedByUserId,
      });
      await repo.updateQuestionRow(client, q.id, { version: q.version + 1 });
    }

    // 4. Flip status to 'published', bump pack version (so next publish lands a new row)
    return repo.updatePackRow(client, id, { status: "published", version: pack.version + 1 });
  });
}

// ---------------------------------------------------------------------------
// archivePack
// ---------------------------------------------------------------------------

export async function archivePack(tenantId: string, id: string): Promise<QuestionPack> {
  log.info({ tenantId, id }, "archivePack");

  return withTenant(tenantId, async (client) => {
    const pack = await repo.findPackById(client, id);
    if (pack === null) {
      throw new NotFoundError(`Pack not found: ${id}`, {
        details: { code: QB_ERROR_CODES.PACK_NOT_FOUND },
      });
    }
    if (pack.status !== "published") {
      throw new ConflictError(
        `Pack '${id}' must be in 'published' status to archive (current: '${pack.status}')`,
        { details: { code: QB_ERROR_CODES.PACK_NOT_PUBLISHED } },
      );
    }

    // Gate: if the assessments table exists, block archive when assessments reference this pack
    const tableExists = await repo.hasAssessmentsTable(client);
    if (tableExists) {
      const count = await repo.countAssessmentsReferencingPack(client, id);
      if (count > 0) {
        throw new ConflictError(
          `Pack '${id}' is referenced by ${count} assessment(s) and cannot be archived`,
          { details: { code: QB_ERROR_CODES.PACK_HAS_ASSESSMENTS, count } },
        );
      }
    }

    return repo.updatePackRow(client, id, { status: "archived" });
  });
}

// ===========================================================================
// LEVEL OPERATIONS
// ===========================================================================

// ---------------------------------------------------------------------------
// addLevel
// ---------------------------------------------------------------------------

export async function addLevel(
  tenantId: string,
  packId: string,
  input: AddLevelInput,
): Promise<Level> {
  log.info({ tenantId, packId, position: input.position }, "addLevel");

  try {
    return await withTenant(tenantId, async (client) => {
      // Verify pack exists (RLS scopes the SELECT to this tenant)
      const pack = await repo.findPackById(client, packId);
      if (pack === null) {
        throw new NotFoundError(`Pack not found: ${packId}`, {
          details: { code: QB_ERROR_CODES.PACK_NOT_FOUND },
        });
      }

      return repo.insertLevel(client, {
        id: uuidv7(),
        packId,
        position: input.position,
        label: input.label,
        ...(input.description !== undefined ? { description: input.description } : {}),
        durationMinutes: input.duration_minutes,
        defaultQuestionCount: input.default_question_count,
        ...(input.passing_score_pct !== undefined ? { passingScorePct: input.passing_score_pct } : {}),
      });
    });
  } catch (err: unknown) {
    rethrowUnique(
      err,
      QB_ERROR_CODES.LEVEL_POSITION_EXISTS,
      `A level at position ${input.position} already exists in pack '${packId}'.`,
    );
  }
}

// ---------------------------------------------------------------------------
// updateLevel
// ---------------------------------------------------------------------------

export async function updateLevel(
  tenantId: string,
  levelId: string,
  patch: UpdateLevelPatch,
): Promise<Level> {
  log.info({ tenantId, levelId }, "updateLevel");

  return withTenant(tenantId, async (client) => {
    const current = await repo.findLevelById(client, levelId);
    if (current === null) {
      throw new NotFoundError(`Level not found: ${levelId}`, {
        details: { code: QB_ERROR_CODES.LEVEL_NOT_FOUND },
      });
    }

    // Conditionally build patch — exactOptionalPropertyTypes
    const repoPatch: Parameters<typeof repo.updateLevelRow>[2] = {};
    if (patch.label !== undefined) repoPatch.label = patch.label;
    if (patch.description !== undefined) repoPatch.description = patch.description;
    if (patch.duration_minutes !== undefined) repoPatch.duration_minutes = patch.duration_minutes;
    if (patch.default_question_count !== undefined) repoPatch.default_question_count = patch.default_question_count;
    if (patch.passing_score_pct !== undefined) repoPatch.passing_score_pct = patch.passing_score_pct;

    return repo.updateLevelRow(client, levelId, repoPatch);
  });
}

// ===========================================================================
// QUESTION OPERATIONS
// ===========================================================================

// ---------------------------------------------------------------------------
// listQuestions
// ---------------------------------------------------------------------------

export async function listQuestions(
  tenantId: string,
  filters: ListQuestionsInput = {},
): Promise<PaginatedQuestions> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;

  assertPageSize(pageSize);

  return withTenant(tenantId, async (client) => {
    const { items, total } = await repo.listQuestionRows(client, {
      ...filters,
      page,
      pageSize,
    });
    return { items, page, pageSize, total };
  });
}

// ---------------------------------------------------------------------------
// getQuestion
// ---------------------------------------------------------------------------

export async function getQuestion(tenantId: string, id: string): Promise<Question> {
  const question = await withTenant(tenantId, (client) => repo.findQuestionById(client, id));
  if (question === null) {
    throw new NotFoundError(`Question not found: ${id}`, {
      details: { code: QB_ERROR_CODES.QUESTION_NOT_FOUND },
    });
  }
  return question;
}

// ---------------------------------------------------------------------------
// createQuestion
// ---------------------------------------------------------------------------

export async function createQuestion(
  tenantId: string,
  input: CreateQuestionInput,
  createdByUserId: string,
): Promise<Question> {
  // Validate content shape before touching the DB
  assertValidContent(input.type, input.content);
  // Validate rubric gate
  assertRubricGate(input.type, input.rubric, "rubric" in input);

  const id = uuidv7();
  log.info({ tenantId, id, packId: input.pack_id, type: input.type }, "createQuestion");

  return withTenant(tenantId, async (client) => {
    // Verify pack exists and is not archived
    const pack = await repo.findPackById(client, input.pack_id);
    if (pack === null) {
      throw new NotFoundError(`Pack not found: ${input.pack_id}`, {
        details: { code: QB_ERROR_CODES.PACK_NOT_FOUND },
      });
    }
    if (pack.status === "archived") {
      throw new ConflictError(
        `Cannot add questions to archived pack '${input.pack_id}'`,
        { details: { code: QB_ERROR_CODES.QUESTION_PACK_ARCHIVED } },
      );
    }

    // Verify level exists within the tenant (RLS scopes the SELECT)
    const level = await repo.findLevelById(client, input.level_id);
    if (level === null) {
      throw new NotFoundError(`Level not found: ${input.level_id}`, {
        details: { code: QB_ERROR_CODES.LEVEL_NOT_FOUND },
      });
    }

    // Insert question (status defaults to 'draft' and version to 1 in DB schema)
    const question = await repo.insertQuestion(client, {
      id,
      packId: input.pack_id,
      levelId: input.level_id,
      type: input.type,
      topic: input.topic,
      points: input.points,
      content: input.content,
      ...(input.rubric !== undefined ? { rubric: input.rubric } : {}),
      createdBy: createdByUserId,
    });

    // Attach tags (upsert by name, then link)
    if (input.tags !== undefined && input.tags.length > 0) {
      for (const tagName of input.tags) {
        const { tag } = await repo.upsertTag(client, { id: uuidv7(), tenantId, name: tagName });
        await repo.attachTagToQuestion(client, question.id, tag.id);
      }
    }

    return question;
  });
}

// ---------------------------------------------------------------------------
// updateQuestion
// ---------------------------------------------------------------------------

export async function updateQuestion(
  tenantId: string,
  id: string,
  patch: UpdateQuestionPatch,
  savedByUserId: string,
): Promise<Question> {
  log.info({ tenantId, id }, "updateQuestion");

  return withTenant(tenantId, async (client) => {
    // 1. Read current question
    const current = await repo.findQuestionById(client, id);
    if (current === null) {
      throw new NotFoundError(`Question not found: ${id}`, {
        details: { code: QB_ERROR_CODES.QUESTION_NOT_FOUND },
      });
    }

    // 2. Verify pack not archived
    const pack = await repo.findPackById(client, current.pack_id);
    if (pack === null) {
      // Shouldn't happen — data integrity — but guard it
      throw new NotFoundError(`Pack not found: ${current.pack_id}`, {
        details: { code: QB_ERROR_CODES.PACK_NOT_FOUND },
      });
    }
    if (pack.status === "archived") {
      throw new ConflictError(
        `Cannot update questions in archived pack '${current.pack_id}'`,
        { details: { code: QB_ERROR_CODES.QUESTION_PACK_ARCHIVED } },
      );
    }

    // 3. Validate and snapshot if content/rubric is changing
    let versionBump = false;

    if (patch.content !== undefined) {
      assertValidContent(current.type, patch.content);
      versionBump = true;
    }

    if (patch.rubric !== undefined) {
      // patch.rubric is present (even if null = "clear it")
      const incoming = patch.rubric;
      const required = rubricRequiredFor(current.type);
      if (required && incoming == null) {
        throw new ValidationError(
          `Rubric is required for question type '${current.type}'`,
          { details: { code: QB_ERROR_CODES.RUBRIC_REQUIRED, type: current.type } },
        );
      }
      if (!required && incoming != null) {
        throw new ValidationError(
          `Rubric is not allowed for question type '${current.type}'`,
          { details: { code: QB_ERROR_CODES.RUBRIC_NOT_ALLOWED, type: current.type } },
        );
      }
      if (incoming != null) {
        assertValidRubric(incoming);
      }
      versionBump = true;
    }

    if (versionBump) {
      // Snapshot old values BEFORE bumping
      await repo.insertQuestionVersion(client, {
        id: uuidv7(),
        questionId: current.id,
        version: current.version,
        content: current.content,
        rubric: current.rubric,
        savedBy: savedByUserId,
      });
    }

    // 4. Replace tag set if patch.tags supplied
    if (patch.tags !== undefined) {
      await repo.detachAllTagsFromQuestion(client, id);
      for (const tagName of patch.tags) {
        const { tag } = await repo.upsertTag(client, { id: uuidv7(), tenantId, name: tagName });
        await repo.attachTagToQuestion(client, id, tag.id);
      }
    }

    // 5. Apply update (conditional patch — exactOptionalPropertyTypes)
    const repoPatch: Parameters<typeof repo.updateQuestionRow>[2] = {};
    if (patch.topic !== undefined) repoPatch.topic = patch.topic;
    if (patch.points !== undefined) repoPatch.points = patch.points;
    if (patch.status !== undefined) repoPatch.status = patch.status;
    if (patch.content !== undefined) repoPatch.content = patch.content;
    if (patch.rubric !== undefined) repoPatch.rubric = patch.rubric;
    if (versionBump) repoPatch.version = current.version + 1;

    return repo.updateQuestionRow(client, id, repoPatch);
  });
}

// ---------------------------------------------------------------------------
// listVersions
// ---------------------------------------------------------------------------

export async function listVersions(
  tenantId: string,
  questionId: string,
): Promise<QuestionVersion[]> {
  return withTenant(tenantId, async (client) => {
    // Guard: ensure question exists (a miss would otherwise silently return [])
    const question = await repo.findQuestionById(client, questionId);
    if (question === null) {
      throw new NotFoundError(`Question not found: ${questionId}`, {
        details: { code: QB_ERROR_CODES.QUESTION_NOT_FOUND },
      });
    }
    return repo.listQuestionVersions(client, questionId);
  });
}

// ---------------------------------------------------------------------------
// restoreVersion
// ---------------------------------------------------------------------------

export async function restoreVersion(
  tenantId: string,
  questionId: string,
  version: number,
  savedByUserId: string,
): Promise<Question> {
  log.info({ tenantId, questionId, version }, "restoreVersion");

  return withTenant(tenantId, async (client) => {
    // Find the target version snapshot
    const target = await repo.findQuestionVersion(client, questionId, version);
    if (target === null) {
      throw new NotFoundError(
        `Version ${version} of question '${questionId}' not found`,
        { details: { code: QB_ERROR_CODES.VERSION_NOT_FOUND } },
      );
    }

    // Find current question
    const current = await repo.findQuestionById(client, questionId);
    if (current === null) {
      throw new NotFoundError(`Question not found: ${questionId}`, {
        details: { code: QB_ERROR_CODES.QUESTION_NOT_FOUND },
      });
    }

    // Snapshot current values before overwriting
    await repo.insertQuestionVersion(client, {
      id: uuidv7(),
      questionId: current.id,
      version: current.version,
      content: current.content,
      rubric: current.rubric,
      savedBy: savedByUserId,
    });

    // Restore: apply target content/rubric and bump version
    return repo.updateQuestionRow(client, questionId, {
      content: target.content,
      rubric: target.rubric,
      version: current.version + 1,
    });
  });
}

// ---------------------------------------------------------------------------
// bulkImport
// ---------------------------------------------------------------------------

export async function bulkImport(
  tenantId: string,
  fileBuffer: Buffer,
  format: "json" | "csv",
  createdByUserId: string,
): Promise<ImportReport> {
  // Phase 1 is JSON-only — CSV deferred per decision #4/#13
  if (format !== "json") {
    throw new ValidationError(
      "csv deferred to phase 2 — use json",
      { details: { code: QB_ERROR_CODES.IMPORT_VALIDATION_FAILED, format } },
    );
  }

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileBuffer.toString("utf8"));
  } catch (e: unknown) {
    throw new ValidationError(
      "Failed to parse import file as JSON",
      {
        details: {
          code: QB_ERROR_CODES.IMPORT_VALIDATION_FAILED,
          parseError: e instanceof Error ? e.message : String(e),
        },
      },
    );
  }

  // Validate against PackImportSchema
  const schemaResult = PackImportSchema.safeParse(parsed);
  if (!schemaResult.success) {
    throw new ValidationError(
      "Import file does not match expected schema",
      {
        details: {
          code: QB_ERROR_CODES.IMPORT_VALIDATION_FAILED,
          zodErrors: schemaResult.error.issues,
        },
      },
    );
  }

  const importData = schemaResult.data;

  // Build a Set of valid level positions for reference validation
  const validLevelPositions = new Set(importData.levels.map((l) => l.position));

  // Pre-validate all questions before touching the DB (fail-fast before transaction)
  for (const q of importData.questions) {
    // Validate level_position reference
    if (!validLevelPositions.has(q.level_position)) {
      throw new ValidationError(
        `Question references level_position ${q.level_position} which is not defined in this import`,
        {
          details: {
            code: QB_ERROR_CODES.IMPORT_LEVEL_REF_INVALID,
            level_position: q.level_position,
          },
        },
      );
    }

    // Validate content
    assertValidContent(q.type, q.content);

    // Validate rubric — rubric field presence check
    const rubricSupplied = "rubric" in q && q.rubric !== undefined;
    const rubricValue = rubricSupplied ? q.rubric : undefined;
    assertRubricGate(q.type, rubricValue, rubricSupplied);
  }

  log.info(
    { tenantId, slug: importData.pack.slug, questions: importData.questions.length },
    "bulkImport",
  );

  // Single transaction: insert pack → levels → questions + tags
  return withTenant(tenantId, async (client) => {
    // 1. Insert pack
    const packId = uuidv7();
    let pack: QuestionPack;
    try {
      pack = await repo.insertPack(client, {
        id: packId,
        tenantId,
        slug: importData.pack.slug,
        name: importData.pack.name,
        domain: importData.pack.domain,
        ...(importData.pack.description !== undefined ? { description: importData.pack.description } : {}),
        createdBy: createdByUserId,
      });
    } catch (err: unknown) {
      rethrowUnique(
        err,
        QB_ERROR_CODES.PACK_SLUG_EXISTS,
        `A pack with slug '${importData.pack.slug}' already exists in this tenant.`,
      );
    }

    // 2. Insert levels — build position → levelId map
    const positionToLevelId = new Map<number, string>();
    for (const levelInput of importData.levels) {
      const levelId = uuidv7();
      await repo.insertLevel(client, {
        id: levelId,
        packId: pack.id,
        position: levelInput.position,
        label: levelInput.label,
        ...(levelInput.description !== undefined ? { description: levelInput.description } : {}),
        durationMinutes: levelInput.duration_minutes,
        defaultQuestionCount: levelInput.default_question_count,
        ...(levelInput.passing_score_pct !== undefined ? { passingScorePct: levelInput.passing_score_pct } : {}),
      });
      positionToLevelId.set(levelInput.position, levelId);
    }

    // 3. Insert questions + tags, tracking tag reuse
    let tagsCreated = 0;
    let tagsReused = 0;

    for (const qInput of importData.questions) {
      const levelId = positionToLevelId.get(qInput.level_position);
      // positionToLevelId is guaranteed to have this key — validated above
      if (levelId === undefined) {
        throw new ValidationError(
          `level_position ${qInput.level_position} missing from position map (internal error)`,
          { details: { code: QB_ERROR_CODES.IMPORT_LEVEL_REF_INVALID } },
        );
      }

      const question = await repo.insertQuestion(client, {
        id: uuidv7(),
        packId: pack.id,
        levelId,
        type: qInput.type,
        topic: qInput.topic,
        points: qInput.points,
        content: qInput.content,
        ...(qInput.rubric !== undefined && qInput.rubric !== null ? { rubric: qInput.rubric } : {}),
        createdBy: createdByUserId,
      });

      // Upsert tags — count created vs reused
      if (qInput.tags !== undefined && qInput.tags.length > 0) {
        for (const tagName of qInput.tags) {
          const { tag, created } = await repo.upsertTagWithStatus(client, {
            id: uuidv7(),
            tenantId,
            name: tagName,
          });
          await repo.attachTagToQuestion(client, question.id, tag.id);
          if (created) {
            tagsCreated++;
          } else {
            tagsReused++;
          }
        }
      }
    }

    return {
      packId: pack.id,
      packSlug: pack.slug,
      packVersion: pack.version,
      levelsCreated: importData.levels.length,
      questionsCreated: importData.questions.length,
      tagsCreated,
      tagsReused,
    };
  });
}

// ===========================================================================
// AI GENERATION STUB
// ===========================================================================

// ---------------------------------------------------------------------------
// generateDraft — Phase 2 deferred (decision #11)
// ---------------------------------------------------------------------------

export async function generateDraft(
  _tenantId: string,
  _input: { topic: string; type: QuestionType; level: string; count: number },
): Promise<Question[]> {
  throw notImplemented(
    "Phase 2: AI question generation lands with grading runtime",
    QB_ERROR_CODES.GENERATE_DRAFT_DEFERRED,
  );
}
