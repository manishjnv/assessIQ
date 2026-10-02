import type { FastifyInstance } from 'fastify';
import { config, RateLimitError, ValidationError } from '@assessiq/core';
import { consumeRateLimit, extractClientIp, isRateLimited } from '@assessiq/auth';
import { inviteUser, acceptInvitation } from '@assessiq/users';
import { authChain } from '../middleware/auth-chain.js';

// Admin gate: full @assessiq/auth chain. Replaces the pre-W4 dev-auth shim.
const adminOnly = authChain({ roles: ['admin'] });

// Invitation tokens are 32 bytes encoded as base64url → exactly 43 chars.
// Bound the schema tightly so brute-force attempts don't get to do hash work.
const ACCEPT_TOKEN_MIN = 43;
const ACCEPT_TOKEN_MAX = 64;
// Failed redemptions per IP per minute before 429 (see accept route comment).
export const INVITE_FAIL_MAX = 30;

export async function registerInvitationRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/admin/invitations — admin only; sends invitation email via 13-notifications stub
  app.post(
    '/api/admin/invitations',
    {
      preHandler: adminOnly,
      schema: {
        body: {
          type: 'object',
          required: ['email', 'role'],
          additionalProperties: false,
          properties: {
            email: { type: 'string', minLength: 3, maxLength: 320 },
            role: { type: 'string', enum: ['admin', 'reviewer', 'candidate'] },
            assessmentIds: {
              type: 'array',
              items: { type: 'string', format: 'uuid' },
              maxItems: 100,
            },
          },
        },
      },
    },
    async (req, reply) => {
      const tenantId = req.session!.tenantId;
      const invitedBy = req.session!.userId;
      const body = req.body as {
        email: string;
        role: 'admin' | 'reviewer' | 'candidate';
        assessmentIds?: string[];
      };

      // Conditional spread to satisfy exactOptionalPropertyTypes.
      const input: import('@assessiq/users').InviteUserInput = {
        email: body.email,
        role: body.role,
        invited_by: invitedBy,
      };
      if (body.assessmentIds !== undefined) input.assessmentIds = body.assessmentIds;
      const result = await inviteUser(tenantId, input);

      // inviteUser returns { user, invitation } — no token field per SKILL.md § 2
      return reply.code(201).send(result);
    },
  );

  // POST /api/invitations/accept — pre-auth; accepts an invitation token and mints a session.
  //
  // Per-IP brake on FAILED redemptions only (D5a/b, replaces the old FIXME).
  // Tokens are 256-bit so guessing is infeasible; the brake bounds DB lookups and
  // log noise from a scanner. Successful accepts are never counted, so a campus
  // of 300 students behind one NAT IP is unaffected; an IP is blocked only after
  // INVITE_FAIL_MAX unknown/expired/used tokens inside a minute. 429 scope=ip.
  app.post(
    '/api/invitations/accept',
    {
      config: { skipAuth: true },
      schema: {
        body: {
          type: 'object',
          required: ['token'],
          additionalProperties: false,
          properties: {
            token: { type: 'string', minLength: ACCEPT_TOKEN_MIN, maxLength: ACCEPT_TOKEN_MAX, pattern: '^[A-Za-z0-9_-]+$' },
          },
        },
      },
    },
    async (req, reply) => {
      const body = req.body as { token?: string } | null;
      // Defense-in-depth: guard against null body (no Content-Type) AND
      // enforce base64url charset beyond what the Fastify schema already checks.
      if (!body || typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{43,64}$/.test(body.token)) {
        throw new ValidationError('Invalid invitation token shape.', {
          details: { code: 'INVALID_TOKEN' },
        });
      }

      const ip = extractClientIp(req);
      const failKey = `aiq:rl:inv-accept-fail:${ip}`;
      // Failure-only brake (codex 2026-10-02): a VALID accept is never blocked, so a
      // scanner behind a campus NAT cannot lock out students. Failures past the cap
      // get 429 instead of the specific error (no oracle). Lookups are a cheap indexed
      // hash query and tokens are 256-bit, so redeeming before checking is safe.
      let result;
      try {
        result = await acceptInvitation(body.token);
      } catch (err) {
        const over = await isRateLimited(failKey, INVITE_FAIL_MAX);
        await consumeRateLimit(failKey, INVITE_FAIL_MAX, 60);
        if (over) {
          reply.header('Retry-After', '60');
          throw new RateLimitError('rate limit exceeded for scope=ip', {
            details: { retryAfterSeconds: 60, scope: 'ip' },
          });
        }
        throw err;
      }

      // codex:rescue HIGH (2026-05-01): keep the bearer cookie-only.
      // Returning sessionToken in the JSON body would defeat the httpOnly boundary
      // (logs, response capture, browser dev-tools all see it). The cookie IS the
      // session; the body returns only what the SPA needs to render.
      reply.setCookie(config.SESSION_COOKIE_NAME, result.sessionToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.NODE_ENV === 'production',
        path: '/',
        maxAge: 8 * 3600,
      });

      return reply.code(200).send({
        user: result.user,
        expiresAt: result.expiresAt,
      });
    },
  );
}
