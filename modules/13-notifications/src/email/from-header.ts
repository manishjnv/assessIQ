/**
 * modules/13-notifications/src/email/from-header.ts
 *
 * From header for organisation sends. Kept out of transport.ts so tests that mock
 * the transport module keep working.
 *
 * NEVER import claude / @anthropic-ai from this file (Rule #1).
 */

import { config } from '@assessiq/core';

/**
 * From header for a send from an organisation: `"<Org> via AssessIQ" <EMAIL_FROM address>`.
 * Without an org name it returns EMAIL_FROM unchanged. The org name is cut to one line and
 * 60 characters; nodemailer quotes and encodes the object form, so commas and quotes stay safe.
 */
export function buildFromHeader(orgName?: unknown): string | { name: string; address: string } {
  const raw = config.EMAIL_FROM;
  const org = (typeof orgName === 'string' ? orgName : '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
  if (org.length === 0) return raw;
  const address = (/<([^<>]+)>\s*$/.exec(raw)?.[1] ?? raw).trim();
  return { name: `${org} via AssessIQ`, address };
}
