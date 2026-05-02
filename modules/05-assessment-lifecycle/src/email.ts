// AssessIQ — modules/05-assessment-lifecycle email shim.
//
// Routes invitation-email sends through the @assessiq/notifications module so
// the Phase 1 dev-emails.log stub and the future SMTP driver swap-in stay
// transparent to module 05. This file is intentionally thin — the actual
// rendering + template + delivery logic lives in 13-notifications.
//
// WHY a module-local shim rather than calling notifications directly from
// service.ts:
//   * Keeps the service layer's notification dependency injectable for
//     tests — vitest can `vi.mock('./email.js', ...)` without reaching into
//     a sibling workspace package.
//   * Centralises the "which notifications surface does the assessment-
//     invitation flow use" decision in one file. Phase 1.5 SMTP swap-in only
//     touches this file + 13-notifications/src/email-stub.ts.
//   * Mirrors the pattern 03-users uses for sendInvitationEmail.

import { sendAssessmentInvitationEmail } from "@assessiq/notifications";

export interface SendAssessmentInvitationInput {
  to: string;
  candidateName: string;
  assessmentName: string;
  invitationLink: string;
  expiresAt: Date;
  tenantName: string;
}

/**
 * Send an assessment-invitation email. Phase 1: writes a JSONL record to the
 * dev-emails log via the 13-notifications stub. Phase 1.5+: routes through
 * the per-tenant SMTP driver (decision #12).
 *
 * NEVER include the plaintext token in any field other than `invitationLink`
 * — the link's `?token=<plaintext>` query parameter is the only authorised
 * surface for the plaintext. Never log the token alongside the email
 * metadata.
 */
export async function sendInvitationEmail(
  input: SendAssessmentInvitationInput,
): Promise<void> {
  await sendAssessmentInvitationEmail({
    to: input.to,
    candidateName: input.candidateName,
    assessmentName: input.assessmentName,
    invitationLink: input.invitationLink,
    expiresAt: input.expiresAt,
    tenantName: input.tenantName,
  });
}
