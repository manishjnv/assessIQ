import { randomBytes, createHash } from 'node:crypto';
import { logger, NotFoundError, ConflictError, ValidationError, uuidv7, getRequestContext, config } from '@assessiq/core';
import { withTenant } from '@assessiq/tenancy';
import { sendInvitationEmail } from '@assessiq/notifications';
import type { InviteUserInput, InviteUserResult, AcceptInvitationResult } from './types.js';
import { normalizeEmail } from './normalize.js';
import * as repo from './repository.js';

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

/** Generate a 43-char base64url token (32 bytes of entropy, addendum § 2). */
function generateInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Compute the sha256 hex hash of the plaintext token for DB storage. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ---------------------------------------------------------------------------
// inviteUser
// ---------------------------------------------------------------------------

/**
 * Issue an invitation for a new admin or reviewer user.
 *
 * Per addendum § 13:
 *   - role='candidate' → ValidationError code='CANDIDATE_INVITATION_PHASE_1' (HTTP 501 equivalent)
 *   - assessmentIds non-empty → ValidationError code='ASSESSMENT_INVITATION_PHASE_1'
 *
 * Per addendum § 2:
 *   - Plaintext token is NEVER returned to the caller.
 *   - Token flows only through the invitation email body.
 *   - Returns { user, invitation: { id, email, role, expires_at } } — no token field.
 *
 * Per addendum § 3 re-invite semantics:
 *   - Existing active user → return { user, invitation: null }, no email sent.
 *   - Existing pending user → replace invitation (delete old, insert fresh), resend email.
 *   - Existing disabled user → ConflictError code='USER_DISABLED'.
 *   - Existing soft-deleted user → ConflictError code='USER_DELETED'.
 *   - Not found → create user (status='pending') + insert invitation.
 */
export async function inviteUser(
  tenantId: string,
  input: InviteUserInput,
): Promise<InviteUserResult> {
  // Guard: candidate role is Phase 1 only (addendum § 13).
  if (input.role === 'candidate') {
    throw new ValidationError(
      'Inviting candidate users is not supported in Phase 0. Use createUser to create a pending candidate record, then use the Phase 1 assessment invitation flow.',
      { details: { code: 'CANDIDATE_INVITATION_PHASE_1', httpStatus: 501 } },
    );
  }

  // Guard: assessmentIds non-empty is Phase 1 only (addendum § 13).
  if (input.assessmentIds !== undefined && input.assessmentIds.length > 0) {
    throw new ValidationError(
      'Assessment-linked invitations are not supported in Phase 0 (ASSESSMENT_INVITATION_PHASE_1).',
      { details: { code: 'ASSESSMENT_INVITATION_PHASE_1', httpStatus: 501 } },
    );
  }

  const normalizedEmail = normalizeEmail(input.email);
  logger.info({ tenantId, email: normalizedEmail, role: input.role }, 'inviteUser');

  // Generate token OUTSIDE the transaction so we can pass it to email after commit.
  const plaintextToken = generateInvitationToken();
  const tokenHash = hashToken(plaintextToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  let sentEmail = false;

  const result = await withTenant(tenantId, async (client): Promise<InviteUserResult> => {
    const existing = await repo.findUserByEmailNormalized(client, normalizedEmail);

    if (existing !== null) {
      if (existing.deleted_at !== null) {
        // Soft-deleted — admin must restore first (addendum § 3).
        throw new ConflictError(
          'This user has been soft-deleted. Restore the user before re-inviting.',
          { details: { code: 'USER_DELETED', email: normalizedEmail } },
        );
      }

      if (existing.status === 'disabled') {
        // Disabled — admin must re-enable first (addendum § 3).
        throw new ConflictError(
          'This user is disabled. Re-enable the user before re-inviting.',
          { details: { code: 'USER_DISABLED', email: normalizedEmail } },
        );
      }

      if (existing.status === 'active') {
        // Already active — return user with no invitation (addendum § 3).
        return { user: existing, invitation: null };
      }

      // status === 'pending': replace the existing invitation (addendum § 3).
      // Delete all pending invitations for this email, then insert a fresh one.
      await repo.deleteInvitationsForEmail(client, normalizedEmail);

      const invId = uuidv7();
      const invitation = await repo.insertInvitation(client, {
        id: invId,
        tenantId,
        email: normalizedEmail,
        role: input.role,
        tokenHash,
        invitedBy: input.invited_by,
        expiresAt,
      });

      sentEmail = true;
      return {
        user: existing,
        invitation: {
          id: invitation.id,
          email: invitation.email,
          role: invitation.role,
          expires_at: invitation.expires_at,
        },
      };
    }

    // User does not exist — create pending user + invitation.
    const userId = uuidv7();
    const user = await repo.insertUser(client, {
      id: userId,
      tenantId,
      email: normalizedEmail,
      name: normalizedEmail, // placeholder name; admin sets real name post-accept in Phase 1
      role: input.role,
      status: 'pending',
      metadata: {},
    });

    const invId = uuidv7();
    const invitation = await repo.insertInvitation(client, {
      id: invId,
      tenantId,
      email: normalizedEmail,
      role: input.role,
      tokenHash,
      invitedBy: input.invited_by,
      expiresAt,
    });

    sentEmail = true;
    return {
      user,
      invitation: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expires_at: invitation.expires_at,
      },
    };
  });

  // Send invitation email AFTER the transaction commits (token is now valid).
  // Per addendum § 2: plaintext token flows ONLY through the email body.
  if (sentEmail) {
    const invitationLink = `${config.ASSESSIQ_BASE_URL}/admin/invite/accept?token=${plaintextToken}`;
    await sendInvitationEmail({
      to: normalizedEmail,
      role: input.role,
      invitationLink,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// acceptInvitation
// ---------------------------------------------------------------------------

/**
 * Accept an invitation by its plaintext token.
 *
 * Per addendum § 12:
 *   1. sha256(token) → lookup user_invitations.token_hash (system-role, pre-auth).
 *   2. Check expiry and accepted_at.
 *   3. Atomic mark-accepted.
 *   4. Flip user status pending → active.
 *   5. Mint session via the auth-sessions mock (FIXME(post-01-auth)).
 *
 * ip and ua are read from the request context; defaults to safe fallbacks
 * when invoked outside a request context (e.g. CLI / tests).
 */
export async function acceptInvitation(token: string): Promise<AcceptInvitationResult> {
  const tokenHash = hashToken(token);

  // Step 1: system-role pre-auth lookup (addendum § 12 + repository.ts security comment).
  const invitation = await repo.withSystemClient(async (sysClient) =>
    repo.findInvitationByTokenHashSystem(sysClient, tokenHash),
  );

  if (invitation === null) {
    throw new NotFoundError('Invitation not found or already used.', {
      details: { code: 'INVITATION_NOT_FOUND' },
    });
  }

  // Check expiry (accepted_at IS NULL ensures we're not looking at an already-accepted row).
  if (invitation.accepted_at === null && invitation.expires_at < new Date()) {
    throw new ConflictError('This invitation has expired. Please request a new invitation.', {
      details: { code: 'INVITATION_EXPIRED' },
    });
  }

  // codex:rescue MEDIUM (2026-05-01): mint session AFTER the user-state transaction
  // commits. If sessions.create() persisted Postgres+Redis state inside withTenant
  // and the surrounding COMMIT then failed, the session would survive an activation
  // that never landed. We split: tx writes the user-state changes; session minting
  // runs after. The atomic mark-accepted inside the tx still prevents double-accept.
  const activeUser = await withTenant(invitation.tenant_id, async (client) => {
    // Step 3: atomic mark-accepted.
    const { ok } = await repo.markInvitationAccepted(client, invitation.id);
    if (!ok) {
      throw new ConflictError('This invitation has already been used.', {
        details: { code: 'INVITATION_ALREADY_USED' },
      });
    }

    // Step 4: flip user status pending → active.
    const user = await repo.findUserByEmailNormalized(client, normalizeEmail(invitation.email));
    if (user === null) {
      throw new NotFoundError(
        `User for invitation email '${invitation.email}' not found. Data integrity error.`,
      );
    }

    return repo.updateUserRow(client, user.id, { status: 'active' });
  });

  // Step 5: mint session OUTSIDE the tenant transaction (post-commit).
  // FIXME(post-01-auth): swap mock import for real @assessiq/auth.sessions once
  // Window 4's index.ts is on origin/main. Today, modules/01-auth/src/index.ts
  // is still `export {}` on main; the mock satisfies the pinned § 12 contract.
  const { sessions } = await import('./__mocks__/auth-sessions.js');

  // Read ip/ua from request context; fall back to safe defaults for CLI/test invocations.
  const ctx = getRequestContext();
  const ip = ctx?.ip ?? '0.0.0.0';
  const ua = ctx?.ua ?? 'unknown';

  const sessionResult = await sessions.create({
    userId: activeUser.id,
    tenantId: activeUser.tenant_id,
    role: activeUser.role,
    totpVerified: false, // admin/reviewer must enroll TOTP on first login (addendum § 12)
    ip,
    ua,
  });

  logger.info(
    { userId: activeUser.id, tenantId: activeUser.tenant_id },
    'acceptInvitation: user activated, session minted',
  );

  return {
    user: activeUser,
    sessionToken: sessionResult.token,
    expiresAt: sessionResult.expiresAt,
  };
}
