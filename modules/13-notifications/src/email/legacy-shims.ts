/**
 * modules/13-notifications/src/email/legacy-shims.ts
 *
 * Preserves the Phase 0 stub interface EXACTLY so existing callers
 * (modules/03-users/src/invitations.ts, modules/05-assessment-lifecycle/src/email.ts)
 * keep working without source-level changes.
 *
 * These functions delegate to sendEmail() with the appropriate template.
 * The legacy stub's function signatures are preserved byte-for-byte.
 *
 * NEVER modify the function signatures here — doing so would break callers.
 * NEVER import claude / @anthropic-ai from this file (Rule #1).
 */

import { sendEmail } from './index.js';
import type { SendInvitationEmailInput, SendAssessmentInvitationEmailInput } from '../email-stub.js';

export type { SendInvitationEmailInput, SendAssessmentInvitationEmailInput };

/**
 * Legacy shim for sendInvitationEmail — routes to invitation_admin template.
 * Preserves the exact signature from email-stub.ts (Phase 0).
 */
export async function sendInvitationEmail(input: SendInvitationEmailInput): Promise<void> {
  await sendEmail({
    to: input.to,
    template: 'invitation_admin',
    vars: {
      recipientEmail: input.to,
      role: input.role,
      invitationLink: input.invitationLink,
      tenantName: input.tenantName,
      expiresInDays: 7,
    },
    // No tenantId at this call site — legacy callers don't pass it.
    // The email_log write is skipped; stub-fallback logs to dev-emails.log.
  });
}

/**
 * Legacy shim for sendAssessmentInvitationEmail — routes to invitation_candidate template.
 * Preserves the exact signature from email-stub.ts (Phase 0).
 */
export async function sendAssessmentInvitationEmail(
  input: SendAssessmentInvitationEmailInput,
): Promise<void> {
  await sendEmail({
    to: input.to,
    template: 'invitation_candidate',
    vars: {
      candidateName: input.candidateName,
      assessmentName: input.assessmentName,
      invitationLink: input.invitationLink,
      expiresAt: input.expiresAt.toISOString(),
      tenantName: input.tenantName,
    },
    // No tenantId at this call site — legacy callers don't pass it.
  });
}
