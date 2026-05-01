import type { FastifyInstance } from 'fastify';
import { config, AuthnError, ValidationError } from '@assessiq/core';
import { startGoogleSso, handleGoogleCallback } from '@assessiq/auth';
import { getTenantBySlug } from '@assessiq/tenancy';
import { publicAuthChain } from '../../middleware/auth-chain.js';

// Google OIDC routes. Library handles RS256 JWKS verify, state+nonce CSRF,
// JIT-link via oauth_identities, pre-MFA session mint. Route layer wires
// HTTP cookies + 302 redirects.
//
// Spec sources:
//   - docs/04-auth-flows.md Flow 1
//   - modules/01-auth/SKILL.md § Decisions captured §§ 1, 9
//   - docs/03-api-contract.md:20-21

const STATE_COOKIE = 'aiq_oauth_state';
const NONCE_COOKIE = 'aiq_oauth_nonce';
const TENANT_SLUG_RE = /^[a-z0-9-]{1,64}$/;
// returnTo must be a relative path under the admin or candidate surface.
// The library has a deeper safeReturnTo; we additionally pre-validate at the
// route boundary so a malformed param fails closed before hitting the lib.
const SAFE_RETURN_RE = /^\/(admin|take)\/[\w\-/.]{0,256}$/;

export async function registerGoogleSsoRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/auth/google/start?tenant=<slug>&returnTo=/admin/...
  app.get(
    '/api/auth/google/start',
    {
      config: { skipAuth: true },
      preHandler: publicAuthChain,
    },
    async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      const tenantSlug = q['tenant'];
      if (typeof tenantSlug !== 'string' || !TENANT_SLUG_RE.test(tenantSlug)) {
        throw new ValidationError('tenant query param required (slug, [a-z0-9-]{1,64})', {
          details: { code: 'INVALID_TENANT_PARAM' },
        });
      }
      const tenant = await getTenantBySlug(tenantSlug);
      if (tenant === null) {
        throw new AuthnError('unknown tenant');
      }

      const returnTo = q['returnTo'];
      const startInput: Parameters<typeof startGoogleSso>[0] = { tenantId: tenant.id };
      if (typeof returnTo === 'string' && SAFE_RETURN_RE.test(returnTo)) {
        startInput.returnTo = returnTo;
      }

      const out = await startGoogleSso(startInput);

      // Cookies — library provides {httpOnly, secure, sameSite, path, maxAge}.
      // Clamp `secure` to NODE_ENV=production so dev (HTTP localhost) works.
      const cookieSecure = config.NODE_ENV === 'production';
      reply.setCookie(out.stateCookie.name, out.stateCookie.value, {
        httpOnly: out.stateCookie.opts.httpOnly,
        secure: cookieSecure,
        sameSite: out.stateCookie.opts.sameSite,
        path: out.stateCookie.opts.path,
        maxAge: out.stateCookie.opts.maxAge,
      });
      reply.setCookie(out.nonceCookie.name, out.nonceCookie.value, {
        httpOnly: out.nonceCookie.opts.httpOnly,
        secure: cookieSecure,
        sameSite: out.nonceCookie.opts.sameSite,
        path: out.nonceCookie.opts.path,
        maxAge: out.nonceCookie.opts.maxAge,
      });

      // Don't let any cache surface (Cloudflare, ISP, browser) keep this URL —
      // it carries CSRF state that's single-use.
      reply.header('Cache-Control', 'no-store');
      return reply.redirect(out.redirectUrl, 302);
    },
  );

  // GET /api/auth/google/cb?code=&state=
  app.get(
    '/api/auth/google/cb',
    {
      config: { skipAuth: true },
      preHandler: publicAuthChain,
    },
    async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      const code = q['code'];
      const state = q['state'];
      if (typeof code !== 'string' || typeof state !== 'string') {
        throw new ValidationError('missing code or state', {
          details: { code: 'INVALID_OAUTH_PARAM' },
        });
      }

      const stateCookieValue = req.cookies?.[STATE_COOKIE];
      const nonceCookieValue = req.cookies?.[NONCE_COOKIE];

      const ip = (req.headers['cf-connecting-ip'] as string | undefined) ?? req.ip;
      const ua = (req.headers['user-agent'] as string | undefined) ?? 'unknown';

      const out = await handleGoogleCallback({
        code,
        state,
        stateCookieValue,
        nonceCookieValue,
        ip,
        ua,
      });

      // State + nonce cookies are single-use — clear them immediately so a
      // browser back-button retry can't replay. Library's CSRF check is the
      // primary defense; clearing is defense-in-depth.
      reply.clearCookie(STATE_COOKIE, { path: '/' });
      reply.clearCookie(NONCE_COOKIE, { path: '/' });

      // Mint the pre-MFA session cookie. Attributes per addendum §1.
      reply.setCookie(config.SESSION_COOKIE_NAME, out.sessionToken, {
        httpOnly: true,
        secure: config.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 8 * 3600,
      });

      reply.header('Cache-Control', 'no-store');
      return reply.redirect(out.redirectTo, 302);
    },
  );
}
