/**
 * Service layer for module 05-assessment-lifecycle.
 *
 * IMPORTANT — RLS-only scoping (same rule as 04-question-bank):
 * All queries run through a PoolClient that has already received
 * `SET LOCAL ROLE assessiq_app` and `set_config('app.current_tenant', $tenantId, true)`
 * from withTenant(). Row-Level Security enforces tenant isolation at the Postgres layer.
 * Do NOT add redundant tenant_id WHERE filters in this file — that would mask RLS bugs.
 *
 * Transaction semantics:
 * withTenant wraps its callback in BEGIN / COMMIT so every multi-step operation
 * (publishAssessment, inviteUsers) that runs inside a single withTenant call is
 * automatically a single database transaction.
 *
 * Pool-size pre-flight (publishAssessment):
 * Counts active questions for (pack_id, level_id) directly via a client.query
 * inside the same withTenant scope (RLS still applies). The question-bank
 * repository's listQuestionRows helper applies a per-page cap so we cannot use
 * it for a raw count without extra gymnastics; a direct COUNT query is cheaper
 * and more explicit. Flagged below — a `countActiveQuestionsForLevel` helper
 * should be added to 04's repository in a follow-up.
 *
 * Token security:
 * Invitation tokens are 32-byte CSPRNG values encoded as base64url. Only the
 * sha256 hash is persisted; the plaintext is placed in the invitation link
 * (email body only) and never logged or stored.
 *
 */

import {
  streamLogger,
  NotFoundError,
  ValidationError,
  ConflictError,
  uuidv7,
  config,
} from "@assessiq/core";
import { withTenant, getPool } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import { assertPublishEntitled, assertLicensedForSourcePack } from "@assessiq/billing";
import * as tenancyRepo from "../../02-tenancy/src/repository.js";
import { hashInvitationToken } from "./tokens.js";
import type { PoolClient } from "pg";
import * as repo from "./repository.js";
// NOTE: @assessiq/question-bank exposes only its service surface from its
// package barrel. The repository functions (findPackById, findLevelById) are
// internal. We reach them via a relative workspace path. This is intentional
// and documented — a future clean-up could add a `/repository` export entry
// in 04's package.json `exports` map gated to internal workspace consumers.
import * as qbRepo from "../../04-question-bank/src/repository.js";
import { findOrCreatePackForDomain } from "../../04-question-bank/src/service.js";
// Step 2 — clone-on-use: materialise a licensed platform set into this tenant.
// Relative import mirrors the qbRepo / findOrCreatePackForDomain pattern above.
import { materializeSetForTenant, resyncSetForTenant } from "../../04-question-bank/src/clone.js";
import {
  assertCanTransition,
  assertValidWindow,
  assertReopenAllowed,
} from "./state-machine.js";
import { generateInvitationToken, DEFAULT_INVITATION_TTL_HOURS } from "./tokens.js";
import { sendInvitationEmail } from "./email.js";
import { AL_ERROR_CODES, AssessmentBlueprintSchema } from "./types.js";
import type {
  Assessment,
  AssessmentBlueprint,
  AssessmentInvitation,
  AssessmentSettings,
  AssessmentStatus,
  CreateAssessmentInput,
  CreateAssessmentFromSetInput,
  InvitationStatus,
  ListAssessmentsInput,
  ListInvitationsInput,
  PaginatedAssessments,
  PaginatedInvitations,
  PreviewCriterionResult,
  PreviewQuestionSet,
  UpdateAssessmentPatch,
  InviteUsersResult,
} from "./types.js";
import type { InvitationCounts } from "./repository.js";

const log = streamLogger("app");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PAGE_SIZE = 100;

/**
 * Read once at module load — never shell out per inviteUsers call.
 * Callers that need a different base URL set ASSESSIQ_BASE_URL before
 * the process starts (see modules/00-core/src/config.ts).
 */
const PUBLIC_URL = config.ASSESSIQ_BASE_URL;

// ---------------------------------------------------------------------------
// Local helpers (mirror 04-question-bank pattern — re-implemented locally)
// ---------------------------------------------------------------------------

function assertPageSize(pageSize: number): void {
  if (pageSize > MAX_PAGE_SIZE) {
    throw new ValidationError(
      `pageSize must not exceed ${MAX_PAGE_SIZE}`,
      { details: { code: AL_ERROR_CODES.INVALID_PAGE_SIZE, pageSize, max: MAX_PAGE_SIZE } },
    );
  }
}

/**
 * Translate a Postgres unique-violation (23505) to a ConflictError with the
 * given domain error code. Re-throws all other errors unchanged.
 */
function _rethrowUnique(err: unknown, code: string, message: string): never {
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
 * Count active questions for a (pack_id, level_id) pair.
 *
 * Uses a direct client.query rather than qbRepo.listQuestionRows because the
 * list helper is paginated and would require a two-pass COUNT workaround.
 * RLS still applies — the client is already scoped to the current tenant via
 * withTenant. Flagged: a `countActiveQuestionsForLevel(client, packId, levelId)`
 * helper should be added to 04-question-bank's repository to remove this
 * inline SQL from module 05.
 */
async function countActiveQuestionsForLevel(
  client: PoolClient,
  packId: string,
  levelId: string,
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*) FROM questions
     WHERE pack_id = $1 AND level_id = $2 AND status = 'active'`,
    [packId, levelId],
  );
  return parseInt(result.rows[0]?.count ?? "0", 10);
}

/**
 * Pull up to `limit` active questions for a (pack_id, level_id) pair.
 * Used by previewAssessment — no write to attempts, no snapshot.
 *
 * Same rationale as countActiveQuestionsForLevel: direct SQL inside the
 * tenant-scoped client. A `listActiveQuestionsForLevel(client, packId,
 * levelId, limit)` helper in 04's repository would be the clean follow-up.
 */
async function listActiveQuestionsForPreview(
  client: PoolClient,
  packId: string,
  levelId: string,
  limit: number,
): Promise<unknown[]> {
  const QUESTION_COLUMNS =
    `id, pack_id, level_id, type, topic, points, status, version,
     content, rubric, created_by, created_at, updated_at`;
  const result = await client.query(
    `SELECT ${QUESTION_COLUMNS} FROM questions
     WHERE pack_id = $1 AND level_id = $2 AND status = 'active'
     ORDER BY created_at ASC, id ASC
     LIMIT $3`,
    [packId, levelId, limit],
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Blueprint helpers (Phase 2 Slice A)
// ---------------------------------------------------------------------------

/**
 * Count active questions for a single blueprint criterion
 * (pack_id + level_id + domain_id + category_id + type + status='active').
 *
 * Runs inside the caller's tenant-scoped withTenant client; RLS applies.
 * Used by publishAssessment pool pre-flight (C2) and previewAssessment (C4).
 */
async function countActiveQuestionsForCriterion(
  client: PoolClient,
  packId: string,
  levelId: string,
  domainId: string,
  categoryId: string,
  type: string,
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*) FROM questions
     WHERE pack_id = $1 AND level_id = $2 AND domain_id = $3
       AND category_id = $4 AND type = $5 AND status = 'active'`,
    [packId, levelId, domainId, categoryId, type],
  );
  return parseInt(result.rows[0]?.count ?? "0", 10);
}

/**
 * Pull up to `limit` active questions for a single blueprint criterion.
 * Used by previewAssessment (C4) to show sample topics.
 */
async function listActiveQuestionsForCriterion(
  client: PoolClient,
  packId: string,
  levelId: string,
  domainId: string,
  categoryId: string,
  type: string,
  limit: number,
): Promise<unknown[]> {
  const result = await client.query(
    `SELECT id, topic, type, points FROM questions
     WHERE pack_id = $1 AND level_id = $2 AND domain_id = $3
       AND category_id = $4 AND type = $5 AND status = 'active'
     ORDER BY created_at ASC, id ASC
     LIMIT $6`,
    [packId, levelId, domainId, categoryId, type, limit],
  );
  return result.rows;
}

/**
 * Validate blueprint cross-tenant FK integrity (C1 — primary security control).
 *
 * SECURITY: blueprint.domain_id and criterion.category_id are stored in JSONB.
 * Postgres FK validation bypasses RLS so a malicious request could reference
 * a domain or category from another tenant's JSONB blob. This explicit guard
 * is the only control preventing that — same class as the 2.1b/2.1c guard in
 * modules/04-question-bank/src/handlers/admin-domains.ts:261-273 and
 * modules/04-question-bank/src/service.ts:1286-1295.
 *
 * Steps:
 *   1. Verify domain_id belongs to session tenant.
 *   2. For each DISTINCT category_id, verify it belongs to session tenant
 *      AND is a child of blueprint.domain_id.
 *
 * Any miss → throws ValidationError 422 CROSS_TENANT_FK_REJECTED.
 *
 * Runs inside the caller's tenant-scoped withTenant client.
 */
async function assertBlueprintFKOwnership(
  client: PoolClient,
  tenantId: string,
  blueprint: AssessmentBlueprint,
): Promise<void> {
  // 1. Domain guard
  const domainGuard = await client.query<{ slug: string }>(
    `SELECT slug FROM domains WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [blueprint.domain_id, tenantId],
  );
  if (domainGuard.rows.length === 0) {
    throw new ValidationError(
      "blueprint.domain_id does not exist or does not belong to this tenant",
      {
        details: {
          code: AL_ERROR_CODES.CROSS_TENANT_FK_REJECTED,
          field: "blueprint.domain_id",
          domain_id: blueprint.domain_id,
        },
      },
    );
  }

  // 2. Per-distinct-category guard
  const distinctCategoryIds = [...new Set(blueprint.criteria.map((c) => c.category_id))];
  for (const categoryId of distinctCategoryIds) {
    const catGuard = await client.query<{ id: string }>(
      `SELECT id FROM categories
       WHERE id = $1 AND domain_id = $2 AND tenant_id = $3
       LIMIT 1`,
      [categoryId, blueprint.domain_id, tenantId],
    );
    if (catGuard.rows.length === 0) {
      throw new ValidationError(
        `blueprint category_id does not exist, does not belong to this tenant, or does not belong to the specified domain`,
        {
          details: {
            code: AL_ERROR_CODES.CROSS_TENANT_FK_REJECTED,
            field: "blueprint.criteria[].category_id",
            category_id: categoryId,
            domain_id: blueprint.domain_id,
          },
        },
      );
    }
  }
}

/**
 * Resolve pack/level from blueprint + update assessment fields.
 * Calls findOrCreatePackForDomain (already Opus-reviewed, cross-tenant-guarded)
 * to get packId/levelIds, then returns the fields to persist.
 *
 * IMPORTANT: findOrCreatePackForDomain uses its own withTenant internally.
 * This is intentional — the resolver is designed as a standalone service call.
 * The resolved pack_id/level_id are then passed back into the caller's
 * withTenant scope for the INSERT/UPDATE.
 */
async function resolveBlueprintPackLevel(
  tenantId: string,
  blueprint: AssessmentBlueprint,
  createdByUserId: string,
): Promise<{ packId: string; levelId: string; questionCount: number }> {
  const resolver = await findOrCreatePackForDomain(tenantId, blueprint.domain_id, createdByUserId);
  const levelId = resolver.levelIds[blueprint.level];
  const questionCount = blueprint.criteria.reduce((sum, c) => sum + c.count, 0);
  return { packId: resolver.packId, levelId, questionCount };
}

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
    const blueprint = parseResult.data;

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
      const blueprint = mergedSettings.blueprint!;
      await assertBlueprintFKOwnership(client, tenantId, blueprint);
    }

    // a. Pack must exist (RLS scopes the SELECT to this tenant)
    const pack = await qbRepo.findPackById(client, resolvedInput.pack_id);
    if (pack === null) {
      throw new NotFoundError(`Pack not found: ${resolvedInput.pack_id}`, {
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
        `Pack '${resolvedInput.pack_id}' must be in 'published' status to create an assessment (current: '${pack.status}')`,
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
        `Level '${resolvedInput.level_id}' does not belong to pack '${resolvedInput.pack_id}'`,
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
// updateAssessment
// ---------------------------------------------------------------------------

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
  let resolvedBlueprintOverride: { packId: string; levelId: string; questionCount: number } | null = null;
  let validatedBlueprint: AssessmentBlueprint | null = null;
  const rawPatchBlueprint = (patch.settings as Record<string, unknown> | undefined)?.["blueprint"];

  if (rawPatchBlueprint !== undefined) {
    const parseResult = AssessmentBlueprintSchema.safeParse(rawPatchBlueprint);
    if (!parseResult.success) {
      throw new ValidationError(
        `settings.blueprint is invalid: ${parseResult.error.issues.map((i) => i.message).join("; ")}`,
        { details: { code: AL_ERROR_CODES.BLUEPRINT_INVALID, issues: parseResult.error.issues } },
      );
    }
    validatedBlueprint = parseResult.data;
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
        randomize: current.randomize,
        opens_at: current.opens_at,
        closes_at: current.closes_at,
      },
      after: {
        name: updated.name,
        question_count: updated.question_count,
        randomize: updated.randomize,
        opens_at: updated.opens_at,
        closes_at: updated.closes_at,
        changed_fields: Object.keys(repoPatch),
        has_blueprint: rawPatchBlueprint !== undefined,
      },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// freezeAssessmentPool — "lock at assignment" snapshot (additive)
// ---------------------------------------------------------------------------
//
// Snapshots the assessment's EXACT eligible question pool at publish time into
// assessment_frozen_pool (migration 0096). After this, module 06 startAttempt
// draws from the frozen set instead of the live pool, so master-pack revisions
// and clone auto-sync only reach NEWLY-published assessments — already-assigned
// tests keep their original content (and every candidate of one assessment sees
// the same pool, closing the fairness gap).
//
// Captures the SAME pool listActiveQuestionPoolForPick would return at this
// instant: every status='active' question in (pack, level), pinned to
// MAX(question_versions.version), plus the taxonomy fields the blueprint draw
// re-filters on. The full (pack, level) active set is frozen uniformly — the
// legacy draw uses all rows; the blueprint draw filters by (domain, category,
// type) at draw time. INNER JOIN question_versions mirrors the live query, so a
// question with no snapshot is excluded identically (see RCA 2026-05-25 clone
// snapshot fix).
//
// WRITE-ONCE / idempotent: ON CONFLICT (assessment_id, question_id) DO NOTHING.
// publishAssessment (draft→published) is the first freeze; reopenAssessment
// (closed→published) re-invokes this but the rows already exist, so it is a
// no-op — the original freeze stands. Returns the assessment's total frozen
// pool size (for the audit payload), not just the rows inserted this call.
//
// Runs inside the caller's withTenant tx (RLS-scoped to the assessment tenant).
async function freezeAssessmentPool(
  client: PoolClient,
  tenantId: string,
  assessmentId: string,
  packId: string,
  levelId: string,
): Promise<number> {
  await client.query(
    `INSERT INTO assessment_frozen_pool
       (tenant_id, assessment_id, question_id, question_version,
        level_id, domain_id, category_id, type, points)
     SELECT $1, $2, q.id, MAX(qv.version)::int,
            q.level_id, q.domain_id, q.category_id, q.type, q.points
       FROM questions q
       JOIN question_versions qv ON qv.question_id = q.id
      WHERE q.pack_id = $3 AND q.level_id = $4 AND q.status = 'active'
      GROUP BY q.id, q.level_id, q.domain_id, q.category_id, q.type, q.points
     ON CONFLICT (assessment_id, question_id) DO NOTHING`,
    [tenantId, assessmentId, packId, levelId],
  );

  const sized = await client.query<{ count: string }>(
    `SELECT count(*) FROM assessment_frozen_pool WHERE assessment_id = $1`,
    [assessmentId],
  );
  return parseInt(sized.rows[0]?.count ?? "0", 10);
}

// ---------------------------------------------------------------------------
// publishAssessment — draft → published (with pool-size pre-flight)
// ---------------------------------------------------------------------------

export async function publishAssessment(
  tenantId: string,
  id: string,
  publishedByUserId: string,
): Promise<Assessment> {
  log.info({ tenantId, id }, "publishAssessment");

  return withTenant(tenantId, async (client) => {
    // a. Read assessment
    const assessment = await repo.findAssessmentById(client, id);
    if (assessment === null) {
      throw new NotFoundError(`Assessment not found: ${id}`, {
        details: { code: AL_ERROR_CODES.ASSESSMENT_NOT_FOUND },
      });
    }

    // b. Enforce state machine — draft → published only (closed → published
    //    must go through reopenAssessment)
    assertCanTransition(assessment.status, "published");

    // B2 — server-authoritative entitlement enforcement (authorization gate).
    // Runs in this withTenant tx; throws AppError 403 NOT_ENTITLED if the
    // assessment's pack is not entitled (internal tier bypasses). Fail-fast
    // before pool work. See modules/19-billing assertPublishEntitled + spec B2.
    await assertPublishEntitled(client, tenantId, assessment.pack_id);

    // c. Pool-size pre-flight
    //    Blueprint path (C2): per-criterion check.
    //    No-blueprint path: existing whole-pool count unchanged.
    const blueprint = (assessment.settings as Record<string, unknown>)?.["blueprint"] as
      | AssessmentBlueprint
      | undefined;

    if (blueprint !== undefined) {
      // C2: per-criterion pool pre-flight. All criteria must pass.
      for (let idx = 0; idx < blueprint.criteria.length; idx++) {
        const criterion = blueprint.criteria[idx]!;
        const criterionAvailable = await countActiveQuestionsForCriterion(
          client,
          assessment.pack_id,
          assessment.level_id,
          blueprint.domain_id,
          criterion.category_id,
          criterion.type,
        );
        if (criterionAvailable < criterion.count) {
          throw new ValidationError(
            `Blueprint criterion ${idx} pool too small: ${criterionAvailable} available < ${criterion.count} required (category_id=${criterion.category_id}, type=${criterion.type})`,
            {
              details: {
                code: AL_ERROR_CODES.POOL_TOO_SMALL_CRITERION,
                criterion_index: idx,
                category_id: criterion.category_id,
                type: criterion.type,
                available: criterionAvailable,
                required: criterion.count,
              },
            },
          );
        }
      }
    } else {
      // No-blueprint: existing whole-pool check unchanged
      const available = await countActiveQuestionsForLevel(
        client,
        assessment.pack_id,
        assessment.level_id,
      );
      if (available < assessment.question_count) {
        throw new ValidationError(
          `Question pool too small: ${available} < ${assessment.question_count}`,
          {
            details: {
              code: AL_ERROR_CODES.POOL_TOO_SMALL,
              available,
              required: assessment.question_count,
            },
          },
        );
      }
    }

    // d. Transition to published
    const updated = await repo.updateAssessmentRow(client, id, { status: "published" });

    // e. "Lock at assignment" — freeze the eligible pool now (additive). The
    //    pre-flight above guaranteed the pool is non-empty and large enough, so
    //    this captures a validated snapshot. Write-once: the first publish
    //    freezes; a later reopen finds the rows and is a no-op.
    const frozenPoolSize = await freezeAssessmentPool(
      client,
      tenantId,
      id,
      assessment.pack_id,
      assessment.level_id,
    );

    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: publishedByUserId,
      action: "assessment.published",
      entityType: "assessment",
      entityId: id,
      before: { status: assessment.status },
      after: {
        status: updated.status,
        question_count: assessment.question_count,
        has_blueprint: blueprint !== undefined,
        frozen_pool_size: frozenPoolSize,
      },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// closeAssessment — active → closed
// ---------------------------------------------------------------------------

export async function closeAssessment(
  tenantId: string,
  id: string,
  closedByUserId: string,
): Promise<Assessment> {
  log.info({ tenantId, id }, "closeAssessment");

  return withTenant(tenantId, async (client) => {
    const assessment = await repo.findAssessmentById(client, id);
    if (assessment === null) {
      throw new NotFoundError(`Assessment not found: ${id}`, {
        details: { code: AL_ERROR_CODES.ASSESSMENT_NOT_FOUND },
      });
    }

    // assertCanTransition enforces active → closed only;
    // draft → closed and closed → closed are both illegal.
    assertCanTransition(assessment.status, "closed");

    const updated = await repo.updateAssessmentRow(client, id, { status: "closed" });

    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: closedByUserId,
      action: "assessment.closed",
      entityType: "assessment",
      entityId: id,
      before: { status: assessment.status },
      after: { status: updated.status },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// reopenAssessment — closed → published (requires now < closes_at)
// ---------------------------------------------------------------------------

export async function reopenAssessment(
  tenantId: string,
  id: string,
  reopenedByUserId: string,
): Promise<Assessment> {
  log.info({ tenantId, id }, "reopenAssessment");

  return withTenant(tenantId, async (client) => {
    const assessment = await repo.findAssessmentById(client, id);
    if (assessment === null) {
      throw new NotFoundError(`Assessment not found: ${id}`, {
        details: { code: AL_ERROR_CODES.ASSESSMENT_NOT_FOUND },
      });
    }

    // closed → published via the state machine
    assertCanTransition(assessment.status, "published");

    // Time-boundary check: cannot reopen past closes_at
    assertReopenAllowed(new Date(), assessment.closes_at);

    // B2 — server-authoritative entitlement enforcement (authorization gate,
    // reopen path). Runs in this withTenant tx; throws AppError 403 NOT_ENTITLED
    // if the assessment's pack is not entitled (internal tier bypasses).
    // See modules/19-billing assertPublishEntitled + spec B2.
    await assertPublishEntitled(client, tenantId, assessment.pack_id);

    const updated = await repo.updateAssessmentRow(client, id, { status: "published" });

    // "Lock at assignment" — write-once freeze. A normally-published assessment
    // is already frozen, so this is a no-op (ON CONFLICT DO NOTHING) and the
    // original content stands. The only case it inserts is a legacy assessment
    // published BEFORE migration 0096 (no frozen rows yet) being reopened — it
    // freezes the current pool then, which is the forward-only fallback.
    const frozenPoolSize = await freezeAssessmentPool(
      client,
      tenantId,
      id,
      assessment.pack_id,
      assessment.level_id,
    );

    // Reuse assessment.published with after.kind=reopen — same pattern as
    // 04-question-bank's restoreVersion → question.updated kind=restore.
    // Keeps the action catalog tight; forensic queries filter on
    // after->>'kind' = 'reopen' when distinguishing initial publish from reopen.
    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: reopenedByUserId,
      action: "assessment.published",
      entityType: "assessment",
      entityId: id,
      before: { status: assessment.status },
      after: {
        kind: "reopen",
        status: updated.status,
        closes_at: updated.closes_at,
        frozen_pool_size: frozenPoolSize,
      },
    });

    return updated;
  });
}

// ===========================================================================
// PRE-AUTH INVITATION RESOLVER (magic-link /take/:token entry point)
// ===========================================================================

/**
 * Resolve an invitation by its plaintext token. Pre-auth (no req.session yet)
 * — uses the assessiq_system BYPASSRLS role for the cross-tenant lookup, since
 * the request hasn't yet authenticated and we don't know the tenant_id.
 *
 * Returns the invitation + the related assessment + level metadata + the
 * candidate user's identifying fields. Returns null when:
 *   - the token doesn't match any stored token_hash
 *   - the matching invitation has expired (expires_at < now)
 *   - the invitation status is 'expired' (admin-revoked)
 *
 * IMPORTANT — security:
 *   1. The token plaintext is hashed via the SAME sha256 helper that the
 *      issuance side uses (`hashInvitationToken`). Equality on the indexed
 *      `token_hash` column gives constant-time-ish lookup without a separate
 *      timingSafeEqual — the failure mode of a partial match is no row returned.
 *   2. The token plaintext MUST NOT be logged. Callers logging a request
 *      should log only the hash prefix (first 8 hex chars) for traceability.
 *   3. Returns null for any of the three failure cases without distinguishing
 *      them — no oracle for "token exists but is expired" vs "token doesn't
 *      exist". The route handler returns the same generic 404 envelope for all
 *      three so a caller cannot enumerate.
 *   4. Returning user.email + user.name ONLY when the token is fully valid —
 *      pre-auth callers cannot fish for "what email is associated with this
 *      token" without a working credential.
 */
export interface ResolvedInvitation {
  invitation: AssessmentInvitation;
  assessment: Assessment;
  level: { id: string; label: string; duration_minutes: number };
  candidate: { id: string; email: string; name: string };
  /** Distinct from invitation.status — true when start is allowed (pending/viewed/started). */
  can_start: boolean;
  /** True when invitation.status is 'submitted' (the candidate already finished). */
  already_submitted: boolean;
}

export async function resolveInvitationToken(
  plaintext: string,
): Promise<ResolvedInvitation | null> {
  if (typeof plaintext !== "string" || plaintext.length < 16) {
    // Defence against trivial calls — base64url-32 is 43 chars, anything under
    // 16 is structurally not an issued token. Returning null here also avoids
    // hashing pathological inputs.
    return null;
  }

  const tokenHash = hashInvitationToken(plaintext);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE assessiq_system");

    interface Row {
      // assessment_invitations
      inv_id: string;
      inv_assessment_id: string;
      inv_user_id: string;
      inv_token_hash: string;
      inv_expires_at: Date;
      inv_status: string;
      inv_invited_by: string;
      inv_created_at: Date;
      // assessments
      a_id: string;
      a_tenant_id: string;
      a_pack_id: string;
      a_level_id: string;
      a_pack_version: number;
      a_name: string;
      a_description: string | null;
      a_status: string;
      a_question_count: number;
      a_randomize: boolean;
      a_opens_at: Date | null;
      a_closes_at: Date | null;
      a_settings: unknown;
      a_created_by: string;
      a_created_at: Date;
      a_updated_at: Date;
      // levels
      l_id: string;
      l_label: string;
      l_duration_minutes: number;
      // users
      u_id: string;
      u_email: string;
      u_name: string;
    }

    const result = await client.query<Row>(
      `SELECT
         ai.id              AS inv_id,
         ai.assessment_id   AS inv_assessment_id,
         ai.user_id         AS inv_user_id,
         ai.token_hash      AS inv_token_hash,
         ai.expires_at      AS inv_expires_at,
         ai.status          AS inv_status,
         ai.invited_by      AS inv_invited_by,
         ai.created_at      AS inv_created_at,
         a.id               AS a_id,
         a.tenant_id        AS a_tenant_id,
         a.pack_id          AS a_pack_id,
         a.level_id         AS a_level_id,
         a.pack_version     AS a_pack_version,
         a.name             AS a_name,
         a.description      AS a_description,
         a.status           AS a_status,
         a.question_count   AS a_question_count,
         a.randomize        AS a_randomize,
         a.opens_at         AS a_opens_at,
         a.closes_at        AS a_closes_at,
         a.settings         AS a_settings,
         a.created_by       AS a_created_by,
         a.created_at       AS a_created_at,
         a.updated_at       AS a_updated_at,
         l.id               AS l_id,
         l.label            AS l_label,
         l.duration_minutes AS l_duration_minutes,
         u.id               AS u_id,
         u.email            AS u_email,
         u.name             AS u_name
       FROM assessment_invitations ai
       JOIN assessments a ON a.id = ai.assessment_id
       JOIN levels      l ON l.id = a.level_id
       JOIN users       u ON u.id = ai.user_id
       WHERE ai.token_hash = $1
       LIMIT 1`,
      [tokenHash],
    );
    await client.query("COMMIT");

    const row = result.rows[0];
    if (row === undefined) return null;

    // Expiry / revocation gates — silent null so the API returns a generic 404.
    const now = Date.now();
    if (row.inv_expires_at.getTime() < now) return null;
    if (row.inv_status === "expired") return null;

    return {
      invitation: {
        id: row.inv_id,
        assessment_id: row.inv_assessment_id,
        user_id: row.inv_user_id,
        token_hash: row.inv_token_hash,
        expires_at: row.inv_expires_at,
        status: row.inv_status as InvitationStatus,
        invited_by: row.inv_invited_by,
        created_at: row.inv_created_at,
      },
      assessment: {
        id: row.a_id,
        tenant_id: row.a_tenant_id,
        pack_id: row.a_pack_id,
        level_id: row.a_level_id,
        pack_version: row.a_pack_version,
        name: row.a_name,
        description: row.a_description,
        status: row.a_status as AssessmentStatus,
        question_count: row.a_question_count,
        randomize: row.a_randomize,
        opens_at: row.a_opens_at,
        closes_at: row.a_closes_at,
        settings: (row.a_settings ?? {}) as Assessment["settings"],
        created_by: row.a_created_by,
        created_at: row.a_created_at,
        updated_at: row.a_updated_at,
      },
      level: {
        id: row.l_id,
        label: row.l_label,
        duration_minutes: row.l_duration_minutes,
      },
      candidate: {
        id: row.u_id,
        email: row.u_email,
        name: row.u_name,
      },
      can_start: row.inv_status !== "submitted",
      already_submitted: row.inv_status === "submitted",
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // Secondary rollback failure — connection is likely dead. Swallow.
    });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Mark an invitation as 'viewed' — called from the GET /take/:token handler
 * the first time a candidate clicks the email link. Idempotent: re-calling on
 * an already-viewed/started/submitted invitation is a no-op.
 *
 * RLS-scoped via withTenant — the caller must have already resolved the
 * tenant_id from `resolveInvitationToken().assessment.tenant_id`.
 */
export async function markInvitationViewedByToken(
  tenantId: string,
  invitationId: string,
): Promise<void> {
  await withTenant(tenantId, async (client) => {
    // Only flip pending → viewed; never regress from started/submitted.
    await client.query(
      `UPDATE assessment_invitations SET status = 'viewed'
       WHERE id = $1 AND status = 'pending'`,
      [invitationId],
    );
  });
}

// ===========================================================================
// INVITATION OPERATIONS
// ===========================================================================

// ---------------------------------------------------------------------------
// inviteUsers
// ---------------------------------------------------------------------------

export async function inviteUsers(
  tenantId: string,
  assessmentId: string,
  userIds: readonly string[],
  invitedByUserId: string,
): Promise<InviteUsersResult> {
  log.info({ tenantId, assessmentId, userCount: userIds.length }, "inviteUsers");

  return withTenant(tenantId, async (client) => {
    // Fetch tenant name once — single DB hit on the same client (RLS + tx
    // consistency), held for all invitees in this batch. The 13-notifications
    // Zod validator enforces .min(1) on tenantName; we never paper over a
    // missing name with the tenant id or slug — the validator is right, the
    // caller must provide a real value (RCA 2026-05-11 Finding C).
    const tenantRow = await tenancyRepo.findTenantById(client, tenantId);
    if (tenantRow === null) {
      throw new NotFoundError(
        `Tenant not found while preparing invitation emails: ${tenantId}`,
        { details: { code: AL_ERROR_CODES.TENANT_NAME_MISSING, tenantId } },
      );
    }
    const tenantName = tenantRow.name?.trim() ?? "";
    if (tenantName.length === 0) {
      throw new ValidationError(
        `Tenant has empty name; cannot send invitation emails (tenant ${tenantId})`,
        { details: { code: AL_ERROR_CODES.TENANT_NAME_MISSING, tenantId } },
      );
    }
    // a. Read assessment
    const assessment = await repo.findAssessmentById(client, assessmentId);
    if (assessment === null) {
      throw new NotFoundError(`Assessment not found: ${assessmentId}`, {
        details: { code: AL_ERROR_CODES.ASSESSMENT_NOT_FOUND },
      });
    }

    // b. Assessment must be published or active for invitations
    if (assessment.status !== "published" && assessment.status !== "active") {
      throw new ConflictError(
        `Cannot invite users to an assessment in '${assessment.status}' status — must be 'published' or 'active'`,
        { details: { code: AL_ERROR_CODES.INVALID_STATE_TRANSITION, current: assessment.status } },
      );
    }

    const invited: AssessmentInvitation[] = [];
    const skipped: Array<{ userId: string; reason: string }> = [];

    // c. Process each userId
    for (const userId of userIds) {
      // User must exist (RLS scopes through app.current_tenant)
      const user = await repo.findUserForInvitation(client, userId);
      if (user === null) {
        skipped.push({ userId, reason: "USER_NOT_FOUND" });
        continue;
      }

      // User must be a candidate
      if (user.role !== "candidate") {
        skipped.push({ userId, reason: "USER_NOT_CANDIDATE" });
        continue;
      }

      // User must be active (not disabled / soft-deleted)
      if (user.status !== "active") {
        skipped.push({ userId, reason: "USER_INACTIVE" });
        continue;
      }

      // Skip if invitation already exists for this (assessment, user) pair
      const existing = await repo.findInvitationByAssessmentAndUser(
        client,
        assessmentId,
        userId,
      );
      if (existing !== null) {
        skipped.push({ userId, reason: "INVITATION_EXISTS" });
        continue;
      }

      // Generate token — plaintext for email, hash for storage
      const { plaintext, hash } = generateInvitationToken();
      const expiresAt = new Date(
        Date.now() + DEFAULT_INVITATION_TTL_HOURS * 3_600_000,
      );

      // Insert invitation — token_hash stored, plaintext never persisted
      const invitation = await repo.insertInvitation(client, {
        id: uuidv7(),
        assessmentId,
        userId,
        tokenHash: hash,
        expiresAt,
        invitedBy: invitedByUserId,
      });

      // Build the accept URL with plaintext token (email body only).
      // Candidates land on /take/<token> — the magic-link SPA route.
      const invitationLink = `${PUBLIC_URL}/take/${plaintext}`;

      // Send via 13-notifications shim — never inline SMTP here.
      // tenantName resolved above (non-empty; throws otherwise).
      await sendInvitationEmail({
        tenantId,
        to: user.email,
        candidateName: user.name,
        assessmentName: assessment.name,
        invitationLink,
        expiresAt,
        tenantName,
      });

      // Audit one row per invitation issued. Per-invitation granularity beats
      // a summary here: forensic queries like "when was user X invited to
      // assessment Y?" rely on each invitation having its own audit row.
      // Skipped users (USER_NOT_FOUND / USER_NOT_CANDIDATE / USER_INACTIVE /
      // INVITATION_EXISTS) intentionally produce no audit row — nothing
      // mutated.
      await auditInTx(client, {
        tenantId,
        actorKind: "user",
        actorUserId: invitedByUserId,
        action: "assessment.invite",
        entityType: "assessment_invitation",
        entityId: invitation.id,
        after: {
          assessment_id: assessmentId,
          user_id: userId,
          expires_at: invitation.expires_at,
          status: invitation.status,
        },
      });

      invited.push(invitation);
    }

    return { invited, skipped };
  });
}

// ---------------------------------------------------------------------------
// listInvitations
// ---------------------------------------------------------------------------

export async function listInvitations(
  tenantId: string,
  assessmentId: string,
  filters?: ListInvitationsInput,
): Promise<PaginatedInvitations> {
  const page = filters?.page ?? 1;
  const pageSize = filters?.pageSize ?? 20;

  assertPageSize(pageSize);

  return withTenant(tenantId, async (client) => {
    // Guard: verify assessment exists (a miss would otherwise silently return [])
    const assessment = await repo.findAssessmentById(client, assessmentId);
    if (assessment === null) {
      throw new NotFoundError(`Assessment not found: ${assessmentId}`, {
        details: { code: AL_ERROR_CODES.ASSESSMENT_NOT_FOUND },
      });
    }

    const { items, total } = await repo.listInvitationRows(client, assessmentId, {
      ...filters,
      page,
      pageSize,
    });
    return { items, page, pageSize, total };
  });
}

// ---------------------------------------------------------------------------
// revokeInvitation — mark status='expired'; idempotent on already-expired
// ---------------------------------------------------------------------------

export async function revokeInvitation(
  tenantId: string,
  invitationId: string,
  revokedByUserId: string,
): Promise<void> {
  log.info({ tenantId, invitationId }, "revokeInvitation");

  await withTenant(tenantId, async (client) => {
    const invitation = await repo.findInvitationById(client, invitationId);
    if (invitation === null) {
      throw new NotFoundError(`Invitation not found: ${invitationId}`, {
        details: { code: AL_ERROR_CODES.INVITATION_NOT_FOUND },
      });
    }

    // Idempotent — already expired is a no-op (don't error, don't audit
    // again — nothing changed).
    if (invitation.status === "expired") {
      return;
    }

    await repo.updateInvitationStatus(client, invitationId, "expired");

    // Reuse assessment.invite with after.kind=revoke — same minimal-catalog
    // pattern as reopenAssessment. before.status records what was revoked
    // from (pending/viewed/started/submitted) which is useful forensic context.
    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: revokedByUserId,
      action: "assessment.invite",
      entityType: "assessment_invitation",
      entityId: invitationId,
      before: { status: invitation.status },
      after: {
        kind: "revoke",
        status: "expired",
        assessment_id: invitation.assessment_id,
        user_id: invitation.user_id,
      },
    });
  });
}

// ---------------------------------------------------------------------------
// previewAssessment — admin sample of question pool; no attempt created
// ---------------------------------------------------------------------------

export async function previewAssessment(
  tenantId: string,
  id: string,
): Promise<PreviewQuestionSet> {
  return withTenant(tenantId, async (client) => {
    // a. Read assessment
    const assessment = await repo.findAssessmentById(client, id);
    if (assessment === null) {
      throw new NotFoundError(`Assessment not found: ${id}`, {
        details: { code: AL_ERROR_CODES.ASSESSMENT_NOT_FOUND },
      });
    }

    const blueprint = (assessment.settings as Record<string, unknown>)?.["blueprint"] as
      | AssessmentBlueprint
      | undefined;

    if (blueprint !== undefined) {
      // C4 — blueprint-aware preview: per-criterion adequacy + sample
      let totalPoolSize = 0;
      const blueprintCriteria: PreviewCriterionResult[] = [];

      for (let idx = 0; idx < blueprint.criteria.length; idx++) {
        const criterion = blueprint.criteria[idx]!;
        const criterionAvailable = await countActiveQuestionsForCriterion(
          client,
          assessment.pack_id,
          assessment.level_id,
          blueprint.domain_id,
          criterion.category_id,
          criterion.type,
        );
        totalPoolSize += criterionAvailable;

        const sampleLimit = Math.min(criterionAvailable, criterion.count);
        const sample = sampleLimit > 0
          ? await listActiveQuestionsForCriterion(
              client,
              assessment.pack_id,
              assessment.level_id,
              blueprint.domain_id,
              criterion.category_id,
              criterion.type,
              sampleLimit,
            )
          : [];

        blueprintCriteria.push({
          criterion_index: idx,
          category_id: criterion.category_id,
          type: criterion.type,
          required: criterion.count,
          available: criterionAvailable,
          sample,
        });
      }

      return {
        assessment_id: assessment.id,
        pack_id: assessment.pack_id,
        pack_version: assessment.pack_version,
        level_id: assessment.level_id,
        pool_size: totalPoolSize,
        question_count: assessment.question_count,
        questions: [],   // no flat sample in blueprint mode — use blueprint_criteria
        blueprint_criteria: blueprintCriteria,
      };
    }

    // No-blueprint path — existing behaviour unchanged
    // b. Count active questions in the pool
    const poolSize = await countActiveQuestionsForLevel(
      client,
      assessment.pack_id,
      assessment.level_id,
    );

    // c. Pull up to min(pool_size, question_count) questions for the preview
    const previewLimit = Math.min(poolSize, assessment.question_count);
    const questions = previewLimit > 0
      ? await listActiveQuestionsForPreview(
          client,
          assessment.pack_id,
          assessment.level_id,
          previewLimit,
        )
      : [];

    return {
      assessment_id: assessment.id,
      pack_id: assessment.pack_id,
      pack_version: assessment.pack_version,
      level_id: assessment.level_id,
      pool_size: poolSize,
      question_count: assessment.question_count,
      questions,
    };
  });
}
