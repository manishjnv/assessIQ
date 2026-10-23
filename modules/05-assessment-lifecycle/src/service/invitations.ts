import { AppError, NotFoundError, ValidationError, ConflictError, uuidv7, UUID_RE, attemptsAllowed } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import * as tenancyRepo from "../../../02-tenancy/src/repository.js";
import type { PoolClient } from "pg";
import * as repo from "../repository.js";
import { requireRevokeAttemptSubmitter } from "./revoke-submitter.js";
import { generateInvitationToken, DEFAULT_INVITATION_TTL_HOURS } from "../tokens.js";
import { resolveCameraRequired, sendInvitationEmail } from "../email.js";
import type { SendAssessmentInvitationInput } from "../email.js";
import { AL_ERROR_CODES } from "../types.js";
import type { Assessment, AssessmentInvitation, AssessmentStatus, BulkResendResult, ListInvitationsInput, PaginatedInvitations, InviteUsersResult } from "../types.js";
import { log, BULK_RESEND_MAX, BULK_RESEND_RECENT_MINUTES, PUBLIC_URL, assertPageSize, assertPoolVerifiedForInvites, assertInviteCapacity } from "./_shared.js";
import { notifyInviteLimitBlocked } from "@assessiq/notifications";

// ===========================================================================
// INVITATION OPERATIONS
// ===========================================================================

// ---------------------------------------------------------------------------
// Shared helpers — invite / resend / re-invite
// ---------------------------------------------------------------------------

/**
 * Resolve the tenant display name used in invitation emails. The
 * 13-notifications Zod validator enforces .min(1) on tenantName; we never paper
 * over a missing name with the tenant id or slug — the validator is right, the
 * caller must provide a real value (RCA 2026-05-11 Finding C).
 */
async function resolveTenantNameForEmail(
  client: PoolClient,
  tenantId: string,
): Promise<string> {
  const tenantRow = await tenancyRepo.findTenantById(client, tenantId);
  if (tenantRow === null) {
    throw new NotFoundError(
      `Organisation not found while preparing invitation emails: ${tenantId}`,
      { details: { code: AL_ERROR_CODES.TENANT_NAME_MISSING, tenantId } },
    );
  }
  const tenantName = tenantRow.name?.trim() ?? "";
  if (tenantName.length === 0) {
    throw new ValidationError(
      `Organisation has an empty name; cannot send invitation emails (organisation ${tenantId})`,
      { details: { code: AL_ERROR_CODES.TENANT_NAME_MISSING, tenantId } },
    );
  }
  return tenantName;
}

/** published / active are the only assessment states that accept (re)issued invitations. */
function acceptsInvitations(status: AssessmentStatus): boolean {
  return status === "published" || status === "active";
}

/**
 * A link that no longer works: admin-revoked (status 'expired') or lapsed by
 * time (still pending/viewed but past expires_at — the resolver rejects both).
 * Started / submitted invitations are never "dead": their link is irrelevant.
 */
function isLinkDead(
  inv: Pick<AssessmentInvitation, "status" | "expires_at">,
): boolean {
  if (inv.status === "expired") return true;
  return (
    (inv.status === "pending" || inv.status === "viewed") &&
    inv.expires_at.getTime() <= Date.now()
  );
}

/**
 * Has the candidate started this assessment? Invitation status alone is not
 * enough: revokeInvitation overwrites ANY status with 'expired', so a
 * revoked-after-start invitation is only recognisable by its attempt row.
 */
async function candidateHasStarted(
  client: PoolClient,
  inv: Pick<AssessmentInvitation, "status" | "assessment_id" | "user_id">,
): Promise<boolean> {
  if (inv.status === "started" || inv.status === "submitted") return true;
  return repo.hasStartedAttempt(client, inv.assessment_id, inv.user_id);
}

/**
 * EXP-37: how many NEW active invitations inviteUsers would create for this list. Read-only mirror of the
 * loop's own rules (same skips, same dead-link test), so the limit is checked BEFORE any email goes out.
 * A lapsed-by-time pending link is still counted as active, so reviving it adds nothing; only an
 * admin-revoked ('expired') invitation, or no invitation at all, adds one.
 */
async function countInvitesToCreate(client: PoolClient, assessmentId: string, userIds: readonly string[]): Promise<number> {
  let adding = 0;
  for (const userId of new Set(userIds)) {
    const user = await repo.findUserForInvitation(client, userId);
    if (user === null || user.role !== "candidate" || user.status !== "active" || user.erased) continue;
    const existing = await repo.findInvitationByAssessmentAndUser(client, assessmentId, userId);
    if (existing === null) {
      adding++;
    } else if (existing.status === "expired" && !(await candidateHasStarted(client, existing))) {
      adding++;
    }
  }
  return adding;
}

/**
 * EXP-37: after an INVITE_LIMIT_EXCEEDED refusal (the invite transaction is already rolled back), write the
 * audit row every time and tell the super admins (throttled once per assessment per day inside the notice).
 * Best-effort: nothing here may throw or change the error the admin sees. Ids and counts only in the audit row.
 */
async function recordInviteLimitBlocked(err: unknown, tenantId: string, actorUserId: string): Promise<void> {
  if (!(err instanceof ConflictError) || err.details?.["code"] !== AL_ERROR_CODES.INVITE_LIMIT_EXCEEDED) return;
  const d = err.details as { limit: number; active: number; adding: number; assessment_id: string };
  let facts: { orgName: string; adminName: string; adminEmail: string; assessmentName: string } | null = null;
  try {
    facts = await withTenant(tenantId, async (client) => {
      await auditInTx(client, {
        tenantId,
        actorKind: "user",
        actorUserId,
        action: "assessment.invite_limit_blocked",
        entityType: "assessment",
        entityId: d.assessment_id,
        after: { assessment_id: d.assessment_id, limit: d.limit, active: d.active, adding: d.adding },
      });
      const tenant = await tenancyRepo.findTenantById(client, tenantId);
      const assessment = await repo.findAssessmentById(client, d.assessment_id);
      const admin = await repo.findUserForInvitation(client, actorUserId);
      return {
        orgName: tenant?.name ?? "Unknown organisation",
        adminName: admin?.name ?? "An admin",
        adminEmail: admin?.email ?? "unknown",
        assessmentName: assessment?.name ?? "an assessment",
      };
    });
  } catch (auditErr) {
    log.error({ err: auditErr, tenantId }, "invite limit blocked: audit write failed");
  }
  if (facts === null) return;
  try {
    await notifyInviteLimitBlocked({ tenantId, assessmentId: d.assessment_id, tried: d.active + d.adding, limit: d.limit, ...facts });
  } catch (noticeErr) {
    log.error({ err: noticeErr, tenantId }, "invite limit blocked: notice failed");
  }
}

function invitationNotFound(invitationId: string): NotFoundError {
  return new NotFoundError(`Invitation not found: ${invitationId}`, {
    details: { code: AL_ERROR_CODES.INVITATION_NOT_FOUND },
  });
}

function assessmentNotFound(assessmentId: string): NotFoundError {
  return new NotFoundError(`Assessment not found: ${assessmentId}`, {
    details: { code: AL_ERROR_CODES.ASSESSMENT_NOT_FOUND },
  });
}

function assertAssessmentAcceptsResend(assessment: Assessment): void {
  if (!acceptsInvitations(assessment.status)) {
    throw new ConflictError(
      `Invitations can only be resent while the assessment is published or active (this one is ${assessment.status}).`,
      { details: { code: AL_ERROR_CODES.ASSESSMENT_NOT_ACTIVE, current: assessment.status } },
    );
  }
}

function candidateErasedError(): ConflictError {
  return new ConflictError(
    "This candidate's data has been erased, so no invitation can be sent.",
    { details: { code: AL_ERROR_CODES.CANDIDATE_ERASED } },
  );
}

function alreadyStartedError(): ConflictError {
  return new ConflictError(
    "This candidate has already started this assessment, so their invitation can't be resent.",
    { details: { code: AL_ERROR_CODES.INVITATION_ALREADY_STARTED } },
  );
}

/**
 * Re-issue the link of an EXISTING invitation row on the caller's transaction:
 *   - fresh token → the old link stops resolving the moment this commits;
 *   - expires_at = now + DEFAULT_INVITATION_TTL_HOURS (7 days);
 *   - status back to 'pending', last_resent_at stamped;
 *   - exactly ONE audit row (the only auditInTx for resend / re-invite).
 *
 * `kind: "resend"` audits as `assessment.invitation.resent` (admin pressed
 * Resend); `kind: "reinvite"` audits as `assessment.invite` (admin invited a
 * student whose earlier invitation was revoked / lapsed — the invite path keeps
 * its own action so "who was invited when" queries stay in one place).
 *
 * Returns null — nothing changed, nothing audited — when the row is already
 * started / submitted. The plaintext token is returned ONLY so the caller can
 * put it in the email link; it is never persisted or logged.
 */
async function reissueInvitationInTx(
  client: PoolClient,
  args: {
    tenantId: string;
    /** The row as read BEFORE the re-issue (feeds the audit `before`). */
    invitation: AssessmentInvitation;
    actorUserId: string;
    kind: "resend" | "reinvite";
    /** Z-89: new test type on a re-invite; omitted = keep. */
    deliveryMode?: "real" | "mock";
  },
): Promise<{ invitation: AssessmentInvitation; plaintext: string } | null> {
  const { plaintext, hash } = generateInvitationToken();
  const expiresAt = new Date(
    Date.now() + DEFAULT_INVITATION_TTL_HOURS * 3_600_000,
  );
  const updated = await repo.reissueInvitation(
    client,
    args.invitation.id,
    hash,
    expiresAt,
    args.deliveryMode ?? null,
  );
  if (updated === null) return null;

  await auditInTx(client, {
    tenantId: args.tenantId,
    actorKind: "user",
    actorUserId: args.actorUserId,
    action:
      args.kind === "resend" ? "assessment.invitation.resent" : "assessment.invite",
    entityType: "assessment_invitation",
    entityId: updated.id,
    // ISO strings, not Date objects: redactPayload() walks objects with
    // Object.entries(), which flattens a Date to {} in the stored JSON.
    before: {
      status: args.invitation.status,
      expires_at: args.invitation.expires_at.toISOString(),
      delivery_mode: args.invitation.delivery_mode,
    },
    after: {
      kind: args.kind,
      delivery_mode: updated.delivery_mode,
      status: updated.status,
      expires_at: updated.expires_at.toISOString(),
      assessment_id: updated.assessment_id,
      user_id: updated.user_id,
    },
  });

  return { invitation: updated, plaintext };
}

// ---------------------------------------------------------------------------
// resendInvitation / resendInvitations — replace the link, extend, email again
// ---------------------------------------------------------------------------

/**
 * ONE transaction per invitation: validate, re-issue the link, audit. Returns
 * the updated row plus the email to send AFTER the commit (a rollback must
 * never leave a student holding a link whose token_hash was never persisted).
 *
 * Allowed while the assessment is published/active and the candidate has NOT
 * started — for pending, viewed, lapsed AND revoked invitations alike (so it is
 * also the "extend" action). Throws:
 *   404 INVITATION_NOT_FOUND         unknown id / other tenant (RLS) / malformed id
 *   409 ASSESSMENT_NOT_ACTIVE        assessment is draft / closed / cancelled
 *   409 INVITATION_ALREADY_STARTED   candidate has an attempt (or started/submitted)
 *   409 USER_INACTIVE                candidate account disabled / not a candidate
 */
async function reissueForResend(
  tenantId: string,
  invitationId: string,
  actorUserId: string,
): Promise<{ invitation: AssessmentInvitation; email: SendAssessmentInvitationInput }> {
  if (!UUID_RE.test(invitationId)) throw invitationNotFound(invitationId);

  try {
    return await reissueForResendTx(tenantId, invitationId, actorUserId);
  } catch (err) {
    await recordInviteLimitBlocked(err, tenantId, actorUserId);
    throw err;
  }
}

async function reissueForResendTx(
  tenantId: string,
  invitationId: string,
  actorUserId: string,
): Promise<{ invitation: AssessmentInvitation; email: SendAssessmentInvitationInput }> {
  return withTenant(tenantId, async (client) => {
    // Resolve the email's tenant name FIRST so a bad tenant row fails before
    // any token is rotated.
    const tenantName = await resolveTenantNameForEmail(client, tenantId);

    // Row lock: serialises with a candidate hitting Begin (06 markInvitationStarted)
    // and with a second resend of the same row.
    const invitation = await repo.findInvitationById(client, invitationId, {
      forUpdate: true,
    });
    if (invitation === null) throw invitationNotFound(invitationId);

    const assessment = await repo.findAssessmentById(client, invitation.assessment_id);
    if (assessment === null) throw assessmentNotFound(invitation.assessment_id);
    assertAssessmentAcceptsResend(assessment);
    await assertPoolVerifiedForInvites(client, assessment, "resend the invitation"); // EXP-18

    if (await candidateHasStarted(client, invitation)) throw alreadyStartedError();

    // EXP-37: resending a revoked invitation brings it back to life, so it counts again.
    if (invitation.status === "expired") await assertInviteCapacity(client, tenantId, invitation.assessment_id, 1);

    const user = await repo.findUserForInvitation(client, invitation.user_id);
    if (user === null || user.role !== "candidate" || user.status !== "active") {
      throw new ConflictError(
        "This candidate's account is disabled, so the invitation can't be resent.",
        { details: { code: AL_ERROR_CODES.USER_INACTIVE } },
      );
    }

    if (user.erased) throw candidateErasedError();

    const reissued = await reissueInvitationInTx(client, {
      tenantId,
      invitation,
      actorUserId,
      kind: "resend",
    });
    // Defensive: the row is locked FOR UPDATE, so this only fires if the status
    // guard in the UPDATE disagrees with the read above.
    if (reissued === null) throw alreadyStartedError();

    return {
      invitation: reissued.invitation,
      email: {
        tenantId,
        to: user.email,
        candidateName: user.name,
        assessmentName: assessment.name,
        invitationLink: `${PUBLIC_URL}/take/${reissued.plaintext}`,
        expiresAt: reissued.invitation.expires_at,
        tenantName,
        deliveryMode: reissued.invitation.delivery_mode,
      },
    };
  });
}

/**
 * Send the (re)issued invitation email AFTER the transaction committed, with
 * the same shim the invite path uses. If it fails the DB already holds the new
 * token (the old link is dead), so tell the admin plainly — pressing Resend
 * again is safe (it just rotates the token once more).
 */
async function sendAfterCommit(
  email: SendAssessmentInvitationInput,
  invitationId: string,
): Promise<void> {
  try {
    await sendInvitationEmail(email);
  } catch (err) {
    log.error({ err, invitationId }, "resend: invitation email failed after commit");
    throw new AppError(
      "The new link was created but the email could not be sent. Press Resend again to retry.",
      AL_ERROR_CODES.INVITATION_EMAIL_FAILED,
      502,
      {
        details: { code: AL_ERROR_CODES.INVITATION_EMAIL_FAILED },
        cause: err,
      },
    );
  }
}

/**
 * Resend ONE invitation: fresh token (old link stops working), expires_at =
 * now + 7 days, status back to 'pending', one audit row — all in one
 * transaction — then the invitation email, sent after the commit.
 */
export async function resendInvitation(
  tenantId: string,
  invitationId: string,
  actorUserId: string,
): Promise<AssessmentInvitation> {
  log.info({ tenantId, invitationId }, "resendInvitation");
  const { invitation, email } = await reissueForResend(
    tenantId,
    invitationId,
    actorUserId,
  );
  await sendAfterCommit(email, invitation.id);
  return invitation;
}

/** Stable skip code for one failed row of the bulk resend. */
function skipCodeOf(err: unknown): string {
  if (err instanceof AppError) {
    const code = err.details?.["code"];
    return typeof code === "string" ? code : err.code;
  }
  return "INTERNAL";
}

/**
 * Resend every invitation of an assessment whose candidate has not started
 * (pending, viewed, lapsed-by-time — NOT revoked; only the single resend
 * revives those). At most BULK_RESEND_MAX per call, oldest invitation first;
 * `remaining` counts the eligible rows beyond the cap that were not touched.
 *
 * Each invitation runs in its OWN transaction (one bad row never rolls back
 * the others) and its email goes out right after ITS commit. Links re-issued
 * in the last BULK_RESEND_RECENT_MINUTES are skipped, so calling again
 * continues with the rest instead of re-sending the first batch.
 *
 * ponytail: sequential — ≤200 rows × (tx + queue add) is a few seconds; add a
 * small concurrency window if campus-scale latency ever matters.
 */
export async function resendInvitations(
  tenantId: string,
  assessmentId: string,
  actorUserId: string,
): Promise<BulkResendResult> {
  log.info({ tenantId, assessmentId }, "resendInvitations");
  if (!UUID_RE.test(assessmentId)) throw assessmentNotFound(assessmentId);

  const recentCutoff = new Date(Date.now() - BULK_RESEND_RECENT_MINUTES * 60_000);
  const { ids, total } = await withTenant(tenantId, async (client) => {
    const assessment = await repo.findAssessmentById(client, assessmentId);
    if (assessment === null) throw assessmentNotFound(assessmentId);
    assertAssessmentAcceptsResend(assessment);
    await assertPoolVerifiedForInvites(client, assessment, "resend invitations"); // EXP-18: fail once, not 200 skips
    return repo.listResendableInvitationIds(
      client,
      assessmentId,
      recentCutoff,
      BULK_RESEND_MAX,
    );
  });

  let resent = 0;
  const skipped: BulkResendResult["skipped"] = [];
  for (const id of ids) {
    try {
      const { invitation, email } = await reissueForResend(tenantId, id, actorUserId);
      await sendAfterCommit(email, invitation.id);
      resent++;
    } catch (err) {
      if (!(err instanceof AppError)) {
        log.error({ err, invitationId: id }, "resendInvitations: row failed");
      }
      skipped.push({ id, code: skipCodeOf(err) });
    }
  }

  const remaining = Math.max(0, total - ids.length);
  // S7/N5: one bulk-level audit row (per-row sends already committed above).
  await withTenant(tenantId, (client) =>
    auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId,
      action: "assessment.invitations.bulk_resent",
      entityType: "assessment",
      entityId: assessmentId,
      after: { resent, skipped: skipped.length, remaining },
    }),
  );

  return { resent, skipped, remaining };
}

// ---------------------------------------------------------------------------
// inviteUsers
// ---------------------------------------------------------------------------

export async function inviteUsers(
  tenantId: string,
  assessmentId: string,
  userIds: readonly string[],
  invitedByUserId: string,
  /** Z-89: test type chosen by the admin; omitted = the assessment's own default. Validated by the route. */
  deliveryMode?: "real" | "mock",
): Promise<InviteUsersResult> {
  log.info({ tenantId, assessmentId, userCount: userIds.length }, "inviteUsers");

  // Resolved ONCE per batch, BEFORE the transaction opens. The resolver opens its own tenant connection, so calling it per
  // invitee inside the open transaction would hold one pooled connection and wait for a second (pool deadlock under load).
  // The rule only depends on the test type being real, so the real-mode answer is enough for every invitee.
  const realCameraRequired = await resolveCameraRequired(tenantId, "real");

  try {
    return await inviteUsersTx(tenantId, assessmentId, userIds, invitedByUserId, deliveryMode, realCameraRequired);
  } catch (err) {
    await recordInviteLimitBlocked(err, tenantId, invitedByUserId);
    throw err;
  }
}

async function inviteUsersTx(
  tenantId: string,
  assessmentId: string,
  userIds: readonly string[],
  invitedByUserId: string,
  deliveryMode: "real" | "mock" | undefined,
  realCameraRequired: boolean,
): Promise<InviteUsersResult> {
  return withTenant(tenantId, async (client) => {
    // Fetch tenant name once — single DB hit on the same client (RLS + tx
    // consistency), held for all invitees in this batch.
    const tenantName = await resolveTenantNameForEmail(client, tenantId);
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

    // EXP-18: no invitation while the pool holds a question that is in_review, disputed or needs_fix.
    await assertPoolVerifiedForInvites(client, assessment);

    // EXP-37: plan limit of invited students per assessment, checked once for the whole batch before any
    // insert or email (a refusal rolls the transaction back; mail already sent could not be recalled).
    await assertInviteCapacity(client, tenantId, assessmentId, await countInvitesToCreate(client, assessmentId, userIds));

    const invited: AssessmentInvitation[] = [];
    const skipped: Array<{ userId: string; reason: string }> = [];
    const mode: "real" | "mock" = deliveryMode ?? assessment.delivery_mode;

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

      // Erased candidates (users.erased_at) are never invited / re-invited.
      if (user.erased) {
        skipped.push({ userId, reason: "CANDIDATE_ERASED" });
        continue;
      }

      // An invitation already exists for this (assessment, user) pair.
      const existing = await repo.findInvitationByAssessmentAndUser(
        client,
        assessmentId,
        userId,
      );
      if (existing !== null) {
        // A live link, or a candidate who already started → "existing", as
        // before: no new token, no duplicate email. (The live-link test runs
        // first so the common path never touches the attempts table.)
        if (!isLinkDead(existing) || (await candidateHasStarted(client, existing))) {
          skipped.push({ userId, reason: "INVITATION_EXISTS" });
          continue;
        }

        // The earlier link is dead (revoked, or lapsed after its 7 days) and
        // the candidate never started → bring the same invitation row back to
        // life with the same effect as Resend: fresh token, 7-day expiry, a
        // new email. Never an error, never a silent skip. Like the new-invite
        // path below, the email is dispatched inline within this batch's
        // transaction.
        const reissued = await reissueInvitationInTx(client, {
          tenantId,
          invitation: existing,
          actorUserId: invitedByUserId,
          kind: "reinvite",
          deliveryMode: mode,
        });
        if (reissued === null) {
          // Lost a race with the candidate starting — treat as existing.
          skipped.push({ userId, reason: "INVITATION_EXISTS" });
          continue;
        }
        await sendInvitationEmail({
          tenantId,
          to: user.email,
          candidateName: user.name,
          assessmentName: assessment.name,
          invitationLink: `${PUBLIC_URL}/take/${reissued.plaintext}`,
          expiresAt: reissued.invitation.expires_at,
          tenantName,
          deliveryMode: mode,
          cameraRequired: mode === "real" && realCameraRequired,
        });
        invited.push(reissued.invitation);
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
        deliveryMode: mode,
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
        deliveryMode: mode,
        cameraRequired: mode === "real" && realCameraRequired,
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
          expires_at: invitation.expires_at.toISOString(),
          status: invitation.status,
          delivery_mode: invitation.delivery_mode,
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

    // Resend affordances for the admin UI. `can_resend` mirrors the single-
    // resend rule (assessment published/active AND candidate not started —
    // revoked and lapsed invitations qualify); `resendable` is the bulk
    // action's total across ALL pages (not just this one).
    const open = acceptsInvitations(assessment.status);
    const resendable = open
      ? await repo.countResendableInvitations(
          client,
          assessmentId,
          new Date(Date.now() - BULK_RESEND_RECENT_MINUTES * 60_000),
        )
      : 0;
    return {
      items: items.map((inv) => ({
        ...inv,
        can_resend:
          open &&
          inv.status !== "started" &&
          inv.status !== "submitted" &&
          (inv.attempt_id == null || inv.attempt_status === "draft"),
        // Z-39 retake affordances: re-open a submitted invitation while attempts are left; an
        // extra attempt can be granted to anyone who has used (or can use) the invitation.
        can_reopen:
          open && inv.status === "submitted" && (inv.attempts_used ?? 0) < (inv.attempts_allowed ?? 1),
        can_grant_extra: open && inv.status !== "expired" && (inv.extra_attempts ?? 0) < 10,
      })),
      page,
      pageSize,
      total,
      resendable,
    };
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
    // A3-2: a revoke also ends a running attempt: it is SUBMITTED and GRADED (marks kept), not discarded.
    // Save and submit refuse a non in_progress attempt afterwards. The submit step is injected by apps/api.
    const runningAttempts = await repo.listInProgressAttemptIds(client, invitation.assessment_id, invitation.user_id);
    const submitRunning = runningAttempts.length > 0 ? requireRevokeAttemptSubmitter() : undefined;
    for (const attemptId of runningAttempts) await submitRunning!(client, tenantId, attemptId);

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
        submitted_attempt_ids: runningAttempts,
      },
    });
  });
}


// ===========================================================================
// Z-39 RETAKE POLICY — extra attempt grant + re-open for the next attempt
// ===========================================================================

/** Longest reason an admin may give for an extra attempt. */
const EXTRA_ATTEMPT_REASON_MAX = 500;

/**
 * Admin gives ONE candidate ONE extra attempt on top of assessments.max_attempts.
 * Reason is required. One audit row per grant, written in the SAME transaction
 * as the counter bump (auditInTx). Allowed while the assessment is published /
 * active. Does not start or re-open anything: if the candidate's last attempt is
 * finished, re-open the invitation (reopenInvitationForRetake) or let them use
 * their link while it is still valid.
 *   404 INVITATION_NOT_FOUND, 409 ASSESSMENT_NOT_ACTIVE, 409 EXTRA_ATTEMPT_LIMIT,
 *   422 INVALID_PARAM (reason missing / too long)
 */
export async function grantExtraAttempt(
  tenantId: string,
  invitationId: string,
  reason: unknown,
  actorUserId: string,
): Promise<{ invitation: AssessmentInvitation; attempts_used: number; attempts_allowed: number }> {
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length === 0 || why.length > EXTRA_ATTEMPT_REASON_MAX) {
    throw new ValidationError(
      `reason is required (1 to ${String(EXTRA_ATTEMPT_REASON_MAX)} characters)`,
      { details: { code: "INVALID_PARAM", param: "reason" } },
    );
  }
  if (!UUID_RE.test(invitationId)) throw invitationNotFound(invitationId);

  return withTenant(tenantId, async (client) => {
    const invitation = await repo.findInvitationById(client, invitationId, { forUpdate: true });
    if (invitation === null) throw invitationNotFound(invitationId);

    const assessment = await repo.findAssessmentById(client, invitation.assessment_id);
    if (assessment === null) throw assessmentNotFound(invitation.assessment_id);
    assertAssessmentAcceptsResend(assessment);

    const updated = await repo.grantExtraAttempt(client, invitation.id);
    if (updated === null) {
      throw new ConflictError("This candidate already has the most extra attempts allowed.", {
        details: { code: AL_ERROR_CODES.EXTRA_ATTEMPT_LIMIT },
      });
    }
    const usage = await repo.getAttemptUsage(client, invitation.assessment_id, invitation.user_id);
    const allowed = attemptsAllowed(assessment.max_attempts, updated.extra_attempts ?? 0);

    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId,
      action: "assessment.invitation.extra_attempt_granted",
      entityType: "assessment_invitation",
      entityId: invitation.id,
      before: { extra_attempts: invitation.extra_attempts ?? 0 },
      after: {
        extra_attempts: updated.extra_attempts ?? 0,
        attempts_allowed: allowed,
        attempts_used: usage.used,
        reason: why,
        assessment_id: invitation.assessment_id,
        user_id: invitation.user_id,
      },
    });
    return { invitation: updated, attempts_used: usage.used, attempts_allowed: allowed };
  });
}

/**
 * Re-open a SUBMITTED invitation so the candidate can sit the next attempt:
 * fresh link (old one dies), 7 days, status 'pending', one audit row, email after
 * the commit. The limit is checked HERE under the invitation row lock:
 *   attempts used >= max_attempts + extra_attempts  -> 409 ATTEMPTS_EXHAUSTED
 *   an attempt still unfinished / invitation not submitted -> 409 RETAKE_NOT_AVAILABLE
 */
export async function reopenInvitationForRetake(
  tenantId: string,
  invitationId: string,
  actorUserId: string,
): Promise<AssessmentInvitation> {
  if (!UUID_RE.test(invitationId)) throw invitationNotFound(invitationId);

  const { invitation, email } = await withTenant(tenantId, async (client) => {
    const tenantName = await resolveTenantNameForEmail(client, tenantId);
    const current = await repo.findInvitationById(client, invitationId, { forUpdate: true });
    if (current === null) throw invitationNotFound(invitationId);

    const assessment = await repo.findAssessmentById(client, current.assessment_id);
    if (assessment === null) throw assessmentNotFound(current.assessment_id);
    assertAssessmentAcceptsResend(assessment);
    await assertPoolVerifiedForInvites(client, assessment, "re-open the invitation"); // EXP-18

    const usage = await repo.getAttemptUsage(client, current.assessment_id, current.user_id);
    if (current.status !== "submitted" || usage.unfinished) {
      throw new ConflictError("This invitation can only be re-opened after the candidate finished an attempt.", {
        details: { code: AL_ERROR_CODES.RETAKE_NOT_AVAILABLE },
      });
    }
    const allowed = attemptsAllowed(assessment.max_attempts, current.extra_attempts ?? 0);
    if (usage.used >= allowed) {
      throw new ConflictError(
        `All ${String(allowed)} allowed attempts are used. Give an extra attempt first.`,
        { details: { code: AL_ERROR_CODES.ATTEMPTS_EXHAUSTED, attempts_used: usage.used, attempts_allowed: allowed } },
      );
    }

    // EXP-37: a re-opened (submitted) invitation is active again, so it counts again.
    await assertInviteCapacity(client, tenantId, current.assessment_id, 1);

    const user = await repo.findUserForInvitation(client, current.user_id);
    if (user === null || user.role !== "candidate" || user.status !== "active") {
      throw new ConflictError("This candidate's account is disabled, so the invitation can't be re-opened.", {
        details: { code: AL_ERROR_CODES.USER_INACTIVE },
      });
    }
    if (user.erased) throw candidateErasedError();

    const { plaintext, hash } = generateInvitationToken();
    const expiresAt = new Date(Date.now() + DEFAULT_INVITATION_TTL_HOURS * 3_600_000);
    const updated = await repo.reopenSubmittedInvitation(client, current.id, hash, expiresAt);
    if (updated === null) {
      throw new ConflictError("This invitation can only be re-opened after the candidate finished an attempt.", {
        details: { code: AL_ERROR_CODES.RETAKE_NOT_AVAILABLE },
      });
    }
    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId,
      action: "assessment.invitation.reopened",
      entityType: "assessment_invitation",
      entityId: current.id,
      before: { status: current.status },
      after: {
        status: updated.status,
        attempt_number_next: usage.used + 1,
        attempts_allowed: allowed,
        expires_at: updated.expires_at.toISOString(),
        assessment_id: current.assessment_id,
        user_id: current.user_id,
      },
    });
    const mail: SendAssessmentInvitationInput = {
      tenantId,
      to: user.email,
      candidateName: user.name,
      assessmentName: assessment.name,
      invitationLink: `${PUBLIC_URL}/take/${plaintext}`,
      expiresAt: updated.expires_at,
      tenantName,
    };
    return { invitation: updated, email: mail };
  }).catch(async (err: unknown) => {
    await recordInviteLimitBlocked(err, tenantId, actorUserId);
    throw err;
  });
  await sendAfterCommit(email, invitation.id);
  return invitation;
}
