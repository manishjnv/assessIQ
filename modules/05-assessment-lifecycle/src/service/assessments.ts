import { NotFoundError, ValidationError, ConflictError, uuidv7 } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import { assertLicensedForSourcePack } from "@assessiq/billing";
import * as repo from "../repository.js";
import * as qbRepo from "../../../04-question-bank/src/repository.js";
import { materializeSetForTenant, resyncSetForTenant } from "../../../04-question-bank/src/clone.js";
import { assertValidWindow } from "../state-machine.js";
import { assertRemindersSettings } from "../reminders.js";
import { AL_ERROR_CODES, AssessmentBlueprintSchema, AssessmentIntegritySettingsSchema, AssessmentSectionsSchema } from "../types.js";
import type { Assessment, ResolvedBlueprint, AssessmentSettings, CreateAssessmentInput, CreateAssessmentFromSetInput, ListAssessmentsInput, PaginatedAssessments, UpdateAssessmentPatch } from "../types.js";
import type { InvitationCounts } from "../repository.js";
import { log, assertPageSize } from "./_shared.js";
import { assertBlueprintFKOwnership, resolveBlueprint, resolveBlueprintPackLevel } from "./blueprint.js";

// ===========================================================================
// ASSESSMENT OPERATIONS
// ===========================================================================

// ---------------------------------------------------------------------------
// listAssessments
// ---------------------------------------------------------------------------

export async function listAssessments(
  tenantId: string,
  filters?: ListAssessmentsInput,
): Promise<PaginatedAssessments> {
  const page = filters?.page ?? 1;
  const pageSize = filters?.pageSize ?? 20;

  assertPageSize(pageSize);

  return withTenant(tenantId, async (client) => {
    const { items, total } = await repo.listAssessmentRows(client, {
      ...filters,
      page,
      pageSize,
    });
    return { items, page, pageSize, total };
  });
}

// ---------------------------------------------------------------------------
// getInvitationCounts
// ---------------------------------------------------------------------------

/**
 * Returns per-assessment invitation counts for the given assessment IDs, keyed
 * by assessment ID. Uses a single grouped query via countInvitationsByAssessment.
 * Assessments with no invitations are absent from the returned record.
 *
 * Intended for enriching the admin assessment list response so the UI can
 * display invitation status at a glance without a per-row N+1 query.
 */
export async function getInvitationCounts(
  tenantId: string,
  assessmentIds: string[],
): Promise<Record<string, InvitationCounts>> {
  if (assessmentIds.length === 0) return {};
  return withTenant(tenantId, (client) =>
    repo.countInvitationsByAssessment(client, assessmentIds),
  );
}

export type { InvitationCounts };

// ---------------------------------------------------------------------------
// getAssessment
// ---------------------------------------------------------------------------

export async function getAssessment(
  tenantId: string,
  id: string,
): Promise<Assessment> {
  const assessment = await withTenant(tenantId, (client) =>
    repo.findAssessmentById(client, id),
  );
  if (assessment === null) {
    throw new NotFoundError(`Assessment not found: ${id}`, {
      details: { code: AL_ERROR_CODES.ASSESSMENT_NOT_FOUND },
    });
  }
  return assessment;
}

/**
 * Admin detail view variant — same as getAssessment but also returns
 * level_label (from levels.label) and pack_name (from question_packs.name)
 * as optional fields, used by the assessment-detail page header.
 */
export async function getAssessmentDetail(
  tenantId: string,
  id: string,
): Promise<Assessment> {
  const assessment = await withTenant(tenantId, (client) =>
    repo.findAssessmentByIdWithMeta(client, id),
  );
  if (assessment === null) {
    throw new NotFoundError(`Assessment not found: ${id}`, {
      details: { code: AL_ERROR_CODES.ASSESSMENT_NOT_FOUND },
    });
  }
  return assessment;
}

// ---------------------------------------------------------------------------
// createAssessment
// ---------------------------------------------------------------------------

export async function createAssessment(
  tenantId: string,
  input: CreateAssessmentInput,
  createdByUserId: string,
): Promise<Assessment> {
  // Slice A.2 — opens_at is mandatory.
  // Fail fast BEFORE resolveBlueprintPackLevel so a missing Opens never
  // triggers a spurious findOrCreatePackForDomain (auto-pack creation).
  // Placed before withTenant: zero side effects on null opens_at.
  if (input.opens_at == null) {
    throw new ValidationError(
      "opens_at is required: an assessment with no opens_at never transitions to active (time-boundary worker requires opens_at IS NOT NULL)",
      { details: { code: AL_ERROR_CODES.OPENS_AT_REQUIRED, field: "opens_at" } },
    );
  }

  // Validate window before touching the DB (avoids a round-trip on bad input)
  assertValidWindow(input.opens_at ?? null, input.closes_at ?? null);

  // ── Blueprint path (C1) ───────────────────────────────────────────────────
  // When settings.blueprint is present, validate + resolve pack/level BEFORE
  // entering withTenant. findOrCreatePackForDomain uses its own withTenant
  // internally and is already cross-tenant-guarded (Opus-reviewed, Slice 2.1c).
  // The input pack_id / level_id / question_count are overridden with the
  // blueprint-resolved values so the no-blueprint INSERT path below is unchanged.
  assertIntegritySettings(input.settings);
  assertRemindersSettings(input.settings);
  assertSectionsSettings(input.settings);
  if (input.passing_score_pct !== undefined) assertPassMark(input.passing_score_pct);
  let resolvedInput = input;
  let mergedSettings: AssessmentSettings = input.settings ?? {};

  const rawBlueprint = (input.settings as Record<string, unknown> | undefined)?.["blueprint"];
  if (rawBlueprint !== undefined) {
    // Zod-validate blueprint shape
    const parseResult = AssessmentBlueprintSchema.safeParse(rawBlueprint);
    if (!parseResult.success) {
      throw new ValidationError(
        `settings.blueprint is invalid: ${parseResult.error.issues.map((i) => i.message).join("; ")}`,
        { details: { code: AL_ERROR_CODES.BLUEPRINT_INVALID, issues: parseResult.error.issues } },
      );
    }
    const blueprint = await resolveBlueprint(tenantId, parseResult.data);

    // Resolve pack/level (calls findOrCreatePackForDomain which has its own
    // domain cross-tenant guard). Then do the category-level guard inside withTenant.
    const resolved = await resolveBlueprintPackLevel(tenantId, blueprint, createdByUserId);

    resolvedInput = {
      ...input,
      pack_id: resolved.packId,
      level_id: resolved.levelId,
      question_count: resolved.questionCount,
    };
    mergedSettings = { ...mergedSettings, blueprint };
  }

  const id = uuidv7();
  log.info(
    { tenantId, id, packId: resolvedInput.pack_id, levelId: resolvedInput.level_id, hasBlueprint: rawBlueprint !== undefined },
    "createAssessment",
  );

  return withTenant(tenantId, async (client) => {
    // C1 — cross-tenant FK guard for blueprint (category-level, inside RLS scope)
    if (rawBlueprint !== undefined) {
      const blueprint = mergedSettings.blueprint as ResolvedBlueprint; // resolved above
      await assertBlueprintFKOwnership(client, tenantId, blueprint);
    }

    // a. Pack must exist (RLS scopes the SELECT to this tenant)
    const pack = await qbRepo.findPackById(client, resolvedInput.pack_id);
    if (pack === null) {
      throw new NotFoundError(`Question set not found: ${resolvedInput.pack_id}`, {
        details: { code: AL_ERROR_CODES.PACK_NOT_FOUND },
      });
    }

    // b. Pack must be published — SKIPPED for blueprint mode.
    //
    // Rationale: blueprint assessments resolve their pack via findOrCreatePackForDomain,
    // which creates auto-managed packs in 'draft' status that the admin never touches.
    // The "pack must be published" guard was a legacy quality gate for manually-managed
    // packs; for blueprint mode the real quality gate is the C2 per-criterion pool
    // pre-flight at publishAssessment (unchanged).
    //
    // Non-blueprint (legacy) path: guard is byte-identical to what it was before.
    //
    // Tenancy invariant: the resolved pack is ALWAYS this tenant's own auto-pack —
    // findOrCreatePackForDomain (04/service.ts:1282-1295) enforces
    //   WHERE id = $1 AND tenant_id = $2
    // as its first action before any pack is created or returned. Skipping the
    // published-status check does NOT weaken the tenancy guard.
    if (rawBlueprint === undefined && pack.status !== "published") {
      throw new ConflictError(
        `Question set '${resolvedInput.pack_id}' must be in 'published' status to create an assessment (current: '${pack.status}')`,
        { details: { code: AL_ERROR_CODES.PACK_NOT_PUBLISHED } },
      );
    }

    // c. Level must exist (RLS scopes through pack FK)
    const level = await qbRepo.findLevelById(client, resolvedInput.level_id);
    if (level === null) {
      throw new NotFoundError(`Level not found: ${resolvedInput.level_id}`, {
        details: { code: AL_ERROR_CODES.LEVEL_NOT_FOUND },
      });
    }

    // d. Level must belong to the specified pack
    if (level.pack_id !== resolvedInput.pack_id) {
      throw new ValidationError(
        `Level '${resolvedInput.level_id}' does not belong to question set '${resolvedInput.pack_id}'`,
        { details: { code: AL_ERROR_CODES.LEVEL_NOT_IN_PACK } },
      );
    }

    // e+f. Insert assessment; pack_version is snapshotted from the current pack version
    const assessment = await repo.insertAssessment(client, {
      id,
      tenantId,
      packId: resolvedInput.pack_id,
      levelId: resolvedInput.level_id,
      packVersion: pack.version,
      name: resolvedInput.name,
      ...(resolvedInput.description !== undefined ? { description: resolvedInput.description } : {}),
      questionCount: resolvedInput.question_count,
      // Z-16: explicit mark wins; else the level's value (clamped: levels allow 0).
      passingScorePct: input.passing_score_pct ?? Math.min(100, Math.max(1, level.passing_score_pct)),
      randomize: resolvedInput.randomize ?? true,
      opensAt: resolvedInput.opens_at ?? null,
      closesAt: resolvedInput.closes_at ?? null,
      settings: mergedSettings,
      createdBy: createdByUserId,
    });

    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: createdByUserId,
      action: "assessment.created",
      entityType: "assessment",
      entityId: assessment.id,
      after: {
        pack_id: assessment.pack_id,
        level_id: assessment.level_id,
        pack_version: assessment.pack_version,
        name: assessment.name,
        question_count: assessment.question_count,
        passing_score_pct: assessment.passing_score_pct,
        randomize: assessment.randomize,
        status: assessment.status,
        has_blueprint: rawBlueprint !== undefined,
      },
    });

    return assessment;
  });
}

// ---------------------------------------------------------------------------
// createAssessmentFromSet — Step 2 clone-on-use
// ---------------------------------------------------------------------------
//
// Company-admin path: build an assessment from a licensed PLATFORM-library set.
// Flow: license re-check against the SOURCE set → materialise (clone-on-use,
// idempotent) into this tenant → resolve the chosen level within the clone →
// delegate to createAssessment (non-blueprint; the clone is status='published'
// so the published-pack guard passes). Publish-time entitlement is enforced
// separately by assertPublishEntitled (now clone-lineage-aware).
//
// Transaction note: the three steps are independent transactions (license read,
// clone tx, create tx). A clone with no assessment (if step 3 fails) is benign
// and reused on retry. The authoritative entitlement control is the publish
// gate, so even a TOCTOU license-revoke between clone and publish is safe.
/** Z-16: pass mark must be an integer 1..100 (rejects 0, negatives, >100, decimals, non-numbers). */
export function assertPassMark(v: unknown): asserts v is number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 100) {
    throw new ValidationError("passing_score_pct must be a whole number from 1 to 100", {
      details: { code: "INVALID_PARAM", param: "passing_score_pct" },
    });
  }
}

/** Integrity v1: reject a malformed settings.integrity (typed sub-key, like blueprint). */
export function assertIntegritySettings(settings: AssessmentSettings | undefined): void {
  const raw = (settings as Record<string, unknown> | undefined)?.["integrity"];
  if (raw === undefined) return;
  const r = AssessmentIntegritySettingsSchema.safeParse(raw);
  if (!r.success) {
    throw new ValidationError(
      `settings.integrity is invalid: ${r.error.issues.map((i) => i.message).join("; ")}`,
      { details: { code: "INVALID_PARAM", param: "settings.integrity" } },
    );
  }
}

/** Test sections: reject a malformed settings.sections, or sections combined with a blueprint. */
export function assertSectionsSettings(settings: AssessmentSettings | undefined): void {
  const s = settings as Record<string, unknown> | undefined;
  const raw = s?.["sections"];
  if (raw === undefined) return;
  const r = AssessmentSectionsSchema.safeParse(raw);
  if (!r.success) {
    throw new ValidationError(
      `settings.sections is invalid: ${r.error.issues.map((i) => i.message).join("; ")}`,
      { details: { code: "INVALID_PARAM", param: "settings.sections" } },
    );
  }
  if (s?.["blueprint"] !== undefined) {
    throw new ValidationError("settings.sections cannot be combined with settings.blueprint", {
      details: { code: "INVALID_PARAM", param: "settings.sections" },
    });
  }
}

export async function createAssessmentFromSet(
  tenantId: string,
  input: CreateAssessmentFromSetInput,
  createdByUserId: string,
): Promise<Assessment> {
  // 1. License re-check against the SOURCE platform set (throws 403 NOT_LICENSED).
  await assertLicensedForSourcePack(tenantId, input.source_pack_id);

  // 2. Materialise (clone-on-use, idempotent + audited) the set into this tenant.
  const mat = await materializeSetForTenant(input.source_pack_id, tenantId, createdByUserId);

  // 3. Resolve the chosen level within the cloned pack (1-based position).
  const level = mat.levels.find((l) => l.position === input.level_position);
  if (level === undefined) {
    throw new ValidationError(
      `Level position ${input.level_position} not found in the selected set`,
      { details: { code: AL_ERROR_CODES.LEVEL_NOT_FOUND, level_position: input.level_position } },
    );
  }

  // 4. Delegate to the standard create path with the cloned pack + resolved level.
  const createInput: CreateAssessmentInput = {
    pack_id: mat.clonedPackId,
    level_id: level.id,
    name: input.name,
    question_count: input.question_count,
  };
  if (input.description !== undefined) createInput.description = input.description;
  if (input.randomize !== undefined) createInput.randomize = input.randomize;
  if (input.passing_score_pct !== undefined) createInput.passing_score_pct = input.passing_score_pct;
  if (input.settings !== undefined) {
    // from-set resolves pack/level from the CLONED set. A blueprint would
    // override that and is a super_admin-only authoring capability (enforced at
    // POST /api/admin/assessments). Strip any blueprint smuggled in through
    // this path so a tenant admin cannot bypass that gate via from-set.
    const settingsWithoutBlueprint: AssessmentSettings = { ...input.settings };
    delete settingsWithoutBlueprint.blueprint;
    createInput.settings = settingsWithoutBlueprint;
  }
  if (input.opens_at !== undefined) createInput.opens_at = input.opens_at;
  if (input.closes_at !== undefined) createInput.closes_at = input.closes_at;

  return createAssessment(tenantId, createInput, createdByUserId);
}

// ---------------------------------------------------------------------------
// importLicensedSet — clone a licensed platform set without creating an assessment
// ---------------------------------------------------------------------------
//
// Company-admin path: stock the workspace up front by cloning a licensed
// PLATFORM-library set into this tenant's Question Bank without creating an
// assessment. Flow: license re-check against the SOURCE set → materialise
// (clone-on-use, idempotent + audited) into this tenant.
//
// Security invariant: assertLicensedForSourcePack runs BEFORE materializeSetForTenant.
// This ordering is critical — never clone first.
export async function importLicensedSet(
  tenantId: string,
  sourcePackId: string,
  createdByUserId: string,
): Promise<{ cloned_pack_id: string; slug: string; reused: boolean; question_count: number }> {
  // 1. License re-check against the SOURCE platform set (throws 403 NOT_LICENSED).
  await assertLicensedForSourcePack(tenantId, sourcePackId);

  // 2. Materialise (clone-on-use, idempotent + audited) the set into this tenant.
  const mat = await materializeSetForTenant(sourcePackId, tenantId, createdByUserId);

  return {
    cloned_pack_id: mat.clonedPackId,
    slug: mat.clonedSlug,
    reused: mat.reusedExisting,
    question_count: mat.questionCount,
  };
}

// ---------------------------------------------------------------------------
// resyncLicensedSet — pull a newer platform-master version into an existing clone
// ---------------------------------------------------------------------------
//
// Company-admin path: update an already-cloned licensed set in this tenant's
// Question Bank to the latest version published by the platform. Flow:
// license re-check against the SOURCE set → resync (diff-apply, idempotent + audited).
//
// Security invariant: assertLicensedForSourcePack runs BEFORE resyncSetForTenant.
// This ordering mirrors importLicensedSet — never resync without a valid license.
export async function resyncLicensedSet(
  tenantId: string,
  sourcePackId: string,
  actorUserId: string,
): Promise<{ updated: boolean; from_version: number; to_version: number; added: number; changed: number; archived: number; skipped: number }> {
  // License must still be active to pull updates (same gate as import).
  await assertLicensedForSourcePack(tenantId, sourcePackId);
  const r = await resyncSetForTenant(sourcePackId, tenantId, actorUserId);
  return {
    updated: r.updated,
    from_version: r.fromVersion,
    to_version: r.toVersion,
    added: r.added,
    changed: r.changed,
    archived: r.archived,
    skipped: r.skipped,
  };
}

// ---------------------------------------------------------------------------
// updateAssessmentIntegrity
// ---------------------------------------------------------------------------

/**
 * Change only settings.integrity (merged server-side; blueprint and any other
 * settings keys are untouched). Allowed in ANY status, including after publish:
 * the candidate view reads settings live, so it affects attempts started
 * afterwards and a student mid-test picks it up on their next page load.
 */
export async function updateAssessmentIntegrity(
  tenantId: string,
  id: string,
  integrity: { fullscreen: boolean; block_copy_paste: boolean },
  updatedByUserId: string,
): Promise<Assessment> {
  return withTenant(tenantId, async (client) => {
    const current = await repo.findAssessmentById(client, id);
    if (current === null) {
      throw new NotFoundError(`Assessment not found: ${id}`, {
        details: { code: AL_ERROR_CODES.ASSESSMENT_NOT_FOUND },
      });
    }
    const updated = await repo.setIntegrityRow(client, id, integrity);
    const prev = (current.settings as Record<string, unknown> | undefined)?.["integrity"] ?? null;
    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: updatedByUserId,
      action: "assessment.updated",
      entityType: "assessment",
      entityId: id,
      before: { integrity: prev },
      after: { integrity },
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// updateAssessmentGrading
// ---------------------------------------------------------------------------

/**
 * Change only settings.high_stakes (two-model grading vote). Any status; affects
 * AI grading runs started afterwards (module 07 reads it live).
 */
export async function updateAssessmentGrading(
  tenantId: string,
  id: string,
  grading: { high_stakes: boolean },
  updatedByUserId: string,
): Promise<Assessment> {
  return withTenant(tenantId, async (client) => {
    const current = await repo.findAssessmentById(client, id);
    if (current === null) {
      throw new NotFoundError(`Assessment not found: ${id}`, {
        details: { code: AL_ERROR_CODES.ASSESSMENT_NOT_FOUND },
      });
    }
    const updated = await repo.setHighStakesRow(client, id, grading.high_stakes);
    const prev = (current.settings as Record<string, unknown> | undefined)?.["high_stakes"] ?? null;
    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: updatedByUserId,
      action: "assessment.updated",
      entityType: "assessment",
      entityId: id,
      before: { high_stakes: prev },
      after: { high_stakes: grading.high_stakes },
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// updateAssessment
// ---------------------------------------------------------------------------

/** Key-order-independent JSON for deep-equality checks (undefined == null). */
function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(norm)
      : x !== null && typeof x === "object"
        ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, y]) => [k, norm(y)]))
        : (x ?? null);
  return JSON.stringify(norm(v));
}

export async function updateAssessment(
  tenantId: string,
  id: string,
  patch: UpdateAssessmentPatch,
  updatedByUserId: string,
): Promise<Assessment> {
  log.info({ tenantId, id }, "updateAssessment");

  // ── Blueprint path pre-flight (C1) — mirrors createAssessment pattern ─────
  // Validate + resolve BEFORE the main withTenant to avoid nested withTenant calls
  // (findOrCreatePackForDomain uses its own withTenant internally).
  // The category-level FK guard is performed inside the main withTenant below
  // (needs the tenant-scoped client).
  assertIntegritySettings(patch.settings);
  assertRemindersSettings(patch.settings);
  assertSectionsSettings(patch.settings);
  if (patch.passing_score_pct !== undefined) assertPassMark(patch.passing_score_pct);
  let resolvedBlueprintOverride: { packId: string; levelId: string; questionCount: number } | null = null;
  let validatedBlueprint: ResolvedBlueprint | null = null;
  const rawPatchBlueprint = (patch.settings as Record<string, unknown> | undefined)?.["blueprint"];

  if (rawPatchBlueprint !== undefined) {
    const parseResult = AssessmentBlueprintSchema.safeParse(rawPatchBlueprint);
    if (!parseResult.success) {
      throw new ValidationError(
        `settings.blueprint is invalid: ${parseResult.error.issues.map((i) => i.message).join("; ")}`,
        { details: { code: AL_ERROR_CODES.BLUEPRINT_INVALID, issues: parseResult.error.issues } },
      );
    }
    validatedBlueprint = await resolveBlueprint(tenantId, parseResult.data);
    // Resolve pack/level before entering withTenant (findOrCreatePackForDomain has its own withTenant)
    resolvedBlueprintOverride = await resolveBlueprintPackLevel(tenantId, validatedBlueprint, updatedByUserId);
  }

  return withTenant(tenantId, async (client) => {
    const current = await repo.findAssessmentById(client, id);
    if (current === null) {
      throw new NotFoundError(`Assessment not found: ${id}`, {
        details: { code: AL_ERROR_CODES.ASSESSMENT_NOT_FOUND },
      });
    }

    // Only 'draft' assessments are mutable
    if (current.status !== "draft") {
      throw new ConflictError(
        `Assessment '${id}' must be in 'draft' status to update (current: '${current.status}')`,
        { details: { code: AL_ERROR_CODES.ASSESSMENT_NOT_DRAFT } },
      );
    }

    // Slice A.2 — reject explicit opens_at: null patch (prevent clearing it).
    // A patch that omits opens_at is unaffected (undefined = no-op).
    if (patch.opens_at === null) {
      throw new ValidationError(
        "opens_at is required: an assessment with no opens_at never transitions to active (time-boundary worker requires opens_at IS NOT NULL)",
        { details: { code: AL_ERROR_CODES.OPENS_AT_REQUIRED, field: "opens_at" } },
      );
    }

    // Sections are frozen once any attempt exists (draws + section_index are per attempt).
    if (patch.settings !== undefined) {
      const cur = (current.settings as Record<string, unknown> | undefined)?.["sections"];
      const next = (patch.settings as Record<string, unknown>)["sections"];
      if (canonicalJson(cur) !== canonicalJson(next)) {
        const has = await client.query(`SELECT 1 FROM attempts WHERE assessment_id = $1 LIMIT 1`, [id]);
        if (has.rows.length > 0) {
          throw new ConflictError("Sections can't be changed after students have started this test.", {
            details: { code: AL_ERROR_CODES.SECTIONS_LOCKED },
          });
        }
      }
    }

    // If either time-window field is in the patch, validate the merged window
    if (patch.opens_at !== undefined || patch.closes_at !== undefined) {
      const mergedOpensAt =
        patch.opens_at !== undefined ? patch.opens_at : current.opens_at;
      const mergedClosesAt =
        patch.closes_at !== undefined ? patch.closes_at : current.closes_at;
      assertValidWindow(mergedOpensAt, mergedClosesAt);
    }

    // ── Blueprint path in patch (C1) — category FK guard + apply pre-resolved values ──
    // Validation and pack/level resolution already happened above (outside withTenant).
    // Here we only run the category-level FK guard (requires tenant-scoped client)
    // and merge the resolved overrides into the repo patch.
    if (validatedBlueprint !== null && resolvedBlueprintOverride !== null) {
      await assertBlueprintFKOwnership(client, tenantId, validatedBlueprint);
    }

    // Build conditional patch — exactOptionalPropertyTypes: never pass undefined
    const repoPatch: Parameters<typeof repo.updateAssessmentRow>[2] = {};
    if (patch.name !== undefined) repoPatch.name = patch.name;
    if (patch.description !== undefined) repoPatch.description = patch.description;
    if (patch.passing_score_pct !== undefined) repoPatch.passingScorePct = patch.passing_score_pct;
    if (patch.randomize !== undefined) repoPatch.randomize = patch.randomize;
    if (patch.opens_at !== undefined) repoPatch.opensAt = patch.opens_at;
    if (patch.closes_at !== undefined) repoPatch.closesAt = patch.closes_at;

    if (validatedBlueprint !== null && resolvedBlueprintOverride !== null) {
      // Blueprint path — override question_count, pack_id, level_id, settings
      repoPatch.questionCount = resolvedBlueprintOverride.questionCount;
      repoPatch.packId = resolvedBlueprintOverride.packId;
      repoPatch.levelId = resolvedBlueprintOverride.levelId;
      repoPatch.settings = { ...(patch.settings ?? {}), blueprint: validatedBlueprint };
    } else {
      // No-blueprint path — apply patch fields as before (unchanged)
      if (patch.question_count !== undefined) repoPatch.questionCount = patch.question_count;
      if (patch.settings !== undefined) repoPatch.settings = patch.settings;
    }

    const updated = await repo.updateAssessmentRow(client, id, repoPatch);

    // Field-level change: record which fields changed (not full settings JSONB
    // since it may grow arbitrary in Phase 2+ — keeps the audit_log row small).
    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: updatedByUserId,
      action: "assessment.updated",
      entityType: "assessment",
      entityId: id,
      before: {
        name: current.name,
        question_count: current.question_count,
        passing_score_pct: current.passing_score_pct,
        randomize: current.randomize,
        opens_at: current.opens_at?.toISOString() ?? null,
        closes_at: current.closes_at?.toISOString() ?? null,
      },
      after: {
        name: updated.name,
        question_count: updated.question_count,
        passing_score_pct: updated.passing_score_pct,
        randomize: updated.randomize,
        opens_at: updated.opens_at?.toISOString() ?? null,
        closes_at: updated.closes_at?.toISOString() ?? null,
        changed_fields: Object.keys(repoPatch),
        has_blueprint: rawPatchBlueprint !== undefined,
      },
    });

    return updated;
  });
}

