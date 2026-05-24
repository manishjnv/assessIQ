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
import { ValidationError, streamLogger, config } from '@assessiq/core';
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

// Cloudflare Turnstile verification (bot protection). Fail-closed: a missing/invalid
// token is rejected. If TURNSTILE_SECRET is unset, verification is REJECTED in
// production (fail-closed) and skipped only in non-prod (local dev) with a WARN.
const TURNSTILE_SECRET = process.env['TURNSTILE_SECRET'] ?? '';
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

async function turnstilePassed(token: string): Promise<boolean> {
  if (TURNSTILE_SECRET.length === 0) {
    // Fail-CLOSED in production (codex:rescue MED): an unset secret must NOT silently
    // disable bot protection. Skip only in non-prod (local dev) for convenience.
    if (config.NODE_ENV === 'production') {
      appLog.error({}, 'contact.turnstile.MISCONFIGURED — TURNSTILE_SECRET unset in production; rejecting (fail-closed)');
      return false;
    }
    appLog.warn({}, 'contact.turnstile.unconfigured — skipping verification (dev only)');
    return true;
  }
  if (token.length === 0) return false;
  try {
    const form = new URLSearchParams({ secret: TURNSTILE_SECRET, response: token });
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    appLog.error({ err }, 'contact.turnstile.verify_error');
    return false; // fail-closed on network/parse error
  }
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
            // Cloudflare Turnstile token — verified server-side (fail-closed).
            cf_turnstile_response: { type: 'string', maxLength: 3000 },
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
        cf_turnstile_response?: string;
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

      // 3.5 Cloudflare Turnstile — verify the bot-check token server-side (fail-closed).
      //     Runs before the global budget so failed challenges don't consume send quota.
      const turnstileToken = typeof body.cf_turnstile_response === 'string' ? body.cf_turnstile_response : '';
      if (!(await turnstilePassed(turnstileToken))) {
        appLog.warn({}, 'contact.turnstile.failed');
        return reply.code(403).send({
          error: {
            code: 'TURNSTILE_FAILED',
            message: 'Verification failed. Please reload the page and try again.',
          },
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
