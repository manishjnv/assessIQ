/**
 * modules/13-notifications/src/email/totp-reset-notice.ts
 *
 * sendTotpResetNoticeEmail — tells a user an admin reset their two-factor (RW-91).
 * Call it AFTER the reset transaction commits. Carries the actor ROLE only (no name)
 * and never a secret or code. Callers log and swallow a failure: the reset stands.
 *
 * NEVER import claude / @anthropic-ai from this file (Rule #1).
 */

import { sendEmail } from './index.js';

export async function sendTotpResetNoticeEmail(input: {
  to: string;
  recipientName: string;
  actorRole: 'admin' | 'super_admin';
  tenantId: string;
  at?: Date;
}): Promise<void> {
  await sendEmail({
    to: input.to,
    template: 'totp_reset_notice',
    vars: {
      recipientName: input.recipientName,
      resetAt: (input.at ?? new Date()).toUTCString(),
      resetBy: input.actorRole === 'super_admin' ? 'a platform administrator' : 'an administrator',
    },
    tenantId: input.tenantId,
  });
}
