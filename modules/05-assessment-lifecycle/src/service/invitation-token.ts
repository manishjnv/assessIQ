import { withTenant, withSystemRole } from "@assessiq/tenancy";
import { hashInvitationToken } from "../tokens.js";
import type { Assessment, AssessmentInvitation, AssessmentStatus, InvitationStatus } from "../types.js";

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
  return withSystemRole("invitation token resolution before tenant context", async (client) => {

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
      a_passing_score_pct: number;
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
         a.passing_score_pct AS a_passing_score_pct,
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
        passing_score_pct: row.a_passing_score_pct,
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
  });
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

