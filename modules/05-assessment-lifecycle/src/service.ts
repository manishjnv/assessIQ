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
 * tenantName in sendInvitationEmail:
 * Phase 1 passes an empty string for tenantName — the service does not fetch
 * tenants.name (no tenancy module helper for that yet). Flagged at each call
 * site; a follow-up should pull tenants.name inside the withTenant scope.
 */

import {
  streamLogger,
  NotFoundError,
  ValidationError,
  ConflictError,
  uuidv7,
} from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import type { PoolClient } from "pg";
import * as repo from "./repository.js";
// NOTE: @assessiq/question-bank exposes only its service surface from its
// package barrel. The repository functions (findPackById, findLevelById) are
// internal. We reach them via a relative workspace path. This is intentional
// and documented — a future clean-up could add a `/repository` export entry
// in 04's package.json `exports` map gated to internal workspace consumers.
import * as qbRepo from "../../04-question-bank/src/repository.js";
import {
  assertCanTransition,
  assertValidWindow,
  assertReopenAllowed,
} from "./state-machine.js";
import { generateInvitationToken, DEFAULT_INVITATION_TTL_HOURS } from "./tokens.js";
import { sendInvitationEmail } from "./email.js";
import { AL_ERROR_CODES } from "./types.js";
import type {
  Assessment,
  AssessmentInvitation,
  CreateAssessmentInput,
  ListAssessmentsInput,
  ListInvitationsInput,
  PaginatedAssessments,
  PaginatedInvitations,
  PreviewQuestionSet,
  UpdateAssessmentPatch,
  InviteUsersResult,
} from "./types.js";

const log = streamLogger("app");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PAGE_SIZE = 100;

/**
 * Read once at module load — never shell out per inviteUsers call.
 * Callers that need a different base URL set ASSESSIQ_PUBLIC_URL before
 * the process starts.
 */
const PUBLIC_URL =
  process.env["ASSESSIQ_PUBLIC_URL"] ?? "https://assessiq.automateedge.cloud";

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
  // Validate window before touching the DB (avoids a round-trip on bad input)
  assertValidWindow(input.opens_at ?? null, input.closes_at ?? null);

  const id = uuidv7();
  log.info({ tenantId, id, packId: input.pack_id, levelId: input.level_id }, "createAssessment");

  return withTenant(tenantId, async (client) => {
    // a. Pack must exist (RLS scopes the SELECT to this tenant)
    const pack = await qbRepo.findPackById(client, input.pack_id);
    if (pack === null) {
      throw new NotFoundError(`Pack not found: ${input.pack_id}`, {
        details: { code: AL_ERROR_CODES.PACK_NOT_FOUND },
      });
    }

    // b. Pack must be published
    if (pack.status !== "published") {
      throw new ConflictError(
        `Pack '${input.pack_id}' must be in 'published' status to create an assessment (current: '${pack.status}')`,
        { details: { code: AL_ERROR_CODES.PACK_NOT_PUBLISHED } },
      );
    }

    // c. Level must exist (RLS scopes through pack FK)
    const level = await qbRepo.findLevelById(client, input.level_id);
    if (level === null) {
      throw new NotFoundError(`Level not found: ${input.level_id}`, {
        details: { code: AL_ERROR_CODES.LEVEL_NOT_FOUND },
      });
    }

    // d. Level must belong to the specified pack
    if (level.pack_id !== input.pack_id) {
      throw new ValidationError(
        `Level '${input.level_id}' does not belong to pack '${input.pack_id}'`,
        { details: { code: AL_ERROR_CODES.LEVEL_NOT_IN_PACK } },
      );
    }

    // e+f. Insert assessment; pack_version is snapshotted from the current pack version
    return repo.insertAssessment(client, {
      id,
      tenantId,
      packId: input.pack_id,
      levelId: input.level_id,
      packVersion: pack.version,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      questionCount: input.question_count,
      randomize: input.randomize ?? true,
      opensAt: input.opens_at ?? null,
      closesAt: input.closes_at ?? null,
      settings: input.settings ?? {},
      createdBy: createdByUserId,
    });
  });
}

// ---------------------------------------------------------------------------
// updateAssessment
// ---------------------------------------------------------------------------

export async function updateAssessment(
  tenantId: string,
  id: string,
  patch: UpdateAssessmentPatch,
): Promise<Assessment> {
  log.info({ tenantId, id }, "updateAssessment");

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

    // If either time-window field is in the patch, validate the merged window
    if (patch.opens_at !== undefined || patch.closes_at !== undefined) {
      const mergedOpensAt =
        patch.opens_at !== undefined ? patch.opens_at : current.opens_at;
      const mergedClosesAt =
        patch.closes_at !== undefined ? patch.closes_at : current.closes_at;
      assertValidWindow(mergedOpensAt, mergedClosesAt);
    }

    // Build conditional patch — exactOptionalPropertyTypes: never pass undefined
    const repoPatch: Parameters<typeof repo.updateAssessmentRow>[2] = {};
    if (patch.name !== undefined) repoPatch.name = patch.name;
    if (patch.description !== undefined) repoPatch.description = patch.description;
    if (patch.question_count !== undefined) repoPatch.questionCount = patch.question_count;
    if (patch.randomize !== undefined) repoPatch.randomize = patch.randomize;
    if (patch.opens_at !== undefined) repoPatch.opensAt = patch.opens_at;
    if (patch.closes_at !== undefined) repoPatch.closesAt = patch.closes_at;
    if (patch.settings !== undefined) repoPatch.settings = patch.settings;

    return repo.updateAssessmentRow(client, id, repoPatch);
  });
}

// ---------------------------------------------------------------------------
// publishAssessment — draft → published (with pool-size pre-flight)
// ---------------------------------------------------------------------------

export async function publishAssessment(
  tenantId: string,
  id: string,
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

    // c. Pool-size pre-flight: count active questions for (pack_id, level_id)
    //    Uses inline SQL (see countActiveQuestionsForLevel rationale above).
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

    // d. Transition to published
    return repo.updateAssessmentRow(client, id, { status: "published" });
  });
}

// ---------------------------------------------------------------------------
// closeAssessment — active → closed
// ---------------------------------------------------------------------------

export async function closeAssessment(
  tenantId: string,
  id: string,
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

    return repo.updateAssessmentRow(client, id, { status: "closed" });
  });
}

// ---------------------------------------------------------------------------
// reopenAssessment — closed → published (requires now < closes_at)
// ---------------------------------------------------------------------------

export async function reopenAssessment(
  tenantId: string,
  id: string,
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

    return repo.updateAssessmentRow(client, id, { status: "published" });
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

      // Build the accept URL with plaintext token (email body only)
      const invitationLink = `${PUBLIC_URL}/invite/${plaintext}`;

      // Send via 13-notifications shim — never inline SMTP here
      // TODO (follow-up): pass tenants.name instead of empty string once the
      // tenancy module exports a getTenantName(client, tenantId) helper.
      await sendInvitationEmail({
        to: user.email,
        candidateName: user.name,
        assessmentName: assessment.name,
        invitationLink,
        expiresAt,
        tenantName: "",
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
): Promise<void> {
  log.info({ tenantId, invitationId }, "revokeInvitation");

  await withTenant(tenantId, async (client) => {
    const invitation = await repo.findInvitationById(client, invitationId);
    if (invitation === null) {
      throw new NotFoundError(`Invitation not found: ${invitationId}`, {
        details: { code: AL_ERROR_CODES.INVITATION_NOT_FOUND },
      });
    }

    // Idempotent — already expired is a no-op (don't error)
    if (invitation.status === "expired") {
      return;
    }

    await repo.updateInvitationStatus(client, invitationId, "expired");
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
