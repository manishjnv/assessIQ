/**
 * modules/13-notifications/src/email/contact.ts
 *
 * Sends a contact-form enquiry to the AssessIQ team inbox.
 * Called directly (no BullMQ queue) — contact emails are not tenant-scoped
 * and carry no email_log row; they go straight through SMTP.
 *
 * Recipient: connect@assessiq.in (hardcoded)
 * // TODO: move to config if the contact address changes again
 *
 * NEVER import claude / @anthropic-ai from this file (Rule #1).
 */

import { config, streamLogger } from '@assessiq/core';
import { resolveTransport } from './transport.js';

const log = streamLogger('webhook'); // email sends go to webhook.log per § 8 stream table

// ---------------------------------------------------------------------------
// HTML-escape helper — avoids a template-engine dep for a single static email
// ---------------------------------------------------------------------------

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ContactEnquiryInput {
  name: string;
  email: string;
  message: string;
}

export async function sendContactEnquiry(input: ContactEnquiryInput): Promise<void> {
  // Strip CR/LF from name BEFORE it appears in the Subject header to prevent
  // email-header injection (a raw \r\n in the subject would let an attacker
  // append extra headers — Bcc, From, etc.).
  const safeName = input.name.replace(/[\r\n]+/g, ' ').trim();
  const { email, message } = input;

  const subject = `New contact enquiry from ${safeName}`;
  const submittedAt = new Date().toISOString();

  // Plain-text body
  const text = [
    `Name:      ${safeName}`,
    `Email:     ${email}`,
    ``,
    `Message:`,
    message,
    ``,
    `Submitted: ${submittedAt}`,
  ].join('\n');

  // HTML body — name/email/message are HTML-escaped; timestamp is safe (ISO digits only)
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>Contact enquiry</title></head>
<body style="font-family:sans-serif;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px">
  <h2 style="margin-top:0">New contact enquiry</h2>
  <table style="border-collapse:collapse;width:100%">
    <tr>
      <th style="text-align:left;padding:8px 12px;background:#f4f4f4;border:1px solid #ddd;width:100px">Name</th>
      <td style="padding:8px 12px;border:1px solid #ddd">${escapeHtml(safeName)}</td>
    </tr>
    <tr>
      <th style="text-align:left;padding:8px 12px;background:#f4f4f4;border:1px solid #ddd">Email</th>
      <td style="padding:8px 12px;border:1px solid #ddd">${escapeHtml(email)}</td>
    </tr>
    <tr>
      <th style="text-align:left;padding:8px 12px;background:#f4f4f4;border:1px solid #ddd;vertical-align:top">Message</th>
      <td style="padding:8px 12px;border:1px solid #ddd;white-space:pre-wrap">${escapeHtml(message)}</td>
    </tr>
    <tr>
      <th style="text-align:left;padding:8px 12px;background:#f4f4f4;border:1px solid #ddd">Submitted</th>
      <td style="padding:8px 12px;border:1px solid #ddd">${submittedAt}</td>
    </tr>
  </table>
</body>
</html>`;

  const transport = resolveTransport();
  if (transport === null) {
    // SMTP not configured — log and drop gracefully (do NOT throw; the API
    // handler should not 502 just because SMTP isn't set up in dev).
    log.warn(
      { name: safeName, email, messageLength: message.length },
      'contact: SMTP not configured — enquiry dropped to log',
    );
    return;
  }

  // Timeout the send (codex:rescue MED) so a slow/hung SMTP relay cannot tie up
  // the request handler or hold connections open. The route maps the thrown
  // error to a generic 502.
  const SEND_TIMEOUT_MS = 10_000;
  await Promise.race([
    transport.sendMail({
      from: config.EMAIL_FROM,
      to: 'connect@assessiq.in', // TODO: move to config if the contact address changes again
      replyTo: email,            // team can reply directly to the submitter
      subject,
      text,
      html,
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('SMTP send timeout')), SEND_TIMEOUT_MS),
    ),
  ]);

  log.info({ name: safeName, email }, 'contact.enquiry.sent');
}
