/**
 * modules/13-notifications/src/email/totp-enrolled.ts
 *
 * sendTotpEnrolledEmail — tells a user that two-factor was set up on their account (FU-B21).
 * Call it AFTER the enrolment confirm succeeds. Never carries a secret or code.
 * The caller logs and swallows a failure: the enrolment stands.
 *
 * NEVER import claude / @anthropic-ai from this file (Rule #1).
 */

import { sendEmail } from './index.js';

export async function sendTotpEnrolledEmail(input: {
  to: string;
  recipientName: string;
  tenantId: string;
  tenantName?: string;
  at?: Date;
}): Promise<void> {
  await sendEmail({
    to: input.to,
    template: 'totp_enrolled',
    vars: {
      recipientName: input.recipientName,
      enrolledAt: (input.at ?? new Date()).toISOString(),
      ...(input.tenantName ? { tenantName: input.tenantName } : {}),
    },
    tenantId: input.tenantId,
  });
}
