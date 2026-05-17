import type { FastifyInstance } from 'fastify';
import { config } from '@assessiq/core';
import { getUser } from '@assessiq/users';
import { getTenantById } from '@assessiq/tenancy';
import { totp } from '@assessiq/auth';
import { authChain } from '../../middleware/auth-chain.js';

// GET /api/auth/whoami — returns the current user + tenant + MFA status.
// Spec: docs/03-api-contract.md:27 — `{ user, tenant, mfaStatus }`.
//
// Allowed for any role with a session OR an API key. API-key-backed requests
// surface a synthetic `user.id = api-key:<id>` so dashboards can render a
// who-am-I panel for service tokens too without leaking internal structure.
//
// `requireTotpVerified: false` — whoami MUST accept pre-MFA sessions so the
// frontend can detect "you're authenticated but need to enroll/verify TOTP"
// and route to /admin/mfa. Without this flag, requireAuth defaults to
// requireTotpVerified=true for admin/reviewer (per require-auth.ts:31), the
// preHandler 401's, and the SPA bounces back to /login — making MFA
// enrollment unreachable on first login.

/**
 * Decide the `mfaStatus` the SPA sees.
 *
 * `mfaStatus` reflects "is the MFA gate satisfied", not "has the user done TOTP".
 * When MFA_REQUIRED=false the gate is opt-in for admin/reviewer, so report
 * 'verified' and let them in without an MFA round-trip.
 *
 * EXCEPTION — super_admin is always-MFA regardless of MFA_REQUIRED (mirrors the
 * require-auth.ts invariant). A pre-TOTP super_admin MUST report 'pending' so
 * the SPA's RequireSession routes it to /admin/mfa to enrol/verify. Without
 * this carve-out a pre-TOTP super_admin would be sent to the dashboard and then
 * 401 on every cross-tenant action. (RCA 2026-05-17 — first-login MFA lockout.)
 */
export function computeMfaStatus(
  role: string,
  totpVerified: boolean,
  mfaRequired: boolean,
): 'verified' | 'pending' {
  const alwaysMfa = role === 'super_admin';
  if (mfaRequired || alwaysMfa) {
    return totpVerified ? 'verified' : 'pending';
  }
  return 'verified';
}

export async function registerWhoamiRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/auth/whoami',
    {
      config: { skipAuth: true },
      preHandler: authChain({ requireTotpVerified: false }),
    },
    async (req) => {
      if (req.session !== undefined) {
        const sess = req.session;
        const [user, tenant, enrollStatus] = await Promise.all([
          getUser(sess.tenantId, sess.userId),
          getTenantById(sess.tenantId),
          totp.getEnrollmentStatus(sess.userId, sess.tenantId),
        ]);
        // See computeMfaStatus — MFA_REQUIRED=false reports 'verified' for
        // admin/reviewer (no MFA round-trip), but super_admin is always-MFA so
        // a pre-TOTP super_admin reports 'pending' → SPA routes it to /admin/mfa.
        const mfaStatus = computeMfaStatus(
          sess.role,
          sess.totpVerified,
          config.MFA_REQUIRED,
        );
        return {
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: sess.role,
          },
          tenant: tenant === null
            ? { id: sess.tenantId, slug: null }
            : { id: tenant.id, slug: tenant.slug },
          mfaStatus,
          totpEnrolled: enrollStatus.enrolled,
          // Expose session expiry so candidate-facing UI can show the
          // day-25 banner (CandidateSessionBanner reads this via useSession).
          expiresAt: sess.expiresAt,
        };
      }

      // API-key path — no human user; surface enough for the caller to verify
      // their token is alive and which tenant + scopes it carries.
      const ak = req.apiKey!;
      const tenant = await getTenantById(ak.tenantId);
      return {
        user: {
          id: `api-key:${ak.id}`,
          email: null,
          name: null,
          role: 'api-key',
        },
        tenant: tenant === null
          ? { id: ak.tenantId, slug: null }
          : { id: tenant.id, slug: tenant.slug },
        mfaStatus: 'n/a',
        scopes: ak.scopes,
      };
    },
  );
}
