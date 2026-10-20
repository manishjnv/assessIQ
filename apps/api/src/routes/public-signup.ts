/**
 * apps/api/src/routes/public-signup.ts
 *
 * Z-71 / Z-81: PUBLIC self-serve organisation sign-up. Three routes, no session, no tenant
 * context (the tenant is created inside verify):
 *
 *   GET  /api/public/signup/config   -> { open, turnstileSiteKey, dpaVersion }
 *   POST /api/public/signup/request  -> Turnstile + limits + block list, then ONE of two mails
 *   POST /api/public/signup/verify   -> code -> organisation + first admin + session
 *
 * Why this is safe to leave public (docs/04-auth-flows.md "Self-serve sign-up"): no tenant data
 * is read or written until the tenant exists; every input is validated; Turnstile, per-IP and
 * per-address limits, a daily cap and one-claim-per-address (database primary key) bound abuse.
 *
 * All the logic is in modules/01-auth/src/signup.ts and modules/02-tenancy/src/self-serve.ts.
 * The routes answer 404 unless every precondition holds (PLAN_TIERS_ENFORCED, SIGNUP_ENABLED,
 * both Turnstile keys, Redis), checked on every request.
 *
 * NEVER import claude / @anthropic-ai from this file (Rule #1). No AI call is made here.
 */

import type { FastifyInstance } from 'fastify';
import { config, NotFoundError, RateLimitError } from '@assessiq/core';
import {
  TERMS_VERSION,
  extractClientIp,
  extractRateLimitClientIp,
  requestSignup,
  sessions,
  signupAvailable,
  signupPublicConfig,
  verifySignup,
  type AuthRequest,
} from '@assessiq/auth';
import { provisionSelfServePlan } from '@assessiq/billing';
import { seedTenantTaxonomy } from '@assessiq/question-bank';
import { publicAuthChain, publicCredentialAuthChain } from '../middleware/auth-chain.js';
import { parseBody, tryParse } from './_validate.js';
import { signupRequestBody, signupVerifyBody } from './_schemas.js';

const SIGNUP_INVALID = {
  error: { code: 'SIGNUP_INVALID', message: 'The code is not valid. Request a new one.' },
} as const;

async function requireOpen(): Promise<void> {
  if (!(await signupAvailable())) throw new NotFoundError('Not found');
}

export async function registerPublicSignupRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/public/signup/config',
    { config: { skipAuth: true }, preHandler: publicAuthChain },
    async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
      return reply.code(200).send(await signupPublicConfig());
    },
  );

  app.post(
    '/api/public/signup/request',
    { config: { skipAuth: true }, preHandler: publicCredentialAuthChain },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      await requireOpen();
      const body = parseBody(signupRequestBody, req.body, {
        code: {
          orgName: 'INVALID_ORG_NAME',
          adminName: 'INVALID_ADMIN_NAME',
          email: 'INVALID_EMAIL',
          turnstileToken: 'MISSING_TURNSTILE',
          dpaAccepted: 'DPA_NOT_ACCEPTED',
          dpaVersion: 'DPA_VERSION_MISMATCH',
        },
      });

      const result = await requestSignup({
        orgName: body.orgName,
        adminName: body.adminName,
        email: body.email,
        turnstileToken: body.turnstileToken,
        dpaVersion: body.dpaVersion,
        termsVersion: TERMS_VERSION,
        // Same IP source as the rate-limit middleware; null = cannot be trusted = refused.
        ip: extractRateLimitClientIp(req as unknown as AuthRequest),
        ua: (req.headers['user-agent'] as string | undefined) ?? 'unknown',
      });

      if (result.status === 'turnstile_failed') {
        return reply.code(403).send({
          error: { code: 'TURNSTILE_FAILED', message: 'Verification failed. Please reload the page and try again.' },
        });
      }
      if (result.status === 'rate_limited') {
        reply.header('Retry-After', Math.max(1, result.retryAfterSeconds));
        throw new RateLimitError(`rate limit exceeded for scope=${result.scope}`, {
          details: { retryAfterSeconds: result.retryAfterSeconds, scope: result.scope },
        });
      }
      // Neutral answer: identical for a new address, an existing account, a blocked address
      // and a full day. It never shows whether the address already has an account.
      return reply.code(200).send({ ok: true });
    },
  );

  app.post(
    '/api/public/signup/verify',
    { config: { skipAuth: true }, preHandler: publicCredentialAuthChain },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      await requireOpen();

      const ip = extractClientIp(req);
      const ua = (req.headers['user-agent'] as string | undefined) ?? 'unknown';
      const body = tryParse(signupVerifyBody, req.body);
      // A malformed body gets the same answer (and the same 800 ms floor) as a wrong code.
      const out =
        body === null
          ? await verifySignup({ email: 'invalid@invalid', code: 'x', ip, ua })
          : await verifySignup(
              { email: body.email, code: body.code, dpaVersion: body.dpaVersion, ip, ua },
              {
                // Free plan + monthly credit grant + sample sets commit WITH the tenant.
                provision: async (client, ctx) => ({ plan: (await provisionSelfServePlan(client, ctx.tenantId)).plan }),
                // Taxonomy seed opens its own transaction, so it runs right after commit.
                afterCommit: async (ctx) => seedTenantTaxonomy(ctx.tenantId),
              },
            );
      if (!out.ok) return reply.code(400).send(SIGNUP_INVALID);

      // Never reuse a pre-login cookie: drop any session this browser already holds, then set
      // the new one. Same cookie flags as the sign-in routes.
      const old = req.cookies?.[config.SESSION_COOKIE_NAME];
      if (typeof old === 'string' && old.length > 0) await sessions.destroy(old).catch(() => undefined);
      reply.setCookie(config.SESSION_COOKIE_NAME, out.sessionToken, {
        httpOnly: true,
        secure: config.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 8 * 3600,
      });
      return reply.code(200).send({ ok: true, redirect: out.redirectTo });
    },
  );
}
