import type { FastifyInstance } from 'fastify';
import { getUser } from '@assessiq/users';
import { getTenantById } from '@assessiq/tenancy';
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
        const [user, tenant] = await Promise.all([
          getUser(sess.tenantId, sess.userId),
          getTenantById(sess.tenantId),
        ]);
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
          mfaStatus: sess.totpVerified ? 'verified' : 'pending',
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
