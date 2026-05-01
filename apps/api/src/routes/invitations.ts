import type { FastifyInstance } from 'fastify';
import { config, ValidationError } from '@assessiq/core';
import { inviteUser, acceptInvitation } from '@assessiq/users';
import { requireRole } from '../middleware/dev-auth.js';

const adminOnly = requireRole(['admin']);

// Invitation tokens are 32 bytes encoded as base64url → exactly 43 chars.
// Bound the schema tightly so brute-force attempts don't get to do hash work.
const ACCEPT_TOKEN_MIN = 43;
const ACCEPT_TOKEN_MAX = 64;

export async function registerInvitationRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/admin/invitations — admin only; sends invitation email via 13-notifications stub
  app.post(
    '/api/admin/invitations',
    {
      preHandler: [adminOnly],
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
  // FIXME(rate-limit): codex:rescue MEDIUM finding (2026-05-01). Wire a strict per-IP
  // limiter once 01-auth Window 4's rate-limit middleware lands (3 attempts / 60s
  // per IP — token entropy is 256 bits but the brute-force surface is still real
  // operationally; a malicious link-shortener could amplify guessing rates).
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
            token: { type: 'string', minLength: ACCEPT_TOKEN_MIN, maxLength: ACCEPT_TOKEN_MAX },
          },
        },
      },
    },
    async (req, reply) => {
      const body = req.body as { token: string };
      // Defense-in-depth: even with the schema, reject obviously malformed shapes.
      if (typeof body.token !== 'string' || body.token.length < ACCEPT_TOKEN_MIN) {
        throw new ValidationError('Invalid invitation token shape.', {
          details: { code: 'INVALID_TOKEN' },
        });
      }

      const result = await acceptInvitation(body.token);

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
