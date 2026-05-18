import type { FastifyInstance } from 'fastify';
import { config, AuthnError, ValidationError } from '@assessiq/core';
import {
  startGoogleSso,
  handleGoogleCallback,
  COOKIE_CONTINUATION_NAME,
  continuationCookieOpts,
  resolveLoginIdentities,
  peekLoginContinuation,
  selectLoginIdentity,
} from '@assessiq/auth';
import { authChain, publicAuthChain } from '../../middleware/auth-chain.js';

// Google OIDC routes. Library handles RS256 JWKS verify, state+nonce CSRF,
// cross-tenant identity resolution, pre-MFA session mint. Route layer wires
// HTTP cookies + 302 redirects.
//
// P1 changes:
//   - /api/auth/google/start: ?tenant= removed; ?returnTo= still supported.
//   - /api/auth/google/cb: handles discriminated union output (kind:'session'
//     | kind:'select'). On 'select', sets continuation cookie + redirects to
//     /admin/select-identity (no session cookie yet).
//   - GET /api/auth/login/identities: read-only picker data (no consume).
//   - POST /api/auth/login/select: consumes continuation, mints session.
//
// Spec sources:
//   - docs/04-auth-flows.md Flow 1
//   - modules/01-auth/SKILL.md § Decisions captured §§ 1, 9
//   - docs/03-api-contract.md:20-21

const STATE_COOKIE = 'aiq_oauth_state';
const NONCE_COOKIE = 'aiq_oauth_nonce';
// returnTo must be a relative path under the admin or candidate surface.
// The library has a deeper safeReturnTo; we additionally pre-validate at the
// route boundary so a malformed param fails closed before hitting the lib.
const SAFE_RETURN_RE = /^\/(admin|take)\/[\w\-/.]{0,256}$/;

export async function registerGoogleSsoRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/auth/google/start?returnTo=/admin/...
  // P1: tenant param removed — identity resolution is cross-tenant.
  const googleStartChain = authChain({ requireSession: false });
  app.get(
    '/api/auth/google/start',
    {
      config: { skipAuth: true },
      preHandler: googleStartChain,
    },
    async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      const returnTo = q['returnTo'];
      const startInput: Parameters<typeof startGoogleSso>[0] = {};
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

      reply.header('Cache-Control', 'no-store');

      if (out.kind === 'session') {
        // Single identity (or super_admin) — mint session cookie + redirect.
        reply.setCookie(config.SESSION_COOKIE_NAME, out.sessionToken, {
          httpOnly: true,
          secure: config.NODE_ENV === 'production',
          sameSite: 'lax',
          path: '/',
          maxAge: 8 * 3600,
        });
        return reply.redirect(out.redirectTo, 302);
      }

      // kind === 'select' — ≥2 identities. Set continuation cookie (no session yet).
      // The continuation token is NEVER placed in the redirect URL.
      const contOpts = continuationCookieOpts('/');
      reply.setCookie(COOKIE_CONTINUATION_NAME, out.continuationToken, {
        httpOnly: true,
        secure: config.NODE_ENV === 'production',
        sameSite: contOpts.sameSite,
        path: contOpts.path,
        maxAge: contOpts.maxAge,
      });
      return reply.redirect(out.redirectTo, 302);
    },
  );

  // GET /api/auth/login/identities
  // Read-only: validates the continuation cookie but does NOT consume it.
  // Returns the picker list for the frontend. 401 generic on invalid/expired.
  app.get(
    '/api/auth/login/identities',
    {
      config: { skipAuth: true },
      preHandler: publicAuthChain,
    },
    async (req, reply) => {
      const token = req.cookies?.[COOKIE_CONTINUATION_NAME];
      if (typeof token !== 'string' || token.length === 0) {
        reply.header('Cache-Control', 'no-store');
        return reply.status(401).send({ error: 'unauthorized' });
      }

      const ip = (req.headers['cf-connecting-ip'] as string | undefined) ?? req.ip;
      const ua = (req.headers['user-agent'] as string | undefined) ?? 'unknown';

      try {
        // Peek (non-consuming) — validates ip/ua binding, returns payload.
        const payload = await peekLoginContinuation(token, ip, ua);

        // Re-resolve so picker always shows current status.
        const allIdentities = await resolveLoginIdentities(payload.idpEmail);
        const validIds = new Set(payload.candidates);
        const identities = allIdentities
          .filter((i) => validIds.has(i.userId))
          .map((i) => ({
            userId: i.userId,
            role: i.role,
            tenantSlug: i.tenantSlug,
            tenantName: i.tenantName,
          }));

        reply.header('Cache-Control', 'no-store');
        return reply.send({ identities });
      } catch {
        reply.header('Cache-Control', 'no-store');
        return reply.status(401).send({ error: 'unauthorized' });
      }
    },
  );

  // POST /api/auth/login/select
  // Consumes the continuation cookie, mints a session for the chosen identity.
  app.post(
    '/api/auth/login/select',
    {
      config: { skipAuth: true },
      preHandler: publicAuthChain,
    },
    async (req, reply) => {
      const token = req.cookies?.[COOKIE_CONTINUATION_NAME];
      if (typeof token !== 'string' || token.length === 0) {
        throw new AuthnError('authentication failed');
      }

      const body = req.body as Record<string, unknown> | undefined;
      const userId = body?.['userId'];
      if (typeof userId !== 'string' || userId.length === 0) {
        throw new ValidationError('userId required', {
          details: { code: 'MISSING_USER_ID' },
        });
      }

      const ip = (req.headers['cf-connecting-ip'] as string | undefined) ?? req.ip;
      const ua = (req.headers['user-agent'] as string | undefined) ?? 'unknown';

      const out = await selectLoginIdentity({
        continuationToken: token,
        identityUserId: userId,
        ip,
        ua,
      });

      // Clear the continuation cookie — it's been consumed.
      reply.clearCookie(COOKIE_CONTINUATION_NAME, { path: '/' });

      // Set the session cookie (same flags as the cb route).
      reply.setCookie(config.SESSION_COOKIE_NAME, out.sessionToken, {
        httpOnly: true,
        secure: config.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 8 * 3600,
      });

      reply.header('Cache-Control', 'no-store');
      return reply.send({ redirectTo: out.redirectTo });
    },
  );
}
