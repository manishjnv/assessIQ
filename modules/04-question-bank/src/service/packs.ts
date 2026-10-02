/**
 * Pack + level operations (E9 split of service.ts).
 */

import {
  NotFoundError,
  ValidationError,
  ConflictError,
  uuidv7,
} from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import { resyncSetForTenant, listCloneTenantIdsForSource } from "../clone.js";
import { QB_ERROR_CODES } from "../types.js";
import * as repo from "../repository.js";
import type {
  AddLevelInput,
  CreatePackInput,
  Level,
  ListPacksInput,
  PaginatedPacks,
  QuestionPack,
  UpdateLevelPatch,
} from "../types.js";
import {
  log,
  MAX_SLUG_RETRIES,
  assertValidSlug,
  generateSlugFromName,
  isUniqueViolation,
  assertNonEmpty,
  assertPageSize,
  rethrowUnique,
  hasAnchorRubric,
} from "./_shared.js";

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
