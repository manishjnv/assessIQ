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
import { auditInTx } from "@assessiq/audit-log";
import * as repo from "./repository.js";
import { resyncSetForTenant, listCloneTenantIdsForSource } from "./clone.js";
import { deriveQuestionTextForGuidance } from "./answer-guidance-derive.js";
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
const MAX_PAGE_SIZE = 500;
const MAX_SLUG_RETRIES = 10;

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

/**
 * Derive a URL-safe slug from an arbitrary display name.
 * Steps: lowercase → NFKD normalise → strip non-alphanumeric/space/hyphen →
 * trim → collapse whitespace+underscores to hyphens → collapse runs → cap 64.
 * Returns an empty string if no alphanumeric characters survive.
 */
function generateSlugFromName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, "")  // drop accents, punctuation, emoji
    .trim()
    .replace(/[\s_]+/g, "-")         // spaces/underscores → hyphens
    .replace(/-+/g, "-")             // collapse multiple hyphens
    .replace(/^-|-$/g, "")           // strip leading/trailing hyphens
    .slice(0, 64);
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
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
 * True iff `rubric` is a usable anchor rubric (non-null object with ≥1 anchor).
 * Used by publishPack's #2 quality gate. Distinct from assertValidRubric (which
 * only validates shape WHEN a rubric is present): a `subjective` can become
 * active with NO rubric (legacy seed bypassing the create gate, migration/import
 * paths), and such a question can then only be graded holistically via the
 * reasoning-only fallback. The publish gate requires real anchors for any
 * subjective that will be served.
 */
function hasAnchorRubric(rubric: unknown): boolean {
  return (
    rubric != null &&
    typeof rubric === "object" &&
    Array.isArray((rubric as { anchors?: unknown }).anchors) &&
    (rubric as { anchors: unknown[] }).anchors.length >= 1
  );
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

function _notImplemented(message: string, code: string): AppError {
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
  assertNonEmpty(input.name, "name");
  assertNonEmpty(input.domain, "domain");
  // Canonical domain slugs are lowercase (the `domains` table). Normalize at
  // every pack write — UI, API, or import — so pack.domain always matches a
  // domain-scoped entitlement's lowercased scope_id at license-resolution time.
  const domain = input.domain.trim().toLowerCase();

  const id = uuidv7();

  // -----------------------------------------------------------------------
  // Slug resolution: explicit or auto-generated.
  // -----------------------------------------------------------------------
  const explicitSlug = input.slug !== undefined && input.slug.trim().length > 0;

  if (explicitSlug) {
    // Caller supplied a slug — validate format then try exactly once.
    assertValidSlug(input.slug!);
    const slug = input.slug!;
    log.info({ tenantId, id, slug, auto: false }, "createPack");

    try {
      return await withTenant(tenantId, async (client) => {
        const pack = await repo.insertPack(client, {
          id,
          tenantId,
          slug,
          name: input.name,
          domain,
          ...(input.description !== undefined ? { description: input.description } : {}),
          createdBy: createdByUserId,
        });
        await auditInTx(client, {
          tenantId,
          actorKind: "user",
          actorUserId: createdByUserId,
          action: "pack.created",
          entityType: "question_pack",
          entityId: pack.id,
          after: { slug: pack.slug, name: pack.name, domain: pack.domain, status: pack.status },
        });
        return pack;
      });
    } catch (err: unknown) {
      rethrowUnique(
        err,
        QB_ERROR_CODES.PACK_SLUG_EXISTS,
        `A pack with slug '${slug}' already exists in this tenant.`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Auto-generate slug from name, with collision-retry (suffix -2 … -10).
  // -----------------------------------------------------------------------
  const baseSlug = generateSlugFromName(input.name);
  if (baseSlug.length === 0) {
    throw new ValidationError(
      "name must contain at least one alphanumeric character",
      { details: { code: QB_ERROR_CODES.INVALID_NAME_FOR_SLUG, field: "name" } },
    );
  }

  log.info({ tenantId, id, baseSlug, auto: true }, "createPack");

  for (let attempt = 0; attempt <= MAX_SLUG_RETRIES; attempt++) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;

    try {
      return await withTenant(tenantId, async (client) => {
        const pack = await repo.insertPack(client, {
          id,
          tenantId,
          slug,
          name: input.name,
          domain,
          ...(input.description !== undefined ? { description: input.description } : {}),
          createdBy: createdByUserId,
        });
        await auditInTx(client, {
          tenantId,
          actorKind: "user",
          actorUserId: createdByUserId,
          action: "pack.created",
          entityType: "question_pack",
          entityId: pack.id,
          after: { slug: pack.slug, name: pack.name, domain: pack.domain, status: pack.status },
        });
        return pack;
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        // Slug already taken — try the next suffix on the next loop iteration.
        continue;
      }
      throw err;
    }
  }

  // Exhausted all retry slots.
  throw new ConflictError(
    `Could not generate a unique slug for name '${input.name}' after ${MAX_SLUG_RETRIES} attempts.`,
    { details: { code: QB_ERROR_CODES.PACK_SLUG_EXISTS } },
  );
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
    if (patch.domain !== undefined) repoPatch.domain = patch.domain.trim().toLowerCase();
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

  const updated = await withTenant(tenantId, async (client) => {
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

    // 2.5. Quality gate (#2, 2026-05-26): every SUBJECTIVE question that will be
    //      served (active after publish) MUST have a real anchor rubric.
    //      Subjective has no content-borne reference answer to synthesise from
    //      (unlike scenario→steps[].expected / log_analysis→expected_findings),
    //      so without ≥1 anchor it can only be graded holistically (the
    //      reasoning-only fallback). Block publish so the admin authors/generates
    //      a rubric first. Forward-only: already-published packs are unaffected
    //      until re-published; ai_draft/archived are not activated, so excluded.
    const subjectiveNoRubric = questions.filter(
      (q) =>
        q.type === "subjective" &&
        (q.status === "draft" || q.status === "active") &&
        !hasAnchorRubric(q.rubric),
    );
    if (subjectiveNoRubric.length > 0) {
      throw new ValidationError(
        `Cannot publish: ${subjectiveNoRubric.length} subjective question(s) have no rubric. ` +
          `Add a rubric (at least one anchor) — use "Generate rubric" or author it — then publish.`,
        {
          details: {
            code: QB_ERROR_CODES.RUBRIC_REQUIRED,
            question_ids: subjectiveNoRubric.map((q) => q.id).slice(0, 50),
          },
        },
      );
    }

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
    const updated = await repo.updatePackRow(client, id, { status: "published", version: pack.version + 1 });

    // 5. Auto-activate: a published pack must be immediately usable. Questions
    //    are only drawn into a candidate assessment when status='active', so
    //    flip every draft question to active in this same transaction — the
    //    admin no longer needs a separate "Activate all" click. This REVERSES
    //    the 2026-05-02 decoupling decision per the 2026-05-25 product call
    //    ("published = usable"). ai_draft (unreviewed AI) and archived questions
    //    are intentionally left as-is; the manual activate-questions affordance
    //    still exists for drafts ADDED to an already-published pack afterwards.
    const activation = await repo.bulkActivateDraftQuestionsForPack(client, id);

    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: savedByUserId,
      action: "pack.published",
      entityType: "question_pack",
      entityId: id,
      before: { status: pack.status, version: pack.version },
      after: {
        status: updated.status,
        version: updated.version,
        question_count: questions.length,
        activated_questions: activation.activated,
      },
    });

    return updated;
  });

  // 6. Auto-sync (push) — AFTER the publish tx commits. Refresh every tenant
  //    clone of this master in place so they pick up the new version without a
  //    manual click. Best-effort and non-throwing: the master is already
  //    published, and the manual "Update" endpoint remains as a fallback for any
  //    clone this skips. Runs only on a super_admin publish click (the route is
  //    superAdminOnly) — never a cron/webhook/candidate path, per CLAUDE.md
  //    rule #1. A tenant's OWN (non-platform) pack has no clones, so this is a
  //    no-op there. See autoSyncClonesForPack.
  await autoSyncClonesForPack(id, savedByUserId);

  return updated;
}

// ---------------------------------------------------------------------------
// revisePack — published → draft (super_admin, "revise → publish new version")
// ---------------------------------------------------------------------------
//
// The master-side half of "Revise → publish new version". A super_admin reverts
// a published platform pack to draft so it can be edited, then re-runs
// publishPack — which snapshots + bumps versions, auto-activates, and (step 6)
// auto-syncs every clone. ADDITIVE: a new transition; nothing else changes.
//
// Guards:
//   - Pack must exist (RLS-scoped lookup).
//   - Pack must be 'published' (PACK_NOT_PUBLISHED otherwise) — reverting a
//     draft is meaningless and reverting an archived pack would resurrect it.
//   - Route layer enforces super_admin (Phase B1 lockdown; platform master
//     library). The version is NOT bumped here — the subsequent publishPack
//     does that, so a revise→publish pair advances the version exactly once.
//
// In-flight safety: a master going to draft does NOT affect already-published
// assessments (frozen at their own publish, migration 0096) or in-flight
// attempts (pinned via attempt_questions). It only means the master briefly
// leaves the licensed catalog while in draft — accepted (pre-launch).
export async function revisePack(
  tenantId: string,
  id: string,
  revisedByUserId: string,
): Promise<QuestionPack> {
  log.info({ tenantId, id }, "revisePack");

  return withTenant(tenantId, async (client) => {
    const pack = await repo.findPackById(client, id);
    if (pack === null) {
      throw new NotFoundError(`Pack not found: ${id}`, {
        details: { code: QB_ERROR_CODES.PACK_NOT_FOUND },
      });
    }
    if (pack.status !== "published") {
      throw new ConflictError(
        `Pack '${id}' must be 'published' to revise (current: '${pack.status}')`,
        { details: { code: QB_ERROR_CODES.PACK_NOT_PUBLISHED } },
      );
    }

    const updated = await repo.updatePackRow(client, id, { status: "draft" });

    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: revisedByUserId,
      action: "pack.revised",
      entityType: "question_pack",
      entityId: id,
      before: { status: pack.status, version: pack.version },
      after: { status: updated.status, version: updated.version },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// autoSyncClonesForPack — publish-time clone refresh (push)
// ---------------------------------------------------------------------------
//
// Called from publishPack after its tx commits. Enumerates every tenant clone
// of the just-published master and re-syncs each in place via the B3 engine
// (resyncSetForTenant), attributing the triggering super_admin but auditing as
// 'system' (an automated platform push, not a tenant-admin click). Best-effort:
// never throws (publish already succeeded), and one clone's failure is logged
// without aborting the rest. The per-clone re-sync is itself transactional and
// advisory-locked, so it cannot race a concurrent clone-on-use of the same
// source.
async function autoSyncClonesForPack(sourcePackId: string, actorUserId: string): Promise<void> {
  let tenantIds: string[];
  try {
    tenantIds = await listCloneTenantIdsForSource(sourcePackId);
  } catch (err) {
    log.error(
      { err, sourcePackId },
      "autoSyncClonesForPack: clone enumeration failed; skipping auto-sync (manual Update remains available)",
    );
    return;
  }
  if (tenantIds.length === 0) return;

  let updated = 0;
  let failed = 0;
  for (const tenantId of tenantIds) {
    try {
      const r = await resyncSetForTenant(sourcePackId, tenantId, actorUserId, "system");
      if (r.updated) updated += 1;
    } catch (err) {
      failed += 1;
      log.error(
        { err, sourcePackId, tenantId },
        "autoSyncClonesForPack: clone re-sync failed (continuing with other clones)",
      );
    }
  }
  log.info(
    { sourcePackId, tenants: tenantIds.length, updated, failed },
    "autoSyncClonesForPack complete",
  );
}

// ---------------------------------------------------------------------------
// archivePack
// ---------------------------------------------------------------------------

export async function archivePack(
  tenantId: string,
  id: string,
  archivedByUserId: string,
): Promise<QuestionPack> {
  log.info({ tenantId, id }, "archivePack");

  return withTenant(tenantId, async (client) => {
    const pack = await repo.findPackById(client, id);
    if (pack === null) {
      throw new NotFoundError(`Pack not found: ${id}`, {
        details: { code: QB_ERROR_CODES.PACK_NOT_FOUND },
      });
    }
    // Archive is the only soft-delete path (no hard DELETE in Phase 1, see
    // routes.ts), so both draft and published packs must be archivable —
    // otherwise empty/junk auto-created drafts could never be cleared. Only an
    // already-archived pack is rejected, to keep the audit trail honest.
    if (pack.status === "archived") {
      throw new ConflictError(
        `Pack '${id}' is already archived`,
        { details: { code: QB_ERROR_CODES.PACK_ALREADY_ARCHIVED } },
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

    const updated = await repo.updatePackRow(client, id, { status: "archived" });

    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: archivedByUserId,
      action: "pack.archived",
      entityType: "question_pack",
      entityId: id,
      before: { status: pack.status },
      after: { status: updated.status },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// activateAllQuestionsForPack — admin "activate all" affordance (edge-case)
// ---------------------------------------------------------------------------
//
// HISTORY: the 2026-05-02 RCA decoupled activation from publish so admins could
// publish a pack but activate only a curated subset (graduated rollout). That
// proved more confusing than useful (a "Published" pack with draft questions
// looks usable but isn't), so as of 2026-05-25 publishPack auto-activates every
// draft question in the same transaction — "published = usable".
//
// This service is now the EDGE-CASE affordance: re-activating drafts ADDED to a
// pack that is ALREADY published (publish only fires once, draft → published).
// The pack-detail UI only surfaces the button when a level has inactive
// questions, so it no longer shows as a dead button on a fully-active pack.
//
// Guards:
//   - Pack must exist (RLS-scoped lookup).
//   - Pack must be in 'published' status — activating questions in a draft
//     pack is meaningless (the pack itself isn't visible to assessments yet)
//     and activating in an archived pack would resurrect work the admin
//     intentionally retired.
//   - At least one draft question must exist; the call is otherwise a no-op
//     and we return NO_DRAFT_QUESTIONS_TO_ACTIVATE so the admin UI can
//     surface "nothing to do" instead of misleading 200-with-zero.
//
// Idempotent in practice: re-calling on a pack with all-active questions
// throws NO_DRAFT_QUESTIONS_TO_ACTIVATE; the admin UI treats that as "already
// done". Calling on a partially-active pack flips only the remaining draft
// rows and returns the counts.
export async function activateAllQuestionsForPack(
  tenantId: string,
  packId: string,
  actorUserId: string,
): Promise<{ activated: number; alreadyActive: number; archived: number }> {
  log.info({ tenantId, packId }, "activateAllQuestionsForPack");

  return withTenant(tenantId, async (client) => {
    const pack = await repo.findPackById(client, packId);
    if (pack === null) {
      throw new NotFoundError(`Pack not found: ${packId}`, {
        details: { code: QB_ERROR_CODES.PACK_NOT_FOUND },
      });
    }
    if (pack.status !== "published") {
      throw new ConflictError(
        `Pack '${packId}' must be 'published' to activate questions (current: '${pack.status}')`,
        { details: { code: QB_ERROR_CODES.PACK_NOT_PUBLISHED, status: pack.status } },
      );
    }

    const result = await repo.bulkActivateDraftQuestionsForPack(client, packId);
    if (result.activated === 0) {
      throw new ConflictError(
        `No draft questions to activate in pack '${packId}' (active: ${result.alreadyActive}, archived: ${result.archived})`,
        {
          details: {
            code: QB_ERROR_CODES.NO_DRAFT_QUESTIONS_TO_ACTIVATE,
            alreadyActive: result.alreadyActive,
            archived: result.archived,
          },
        },
      );
    }

    // Audit-summary row: bulk draft → active transition. One row per call (not
    // per question) keeps the audit_log volume bounded for packs with hundreds
    // of questions; the metadata.kind=bulk_activate marker distinguishes this
    // from per-question status flips that go through bulkUpdateQuestionStatus.
    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: actorUserId,
      action: "question.updated",
      entityType: "question_pack",
      entityId: packId,
      after: {
        kind: "bulk_activate",
        from_status: "draft",
        to_status: "active",
        activated: result.activated,
        already_active: result.alreadyActive,
        archived: result.archived,
      },
    });

    return result;
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
  log.info({ tenantId, packId }, "addLevel");

  try {
    return await withTenant(tenantId, async (client) => {
      // Verify pack exists (RLS scopes the SELECT to this tenant)
      const pack = await repo.findPackById(client, packId);
      if (pack === null) {
        throw new NotFoundError(`Pack not found: ${packId}`, {
          details: { code: QB_ERROR_CODES.PACK_NOT_FOUND },
        });
      }

      // Auto-assign position as max(position)+1 when caller omits it.
      let position = input.position;
      if (position === undefined || position === null) {
        const maxRes = await client.query<{ max: number | null }>(
          `SELECT MAX(position) AS max FROM levels WHERE pack_id = $1`,
          [packId],
        );
        position = (maxRes.rows[0]?.max ?? 0) + 1;
      }

      return repo.insertLevel(client, {
        id: uuidv7(),
        packId,
        position,
        label: input.label,
        ...(input.description !== undefined ? { description: input.description } : {}),
        durationMinutes: input.duration_minutes ?? 30,
        defaultQuestionCount: input.default_question_count ?? 10,
        ...(input.passing_score_pct !== undefined ? { passingScorePct: input.passing_score_pct } : {}),
      });
    });
  } catch (err: unknown) {
    rethrowUnique(
      err,
      QB_ERROR_CODES.LEVEL_POSITION_EXISTS,
      `A level at position ${input.position ?? "auto"} already exists in pack '${packId}'.`,
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
    if (patch.rubric_defaults !== undefined) repoPatch.rubric_defaults = patch.rubric_defaults;

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
// DOMAIN-BASED PACK RESOLVER (Slice 2.1c — C1)
// ===========================================================================

/**
 * Find or create an auto-managed pack for a given (tenant, domain) pair.
 *
 * Design: 1 pack per (tenant, domain), identified by the reserved slug
 * `dom-<domainSlug>`. Three levels L1/L2/L3 are healed into it (positions
 * 1/2/3; 60min / 10q / 60%). The pack is INTERNAL — the admin never sees it.
 *
 * Security:
 *  - Cross-tenant guard FIRST (same hardened pattern as 2.1b). Fail-closed.
 *  - tenant_id explicit on INSERT (satisfies WITH CHECK RLS on question_packs).
 *  - Levels derive tenancy via FK chain — no tenant_id on level INSERT (matches
 *    the repository comment: "levels has no tenant_id column").
 *
 * Idempotency:
 *  - pack UNIQUE(tenant_id, slug, version) → catch 23505 → re-query → continue.
 *  - levels: query existing labels, insert only the missing ones (never delete).
 *  - Returns exactly 3 level IDs — never <3 (heal loop prevents it).
 */
export async function findOrCreatePackForDomain(
  tenantId: string,
  domainId: string,
  createdByUserId: string,
): Promise<{ packId: string; levelIds: { L1: string; L2: string; L3: string } }> {
  log.info({ tenantId, domainId }, "findOrCreatePackForDomain");

  return withTenant(tenantId, async (client) => {
    // ── 1. Cross-tenant guard FIRST (fail-closed) ──────────────────────────
    // Postgres FK validation bypasses RLS. This explicit query is the primary
    // security control preventing a pack from being created for a domain that
    // belongs to another tenant.
    const guardResult = await client.query<{ slug: string; name: string }>(
      `SELECT slug, name FROM domains WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [domainId, tenantId],
    );
    if (guardResult.rows.length === 0) {
      throw new ValidationError(
        "domain_id does not exist or does not belong to this tenant",
        { details: { code: "CROSS_TENANT_FK_REJECTED", param: "domain_id" } },
      );
    }
    const { slug: domainSlug, name: domainName } = guardResult.rows[0]!;

    // ── 2. Reserved slug: dom-<domainSlug> ────────────────────────────────
    const autoSlug = `dom-${domainSlug}`;

    // ── 3. Find existing auto-pack (or insert if absent) ──────────────────
    let packId: string;
    const findResult = await client.query<{ id: string }>(
      `SELECT id FROM question_packs WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
      [tenantId, autoSlug],
    );

    if (findResult.rows.length > 0) {
      packId = findResult.rows[0]!.id;
    } else {
      // Insert the auto-managed pack. Catch 23505 (race: another request
      // inserted first) → re-query and continue. tenant_id explicit to satisfy
      // WITH CHECK RLS policy on question_packs.
      const newPackId = uuidv7();
      const descSentinel =
        `Auto-managed by the Generate-Questions wizard for domain: ${domainName}. Do not rename its slug.`;
      try {
        const insertResult = await client.query<{ id: string }>(
          `INSERT INTO question_packs (id, tenant_id, slug, name, domain, description, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          [newPackId, tenantId, autoSlug, domainName, domainSlug, descSentinel, createdByUserId],
        );
        packId = insertResult.rows[0]!.id;
        log.info({ tenantId, packId, autoSlug }, "findOrCreatePackForDomain: pack inserted");
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          // Race: another concurrent request created the pack. Re-query.
          const retryResult = await client.query<{ id: string }>(
            `SELECT id FROM question_packs WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
            [tenantId, autoSlug],
          );
          if (retryResult.rows.length === 0) {
            throw new Error("findOrCreatePackForDomain: pack missing after 23505 retry — unexpected");
          }
          packId = retryResult.rows[0]!.id;
          log.info({ tenantId, packId, autoSlug }, "findOrCreatePackForDomain: pack found after 23505");
        } else {
          throw err;
        }
      }
    }

    // ── 4. Heal levels: ensure L1, L2, L3 all exist ───────────────────────
    // Query which labels already exist for this pack.
    const existingLevelsResult = await client.query<{ id: string; label: string }>(
      `SELECT id, label FROM levels WHERE pack_id = $1 AND label = ANY($2::text[])`,
      [packId, ["L1", "L2", "L3"]],
    );

    const existingLevelMap = new Map<string, string>();
    for (const row of existingLevelsResult.rows) {
      existingLevelMap.set(row.label, row.id);
    }

    // Level definitions: label → position, duration_minutes, default_question_count, passing_score_pct
    const LEVEL_DEFS = [
      { label: "L1", position: 1, durationMinutes: 60, defaultQuestionCount: 10, passingScorePct: 60 },
      { label: "L2", position: 2, durationMinutes: 60, defaultQuestionCount: 10, passingScorePct: 60 },
      { label: "L3", position: 3, durationMinutes: 60, defaultQuestionCount: 10, passingScorePct: 60 },
    ] as const;

    for (const def of LEVEL_DEFS) {
      if (!existingLevelMap.has(def.label)) {
        // Level is missing — insert it. Levels have no tenant_id column; their
        // RLS derives tenancy via FK chain through question_packs. No tenant_id
        // on INSERT (matches repository.ts comment — do not add one).
        const newLevelId = uuidv7();
        try {
          await client.query(
            `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [newLevelId, packId, def.position, def.label, def.durationMinutes, def.defaultQuestionCount, def.passingScorePct],
          );
          existingLevelMap.set(def.label, newLevelId);
          log.info({ tenantId, packId, label: def.label, levelId: newLevelId }, "findOrCreatePackForDomain: level healed");
        } catch (err: unknown) {
          if (isUniqueViolation(err)) {
            // Race on level insert — re-query this specific label.
            const retryLevelResult = await client.query<{ id: string }>(
              `SELECT id FROM levels WHERE pack_id = $1 AND label = $2 LIMIT 1`,
              [packId, def.label],
            );
            if (retryLevelResult.rows.length === 0) {
              throw new Error(`findOrCreatePackForDomain: level ${def.label} missing after 23505 retry`);
            }
            existingLevelMap.set(def.label, retryLevelResult.rows[0]!.id);
          } else {
            throw err;
          }
        }
      }
    }

    // ── 5. Verify heal completeness — must never return <3 levels ─────────
    const L1 = existingLevelMap.get("L1");
    const L2 = existingLevelMap.get("L2");
    const L3 = existingLevelMap.get("L3");
    if (!L1 || !L2 || !L3) {
      throw new Error(
        `findOrCreatePackForDomain: heal incomplete — missing levels after insert: ` +
        `L1=${L1 ?? "MISSING"}, L2=${L2 ?? "MISSING"}, L3=${L3 ?? "MISSING"}`,
      );
    }

    return { packId, levelIds: { L1, L2, L3 } };
  });
}

// ===========================================================================
// AI QUESTION GENERATION
// ===========================================================================

/**
 * Generate SOC-grounded ai_draft questions for a pack/level.
 *
 * This function:
 *   1. Loads the SOC knowledge base and selects sources matching the level
 *      (inferred from level label) and optional topic_focus filter.
 *   2. Loads existing topics for the pack/level to prevent duplicates.
 *   3. Delegates to handleAdminGenerate (ai-grading handler), which
 *      calls the claude-code-vps runtime → generate-questions SKILL.md →
 *      submit_questions MCP tool → inserts ai_draft rows in DB.
 *
 * D2 compliance note:
 *   This function imports from '@assessiq/ai-grading' (the barrel).
 *   The ai-grading lint's RE_GRADING_RUNTIME_IMPORT pattern matches
 *   `generateQuestions` as a symbol name, and this file is not in a
 *   banned path (not worker / candidate / webhook / cron) — lint passes.
 */
export async function generateQuestions(
  tenantId: string,
  userId: string,
  packId: string,
  levelId: string,
  count: number,
  topicFocus?: string,
  typeCounts?: Partial<Record<string, number>>,
  domainId?: string,
  categoryId?: string,
  batchId?: string,
): Promise<{ questionIds: string[]; generated: number; skillSha: string }> {
  // Dynamic import to break the load-time cycle: at module load time
  // neither package has finished resolving. Dynamic import defers until
  // the first call, at which point both packages are fully resolved.
  const { handleAdminGenerate } = await import("@assessiq/ai-grading");
  const {
    SOC_KB_BY_LEVEL,
    SOC_KB_FUNCTIONS,
  } = await import("./knowledge-base/index.js");
  // difficulty-spec.ts (this module) — single source of truth for per-(type,level)
  // intrinsic-difficulty targets (Phase A3). Intra-module import; no boundary cross.
  const { DIFFICULTY_SPEC, validateStructuralDifficulty, functionToNice } =
    await import("./difficulty-spec.js");

  // Resolve level label to SOC level
  const level = await withTenant(tenantId, async (client) => {
    const result = await client.query<{ label: string }>(
      `SELECT label FROM levels WHERE id = $1 LIMIT 1`,
      [levelId],
    );
    return result.rows[0]?.label ?? null;
  });

  const socLevel = ((): "L1" | "L2" | "L3" => {
    if (level === null) return "L1";
    const upper = level.toUpperCase();
    if (upper.includes("L3") || upper.includes("LEVEL 3") || upper.includes("SENIOR") || upper.includes("THREAT HUNT")) return "L3";
    if (upper.includes("L2") || upper.includes("LEVEL 2") || upper.includes("INTERMEDIATE") || upper.includes("ANALYST")) return "L2";
    return "L1";
  })();

  // ── Difficulty injection (Phase A3) ───────────────────────────────────────
  // Resolve this level's per-type intrinsic-difficulty targets and pass them —
  // plus a level-bound structural validator and the KbSource.function→NICE
  // mapper — into handleAdminGenerate as in-process data + closures. This keeps
  // the ai-grading→question-bank no-import boundary intact (04 depends on 07,
  // never the reverse): 07 receives targets + closures, never imports difficulty-spec.
  const difficultyByType: Record<string, unknown> = {};
  for (const t of ["mcq", "subjective", "kql", "scenario", "log_analysis"] as const) {
    difficultyByType[t] = DIFFICULTY_SPEC[t][socLevel];
  }
  const difficulty = {
    byType: difficultyByType,
    validate: (
      type: Parameters<typeof validateStructuralDifficulty>[0],
      content: unknown,
      rubric: unknown,
    ) => validateStructuralDifficulty(type, socLevel, content, rubric),
    niceForFunction: functionToNice,
  };

  // Select sources from KB filtered by level (and optionally topic_focus)
  let sources = SOC_KB_BY_LEVEL[socLevel];
  if (topicFocus && (SOC_KB_FUNCTIONS as readonly string[]).includes(topicFocus)) {
    const focused = sources.filter((s) => s.function === topicFocus);
    // Only narrow to topic_focus if it has enough entries; otherwise use full level
    sources = focused.length >= 3 ? focused : sources;
  }

  // Load existing topics for duplicate avoidance
  const existingTopics = await withTenant(tenantId, async (client) => {
    const result = await client.query<{ topic: string }>(
      `SELECT topic FROM questions WHERE pack_id = $1 AND level_id = $2`,
      [packId, levelId],
    );
    return result.rows.map((r) => r.topic);
  });

  // ── Cross-tenant FK guard (load-bearing — do NOT remove or short-circuit) ──
  // Postgres FK validation runs as the table owner and bypasses RLS. A question
  // in tenant A could reference a domain/category in tenant B without this check.
  // This explicit query is the primary security control for that boundary.
  // The guard runs BEFORE generation to fail fast without wasting AI budget.
  //
  // SECURITY (Opus, 2026-05-16): domain_id and category_id are an
  // all-or-nothing pair. If exactly ONE is supplied, the composite tenant
  // check below is skipped (its `&&` condition is false) while the lone
  // unvalidated FK still flows to insertDrafts — and Postgres FK validation
  // bypasses RLS, so a tenant-A question would persist a tenant-B domain_id.
  // Enforce both-or-neither BEFORE the existence check; partial tagging is
  // never legitimate (the wizard always sends the pair).
  if ((domainId !== undefined) !== (categoryId !== undefined)) {
    throw new ValidationError(
      "domain_id and category_id must be provided together or both omitted",
      { details: { code: "CROSS_TENANT_FK_REJECTED", param: "domain_id,category_id" } },
    );
  }
  if (domainId !== undefined && categoryId !== undefined) {
    const guardResult = await withTenant(tenantId, async (client) => {
      return client.query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM categories
           WHERE id = $1
             AND domain_id = $2
             AND tenant_id = $3
         ) AS exists`,
        [categoryId, domainId, tenantId],
      );
    });
    if (!guardResult.rows[0]?.exists) {
      throw new ValidationError(
        "domain_id/category_id combination does not exist or does not belong to this tenant",
        { details: { code: "CROSS_TENANT_FK_REJECTED", param: "domain_id,category_id" } },
      );
    }
  }

  return handleAdminGenerate({
    tenantId,
    userId,
    packId,
    levelId,
    count,
    socLevel,
    sources,
    existingTopics,
    difficulty,
    ...(typeCounts !== undefined ? { typeCounts } : {}),
    ...(domainId !== undefined ? { domainId } : {}),
    ...(categoryId !== undefined ? { categoryId } : {}),
    ...(batchId !== undefined ? { batchId } : {}),
  });
}

// ===========================================================================
// RUBRIC GENERATOR — proposal + save + bulk-fill
// ===========================================================================

/**
 * Derive the questionText to pass to generateRubricDraft().
 *
 * For log_analysis: the full JSON-serialized content object is passed so the
 * skill can read question + log_format + log_excerpt + expected_findings +
 * sample_solution + hint and produce one anchor per expected_finding.
 *
 * For all other types: the `question` string field is used if present (subjective
 * and kql both have a plain-text question field); falls back to full JSON for
 * types that don't have a top-level question field (e.g. scenario).
 *
 * Extracted as a helper to avoid duplication between generateRubricForQuestion
 * and bulkGenerateMissingRubrics.
 */
function deriveQuestionTextForRubric(
  question: { type: string; content: unknown },
): string {
  if (question.type === "log_analysis") {
    return JSON.stringify(question.content);
  }
  const content = question.content as Record<string, unknown>;
  return typeof content?.question === "string"
    ? (content.question as string)
    : JSON.stringify(question.content);
}

/**
 * Generate a rubric proposal for a subjective, scenario, or log_analysis question.
 * Returns a proposal WITHOUT persisting — admin must POST to save-rubric.
 *
 * D2 compliance: uses dynamic import to call generateRubricDraft from
 * @assessiq/ai-grading. This service file is not in a banned path.
 * The D2 lint enforces the call-site restriction at the runtime level,
 * not at the service layer.
 */
export async function generateRubricForQuestion(
  tenantId: string,
  questionId: string,
): Promise<{
  proposal: unknown;
  skillSha: string;
  promptSha: string;
  levelDefaultsHash: string;
  model: string;
}> {
  return withTenant(tenantId, async (client) => {
    const question = await repo.findQuestionById(client, questionId);
    if (!question) {
      throw new NotFoundError("question not found", {
        details: { code: QB_ERROR_CODES.QUESTION_NOT_FOUND, questionId },
      });
    }

    if (
      question.type !== "subjective" &&
      question.type !== "scenario" &&
      question.type !== "log_analysis"
    ) {
      throw new ValidationError(
        `rubric generation not supported for question type '${question.type}': ` +
          "mcq and kql use deterministic grading and have no rubric semantics",
        { details: { code: QB_ERROR_CODES.UNSUPPORTED_TYPE_FOR_RUBRIC, type: question.type } },
      );
    }

    const level = await repo.findLevelById(client, question.level_id);
    if (!level) {
      throw new NotFoundError("level not found", {
        details: { code: QB_ERROR_CODES.LEVEL_NOT_FOUND, levelId: question.level_id },
      });
    }

    // For log_analysis, validate expected_findings exists before calling the
    // skill (the skill requires ≥1 finding to produce ≥2 anchors; without
    // this guard the skill fails with an opaque schema violation).
    if (question.type === "log_analysis") {
      const content = question.content as Record<string, unknown>;
      const findings = content?.expected_findings;
      if (!Array.isArray(findings) || findings.length === 0) {
        throw new ValidationError(
          "log_analysis rubric generation requires at least one expected_finding in question content",
          { details: { code: QB_ERROR_CODES.INVALID_CONTENT } },
        );
      }
    }

    const { generateRubricDraft } = await import("@assessiq/ai-grading");

    const output = await generateRubricDraft({
      questionText: deriveQuestionTextForRubric(question),
      questionType: question.type as "subjective" | "scenario" | "log_analysis",
      levelOrdinal: level.position,
      levelDefaults: level.rubric_defaults ?? null,
      existingRubric: question.rubric ?? undefined,
      questionId,
    });

    return {
      proposal: output.rubric,
      skillSha: output.skillSha,
      promptSha: output.promptSha,
      levelDefaultsHash: output.levelDefaultsHash,
      model: output.model,
    };
  });
}

/**
 * Generate a candidate-facing answer-format hint proposal for a question
 * (feature #4 Phase B). Supports ALL question types. Returns a proposal
 * WITHOUT persisting — the admin reviews it and POSTs the existing
 * answer_guidance PATCH to save (admin-in-the-loop review gate).
 *
 * D2 compliance: uses dynamic import to call generateAnswerGuidanceDraft from
 * @assessiq/ai-grading; this service file is not in a banned path. The
 * generator receives only an answer-key-free stem (deriveQuestionTextForGuidance).
 */
export async function generateAnswerGuidanceForQuestion(
  tenantId: string,
  questionId: string,
): Promise<{ proposal: string; skillSha: string; promptSha: string; model: string }> {
  return withTenant(tenantId, async (client) => {
    const question = await repo.findQuestionById(client, questionId);
    if (!question) {
      throw new NotFoundError("question not found", {
        details: { code: QB_ERROR_CODES.QUESTION_NOT_FOUND, questionId },
      });
    }

    const { generateAnswerGuidanceDraft } = await import("@assessiq/ai-grading");

    const output = await generateAnswerGuidanceDraft({
      questionText: deriveQuestionTextForGuidance(question),
      questionType: question.type as "mcq" | "subjective" | "kql" | "scenario" | "log_analysis",
      topic: question.topic,
      questionId,
    });

    return {
      proposal: output.answerGuidance,
      skillSha: output.skillSha,
      promptSha: output.promptSha,
      model: output.model,
    };
  });
}

/**
 * Validate and persist a rubric to a question.
 * Server-side weight=100 invariant validation runs BEFORE any DB write.
 * Creates a new version snapshot (via updateQuestion) before persisting.
 */
export async function saveRubric(
  tenantId: string,
  questionId: string,
  rubric: unknown,
  userId: string,
): Promise<{ id: string }> {
  const { RubricSchema } = await import("@assessiq/rubric-engine");

  const validated = RubricSchema.safeParse(rubric);
  if (!validated.success) {
    throw new ValidationError(
      "rubric failed schema validation: " +
        validated.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      { details: { code: QB_ERROR_CODES.INVALID_RUBRIC, issues: validated.error.issues } },
    );
  }

  return withTenant(tenantId, async (client) => {
    const question = await repo.findQuestionById(client, questionId);
    if (!question) {
      throw new NotFoundError("question not found", {
        details: { code: QB_ERROR_CODES.QUESTION_NOT_FOUND, questionId },
      });
    }

    // Snapshot current state before overwriting rubric
    await repo.insertQuestionVersion(client, {
      id: uuidv7(),
      questionId: question.id,
      version: question.version,
      content: question.content,
      rubric: question.rubric,
      savedBy: userId,
    });

    const updated = await repo.updateQuestionRow(client, questionId, {
      rubric: validated.data,
      version: question.version + 1,
    });

    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: userId,
      action: "question.updated",
      entityType: "question",
      entityId: questionId,
      before: { version: question.version },
      after: {
        kind: "save_rubric",
        version: updated.version,
      },
    });

    return { id: questionId };
  });
}

export interface BulkGenerateMissingRubricsResult {
  proposal: unknown;
  skillSha: string;
  promptSha: string;
  levelDefaultsHash: string;
  model: string;
  currentQuestionId: string;
  remainingCount: number;
  nextQuestionId: string | null;
}

/**
 * Find the first question in a pack with rubric IS NULL and type in
 * (subjective, scenario). Return a proposal + cursor.
 * Does NOT auto-save — admin reviews each proposal and POSTs to save-rubric.
 */
export async function bulkGenerateMissingRubrics(
  tenantId: string,
  packId: string,
): Promise<BulkGenerateMissingRubricsResult> {
  return withTenant(tenantId, async (client) => {
    const nullRubricRes = await client.query<{ id: string; count: string }>(
      `SELECT q.id, COUNT(*) OVER() AS count
       FROM questions q
       WHERE q.pack_id = $1
         AND q.rubric IS NULL
         AND q.type IN ('subjective', 'scenario', 'log_analysis')
       ORDER BY q.created_at ASC`,
      [packId],
    );

    if (nullRubricRes.rows.length === 0) {
      throw new NotFoundError(
        "no questions with missing rubrics found in this pack",
        { details: { code: "NO_MISSING_RUBRICS", packId } },
      );
    }

    const firstRow = nullRubricRes.rows[0]!;
    const currentQuestionId = firstRow.id;
    const totalCount = parseInt(firstRow.count, 10);
    const nextQuestionId = nullRubricRes.rows[1]?.id ?? null;
    const remainingCount = totalCount - 1;

    const question = await repo.findQuestionById(client, currentQuestionId);
    if (!question) {
      throw new NotFoundError("question not found", {
        details: { code: QB_ERROR_CODES.QUESTION_NOT_FOUND, questionId: currentQuestionId },
      });
    }
    const level = await repo.findLevelById(client, question.level_id);
    if (!level) {
      throw new NotFoundError("level not found", {
        details: { code: QB_ERROR_CODES.LEVEL_NOT_FOUND, levelId: question.level_id },
      });
    }

    // Validate expected_findings before calling the skill (same guard as
    // generateRubricForQuestion — avoids opaque schema-violation errors).
    if (question.type === "log_analysis") {
      const content = question.content as Record<string, unknown>;
      const findings = content?.expected_findings;
      if (!Array.isArray(findings) || findings.length === 0) {
        throw new ValidationError(
          "log_analysis rubric generation requires at least one expected_finding in question content",
          { details: { code: QB_ERROR_CODES.INVALID_CONTENT } },
        );
      }
    }

    const { generateRubricDraft } = await import("@assessiq/ai-grading");

    const output = await generateRubricDraft({
      questionText: deriveQuestionTextForRubric(question),
      questionType: question.type as "subjective" | "scenario" | "log_analysis",
      levelOrdinal: level.position,
      levelDefaults: level.rubric_defaults ?? null,
      questionId: currentQuestionId,
    });

    return {
      proposal: output.rubric,
      skillSha: output.skillSha,
      promptSha: output.promptSha,
      levelDefaultsHash: output.levelDefaultsHash,
      model: output.model,
      currentQuestionId,
      remainingCount,
      nextQuestionId,
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
