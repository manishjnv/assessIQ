import type { FastifyInstance } from 'fastify';
import { config } from '@assessiq/core';
import {
  mintCandidateSession,
  requestCandidateLoginLinkSystem,
  verifyCandidateLoginTokenSystem,
  CANDIDATE_SESSION_TTL_SEC,
  CANDIDATE_LOGIN_TOKEN_TTL_SEC,
  sessions,
} from '@assessiq/auth';
import { sendEmail } from '@assessiq/notifications';
import { authChain } from '../../middleware/auth-chain.js';

// Candidate passwordless magic-link login routes.
//
// POST /api/auth/candidate/request-link  body: { email, tenant_slug }
//   Returns 204 always (enumeration prevention).
//   Internally: rate-limit 5/h per (ip, email), resolve slug → tenant under
//   RLS, generate token, send email. Both fields are required; missing/empty
//   still returns 204 to prevent structural enumeration.
//
// POST /api/auth/candidate/verify-link  body: { token }
//   Verifies token, destroys any pre-existing session (session-fixation hygiene),
//   mints 30-day fixed-window candidate session, sets aiq_sess cookie, returns
//   200 { ok: true, redirect: '/candidate/certificates' }.
//   On failure: 200 { ok: false, error: 'invalid_link' }.
//
//   POST (not GET) is intentional — email-preview crawlers (Gmail, Outlook,
//   Slack, Teams) prefetch link URLs with GET to render previews / scan for
//   malware. A GET verify-link would burn the single-use token before the
//   candidate ever clicked. The email itself points at /candidate/login/verify
//   (a SPA route), which the SPA loads and uses JS to POST the token here.
//   Crawlers do not execute JS or POST, so the token survives prefetch.
//
// Spec: modules/01-auth/SKILL.md § Candidate login.
// Threat model: docs/04-auth-flows.md § Candidate login (magic-link).

const EXPIRES_MINUTES = Math.round(CANDIDATE_LOGIN_TOKEN_TTL_SEC / 60); // 15

export async function registerCandidateAuthRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/auth/candidate/request-link
  // Auth: none (public). Rate-limit: IP-level from publicAuthChain + per-(IP,email)
  // inside requestCandidateLoginLinkSystem.
  // Always returns 204 — never reveals whether the email matched or slug was valid.
  app.post(
    '/api/auth/candidate/request-link',
    {
      config: { skipAuth: true },
      preHandler: authChain({ requireSession: false }),
    },
    async (req, reply) => {
      const body = req.body as Record<string, unknown> | undefined;
      const email = typeof body?.['email'] === 'string' ? body['email'] : null;
      // FIX 1: tenant_slug is now required. Without it we can't perform an
      // RLS-scoped lookup. Missing/empty → 204 (no structural info leaked).
      const tenant_slug = typeof body?.['tenant_slug'] === 'string' ? body['tenant_slug'] : null;

      if (
        typeof email !== 'string' || email.trim().length === 0 ||
        typeof tenant_slug !== 'string' || tenant_slug.trim().length === 0
      ) {
        // Still 204 — don't leak any structural info.
        return reply.status(204).send();
      }

      const ip = (req.headers['cf-connecting-ip'] as string | undefined) ?? req.ip;
      const ua = (req.headers['user-agent'] as string | undefined) ?? 'unknown';

      // Call service layer. Returns null on:
      //   - rate limit exceeded (Fix 2)
      //   - tenant_slug not found (Fix 1)
      //   - user not found in tenant or wrong role
      // We do NOT branch on null here to prevent timing-based enumeration.
      // Even on no-match we fall through to the same 204 response path.
      const result = await requestCandidateLoginLinkSystem({ email, tenant_slug, ip, ua });

      if (result !== null) {
        // Send magic-link email. Fire-and-forget: a failed email send should NOT
        // surface as a 5xx — the row is already committed and the user can retry.
        // Email link target is the SPA route — NOT the API endpoint — so that
        // email-preview crawler GETs don't burn the single-use token. The SPA
        // page at /candidate/login/verify reads ?token=… and POSTs it to the
        // verify-link endpoint below.
        const publicBaseUrl = config.ASSESSIQ_BASE_URL;
        const linkUrl = `${publicBaseUrl}/candidate/login/verify?token=${encodeURIComponent(result.token)}`;

        // Intentionally not awaited with a catch — email failures are logged
        // inside sendEmail; the 204 is already the correct response either way.
        sendEmail({
          to: result.user.email,
          template: 'candidate_login_link',
          vars: {
            display_name: result.user.display_name,
            link_url: linkUrl,
            expires_minutes: EXPIRES_MINUTES,
          },
          tenantId: result.user.tenant_id,
        }).catch((err: unknown) => {
          req.log.error({ err, userId: result.user.id }, 'candidate.request-link: email send failed');
        });
      }

      return reply.status(204).send();
    },
  );

  // POST /api/auth/candidate/verify-link  body: { token }
  // Auth: none (public) — the token IS the credential.
  // Success: destroy prior session (Fix 4), mint 30-day session, set cookie, return JSON
  //   { ok: true, redirect: '/candidate/certificates' }.
  // Failure: return JSON { ok: false, error: 'invalid_link' } (HTTP 200 — the
  //   error is part of the protocol, not a transport-layer failure; the SPA
  //   handles redirect to /candidate/login?error=invalid_link).
  //
  // Rate limit note: publicAuthChain's IP rate limit applies. The 15-minute
  // expiry + single-use constraint are the primary token defences.
  app.post(
    '/api/auth/candidate/verify-link',
    {
      config: { skipAuth: true },
      preHandler: authChain({ requireSession: false }),
    },
    async (req, reply) => {
      const body = req.body as Record<string, unknown> | undefined;
      const token = typeof body?.['token'] === 'string' ? body['token'] : null;

      reply.header('Cache-Control', 'no-store');

      if (token === null || token.trim().length === 0) {
        return reply.status(200).send({ ok: false, error: 'invalid_link' });
      }

      const ip = (req.headers['cf-connecting-ip'] as string | undefined) ?? req.ip;
      const ua = (req.headers['user-agent'] as string | undefined) ?? 'unknown';

      // FIX 4 — Session-fixation hygiene.
      // Before verifying the token, destroy any pre-existing aiq_sess cookie.
      // This eliminates the orphaned-session hygiene gap: a stale or attacker-
      // planted session cookie is invalidated unconditionally before a new one
      // is minted. Fire-and-forget: a destroy failure must never block the mint
      // (e.g. Redis hiccup or already-expired session). The new session is still
      // valid even if the old one couldn't be found in Redis.
      const priorSessionToken = req.cookies?.[config.SESSION_COOKIE_NAME];
      if (typeof priorSessionToken === 'string' && priorSessionToken.length > 0) {
        sessions.destroy(priorSessionToken).catch((err: unknown) => {
          req.log.warn({ err }, 'candidate.verify-link: prior session destroy failed (non-fatal)');
        });
      }

      const verified = await verifyCandidateLoginTokenSystem(token);

      if (verified === null) {
        // Expired, consumed, or unknown token.
        return reply.status(200).send({ ok: false, error: 'invalid_link' });
      }

      // Mint a fixed 30-day candidate session (non-sliding).
      const sessionOut = await mintCandidateSession({
        userId: verified.user_id,
        tenantId: verified.tenant_id,
        ip,
        ua,
        ttlSeconds: CANDIDATE_SESSION_TTL_SEC,
      });

      reply.setCookie(config.SESSION_COOKIE_NAME, sessionOut.token, {
        httpOnly: true,
        secure: config.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: CANDIDATE_SESSION_TTL_SEC,
      });

      return reply.status(200).send({ ok: true, redirect: '/candidate/certificates' });
    },
  );
}
