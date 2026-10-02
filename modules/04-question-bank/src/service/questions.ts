/**
 * Question, version, bulk-import and bulk-status operations (E9 split of service.ts).
 */

import {
  NotFoundError,
  ValidationError,
  ConflictError,
  uuidv7,
} from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import { rubricRequiredFor, PackImportSchema, QB_ERROR_CODES } from "../types.js";
import * as repo from "../repository.js";
import type {
  CreateQuestionInput,
  ImportReport,
  Level,
  ListQuestionsInput,
  PaginatedQuestions,
  Question,
  QuestionPack,
  QuestionVersion,
  UpdateQuestionPatch,
} from "../types.js";
import {
  log,
  assertPageSize,
  rethrowUnique,
  assertValidContent,
  assertValidRubric,
  assertRubricGate,
} from "./_shared.js";

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
  // Guard: topic is required (NOT NULL in DB) — defense-in-depth behind the
  // Fastify body schema on the route. Catches service-layer callers that omit it.
  // Same class as the 2026-05-03 slug/topic null-constraint incident (RCA).
  if (typeof input.topic !== "string" || input.topic.trim().length === 0) {
    throw new ValidationError("topic is required and must not be empty", {
      details: { code: QB_ERROR_CODES.INVALID_TOPIC },
    });
  }
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

    // Normalize the optional candidate hint: empty/whitespace → NULL so the
    // per-type default applies at serve time.
    const answerGuidance =
      typeof input.answer_guidance === "string" && input.answer_guidance.trim().length > 0
        ? input.answer_guidance.trim()
        : null;

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
      answerGuidance,
      createdBy: createdByUserId,
    });

    // Attach tags (upsert by name, then link)
    if (input.tags !== undefined && input.tags.length > 0) {
      for (const tagName of input.tags) {
        const { tag } = await repo.upsertTag(client, { id: uuidv7(), tenantId, name: tagName });
        await repo.attachTagToQuestion(client, question.id, tag.id);
      }
    }

    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: createdByUserId,
      action: "question.created",
      entityType: "question",
      entityId: question.id,
      after: {
        pack_id: question.pack_id,
        level_id: question.level_id,
        type: question.type,
        topic: question.topic,
        points: question.points,
        status: question.status,
        ...(input.tags !== undefined ? { tag_count: input.tags.length } : {}),
      },
    });

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
    // answer_guidance is metadata-only — like topic/points it does NOT trigger a
    // version bump and is NOT snapshotted. Empty/whitespace normalises to NULL
    // (per-type default applies); explicit null clears an authored value.
    if (patch.answer_guidance !== undefined) {
      repoPatch.answer_guidance =
        typeof patch.answer_guidance === "string" && patch.answer_guidance.trim().length > 0
          ? patch.answer_guidance.trim()
          : null;
    }
    if (versionBump) repoPatch.version = current.version + 1;

    const updated = await repo.updateQuestionRow(client, id, repoPatch);

    // Audit the field-level change. Avoid logging full content/rubric JSON
    // (potentially KBs) — record only which fields changed plus version bump.
    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: savedByUserId,
      action: "question.updated",
      entityType: "question",
      entityId: id,
      before: { version: current.version, status: current.status },
      after: {
        version: updated.version,
        status: updated.status,
        changed_fields: Object.keys(repoPatch),
        ...(patch.tags !== undefined ? { tags_replaced: true, tag_count: patch.tags.length } : {}),
      },
    });

    return updated;
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
    const updated = await repo.updateQuestionRow(client, questionId, {
      content: target.content,
      rubric: target.rubric,
      version: current.version + 1,
    });

    // restore is semantically a question.updated event with a marker so audit
    // consumers can distinguish "edit" from "restore from prior version".
    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: savedByUserId,
      action: "question.updated",
      entityType: "question",
      entityId: questionId,
      before: { version: current.version },
      after: {
        kind: "restore",
        version: updated.version,
        restored_from_version: version,
      },
    });

    return updated;
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
        domain: importData.pack.domain.trim().toLowerCase(),
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

    // Audit: one pack.created row + one question.imported summary row.
    // Per-question audit rows are intentionally NOT emitted — a 200-question
    // import would dump 200 audit rows that all duplicate the same actor,
    // pack, and timestamp. The summary row carries enough metadata for
    // forensic replay (counts + pack pointer).
    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: createdByUserId,
      action: "pack.created",
      entityType: "question_pack",
      entityId: pack.id,
      after: {
        kind: "import",
        slug: pack.slug,
        name: pack.name,
        domain: pack.domain,
        status: pack.status,
      },
    });

    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: createdByUserId,
      action: "question.imported",
      entityType: "question_pack",
      entityId: pack.id,
      after: {
        levels_created: importData.levels.length,
        questions_created: importData.questions.length,
        tags_created: tagsCreated,
        tags_reused: tagsReused,
      },
    });

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
// BULK QUESTION STATUS UPDATE
// ===========================================================================

/**
 * Transition a batch of questions to a new status in a single transaction.
 *
 * Allowed source → target transitions (mirrors the admin bulk-action allow-list
 * defined in docs/03-api-contract.md § "Bulk status update"):
 *   ai_draft → active
 *   ai_draft → archived
 *   draft    → archived
 *   active   → archived
 *
 * Forbidden: archived → active (re-activation is per-question for audit trail).
 *
 * RLS enforces tenant isolation — cross-tenant ids are invisible and land in
 * notFound. The WHERE clause additionally restricts to valid source statuses so
 * rows already in an invalid state are also placed in notFound.
 *
 * @param ids      Non-empty array of question UUIDs (caller validates 1-200).
 * @param status   Target status ('active' | 'archived').
 * @returns        { updated: string[], notFound: string[] }
 */
export async function bulkUpdateQuestionStatus(
  tenantId: string,
  ids: string[],
  status: "active" | "archived",
  actorUserId: string,
): Promise<{ updated: string[]; notFound: string[] }> {
  log.info({ tenantId, count: ids.length, status }, "bulkUpdateQuestionStatus");

  // Source statuses allowed for each target.
  const allowedSources = status === "active"
    ? ["ai_draft"] as const
    : ["ai_draft", "draft", "active"] as const;

  return withTenant(tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      `UPDATE questions
          SET status     = $1,
              updated_at = now()
        WHERE id = ANY($2::uuid[])
          AND status = ANY($3)
        RETURNING id`,
      [status, ids, allowedSources],
    );

    const updated = result.rows.map((r) => r.id);
    const updatedSet = new Set(updated);
    const notFound = ids.filter((id) => !updatedSet.has(id));

    // Audit-summary row even when zero rows updated — the call itself is
    // an admin action and the not-found list is forensic evidence (e.g.
    // someone tried to operate on cross-tenant ids). Caps metadata size by
    // capping the input batch at 200 ids upstream (route validation).
    // entityId intentionally omitted: the operation targets N rows, not one.
    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: actorUserId,
      action: "question.updated",
      entityType: "question",
      after: {
        kind: "bulk_status",
        to_status: status,
        allowed_sources: [...allowedSources],
        updated_count: updated.length,
        not_found_count: notFound.length,
        updated_ids: updated,
      },
    });

    return { updated, notFound };
  });
}
