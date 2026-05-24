/**
 * apps/api/src/routes/contact.ts
 *
 * Public, unauthenticated contact-form endpoint.
 * Rate-limited via authChain({ requireSession: false, credentialEndpoint: true })
 * — reuses the existing stricter per-IP limiter, no new middleware needed.
 *
 * Honeypot: `company_website` field — silently drops submissions where it is
 * non-empty (bot fill-in detection). The field is present in the JSON schema
 * so Fastify accepts it without a 400, but the handler never acts on it.
 *
 * Sends to connect@assessiq.in via Resend SMTP (nodemailer transport).
 * replyTo = submitter email so the team can reply directly.
 *
 * NEVER import claude / @anthropic-ai from this file (Rule #1).
 */

import type { FastifyInstance } from 'fastify';
import { ValidationError, streamLogger } from '@assessiq/core';
import { sendContactEnquiry } from '@assessiq/notifications';
import { authChain } from '../middleware/auth-chain.js';

const appLog = streamLogger('app');

// Global submission budget — defense-in-depth (codex:rescue MED, 2026-05-24).
// The per-IP credential limiter caps a SINGLE IP; this caps TOTAL contact sends
// per process per hour, so a distributed (many-IP) flood cannot exhaust the
// SHARED Resend SMTP quota — which also carries the platform's invites/OTPs.
// In-memory = per-instance; acceptable for the single assessiq-api container.
// Stronger bot protection (Cloudflare Turnstile on the form) is a future add.
const GLOBAL_MAX_PER_HOUR = 20;
let _budgetWindowStart = Date.now();
let _budgetCount = 0;
function globalBudgetExceeded(): boolean {
  const now = Date.now();
  if (now - _budgetWindowStart > 3_600_000) {
    _budgetWindowStart = now;
    _budgetCount = 0;
  }
  if (_budgetCount >= GLOBAL_MAX_PER_HOUR) return true;
  _budgetCount += 1;
  return false;
}

export async function registerContactRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/contact',
    {
      config: { skipAuth: true },
      // credentialEndpoint: true — applies the existing stricter per-IP rate
      // limiter (same bucket as /auth/login, /auth/totp/verify, etc.).
      // This is intentional: the contact form hits an external SMTP relay on
      // every submission; without the tighter cap a bot could use it as a
      // free spam relay against connect@assessiq.in.
      preHandler: authChain({ requireSession: false, credentialEndpoint: true }),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'email', 'message'],
          properties: {
            name:             { type: 'string', minLength: 1, maxLength: 100 },
            email:            { type: 'string', minLength: 3, maxLength: 320 },
            message:          { type: 'string', minLength: 1, maxLength: 5000 },
            // Honeypot — present in schema so Fastify accepts it without 400,
            // but the handler silently drops the request when it is non-empty.
            company_website:  { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    async (req, reply) => {
      const body = req.body as {
        name: string;
        email: string;
        message: string;
        company_website?: string;
      };

      // 1. HONEYPOT: legitimate users never fill this hidden field; bots do.
      //    Return 200 to avoid revealing the detection mechanism.
      if (typeof body.company_website === 'string' && body.company_website.length > 0) {
        appLog.debug({ honeypot: true }, 'contact.honeypot.triggered');
        return reply.code(200).send({ ok: true });
      }

      // 2. Defensive trim + empty check (schema minLength=1 already rejects
      //    blank strings at parse time, but we guard against whitespace-only).
      const name    = body.name.trim();
      const email   = body.email.trim();
      const message = body.message.trim();

      if (!name || !email || !message) {
        throw new ValidationError('Name, email, and message are required.', {
          details: { code: 'CONTACT_EMPTY' },
        });
      }

      // 3. Basic email shape check (the schema string type allows any string;
      //    this catches "hello" or "@" which pass minLength/maxLength).
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        throw new ValidationError('Please enter a valid email address.', {
          details: { code: 'CONTACT_BAD_EMAIL' },
        });
      }

      // 3b. Global submission budget (codex:rescue MED) — caps total sends across
      //     ALL IPs per hour, protecting the shared Resend quota from a distributed
      //     flood. Counted only for valid, non-bot submissions about to send.
      if (globalBudgetExceeded()) {
        appLog.warn({}, 'contact.global_budget.exceeded');
        return reply.code(429).send({
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many messages right now. Please email connect@assessiq.in directly.',
          },
        });
      }

      // 4. Send — errors from SMTP are caught and returned as 502 so the
      //    caller knows to fall back to the direct email address.
      try {
        await sendContactEnquiry({ name, email, message });
      } catch (err) {
        appLog.error({ err }, 'contact.send.failed');
        return reply.code(502).send({
          error: {
            code: 'SEND_FAILED',
            message: 'Could not send your message. Please email connect@assessiq.in directly.',
          },
        });
      }

      // 5. Success
      return reply.code(200).send({ ok: true });
    },
  );
}
