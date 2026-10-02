/**
 * modules/13-notifications/src/email/invitation-reminder.ts
 *
 * sendInvitationReminderEmail — "your assessment closes soon" reminder (2026-10-02).
 * Called by module 05 sweepInvitationReminders after it has claimed the invitation
 * row. Bulk lane (low priority, ~45 h retry) like every non-auth email. THROWS on
 * failure so the caller can release its claim and retry on the next sweep.
 *
 * NEVER import claude / @anthropic-ai from this file (Rule #1).
 */

import { sendEmail } from './index.js';

export async function sendInvitationReminderEmail(input: {
  to: string;
  candidateName: string;
  assessmentName: string;
  invitationLink: string;
  /** The effective deadline (sooner of link expiry / assessment close). */
  deadline: Date;
  tenantName: string;
  tenantId: string;
}): Promise<void> {
  await sendEmail({
    to: input.to,
    template: 'invitation_reminder',
    vars: {
      candidateName: input.candidateName,
      assessmentName: input.assessmentName,
      invitationLink: input.invitationLink,
      expiresAt: input.deadline.toUTCString(),
      tenantName: input.tenantName,
    },
    tenantId: input.tenantId,
  });
}
