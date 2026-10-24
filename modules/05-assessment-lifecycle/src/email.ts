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

import { sendAssessmentInvitationEmail, sendInvitationReminderEmail } from "@assessiq/notifications";

export interface SendAssessmentInvitationInput {
  to: string;
  candidateName: string;
  assessmentName: string;
  invitationLink: string;
  expiresAt: Date;
  tenantName: string;
  tenantId?: string;
  /** From the invitation row. Decides the camera line; absent = no line. */
  deliveryMode?: "real" | "mock";
  /** Z-144: the camera is per assessment, so the resolver needs the assessment. */
  assessmentId?: string;
  /** Already resolved by the caller. Bulk invites set it once per batch so no send opens a second pooled connection inside an open transaction. */
  cameraRequired?: boolean;
}

type CameraRequiredFor = (tenantId: string, deliveryMode: "mock" | "real", assessmentId: string) => Promise<boolean>;
let cameraRequiredFor: CameraRequiredFor | undefined;
/**
 * Wired once at boot (apps/api server.ts and worker.ts) with module 06's isCameraRequired.
 * Module 05 cannot import module 06. ponytail: module-level slot, not threaded through every service call.
 */
export function setCameraRequiredResolver(fn: CameraRequiredFor | undefined): void {
  cameraRequiredFor = fn;
}

/** Same rule as the take flow. Mock, no tenant, no resolver or a resolver error all give false (the email still goes out). */
export async function resolveCameraRequired(tenantId: string | undefined, deliveryMode: "real" | "mock" | undefined, assessmentId: string | undefined): Promise<boolean> {
  if (deliveryMode !== "real" || tenantId === undefined || assessmentId === undefined || cameraRequiredFor === undefined) return false;
  try {
    return await cameraRequiredFor(tenantId, deliveryMode, assessmentId);
  } catch {
    return false;
  }
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
    ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
    cameraRequired: input.cameraRequired ?? (await resolveCameraRequired(input.tenantId, input.deliveryMode, input.assessmentId)),
  });
}

/** Reminder ("closes soon") email — same shim rationale as above; throws on failure. */
export async function sendReminderEmail(
  input: Omit<Parameters<typeof sendInvitationReminderEmail>[0], "cameraRequired"> & { deliveryMode?: "real" | "mock"; assessmentId?: string },
): Promise<void> {
  const { deliveryMode, assessmentId, ...rest } = input;
  await sendInvitationReminderEmail({ ...rest, cameraRequired: await resolveCameraRequired(input.tenantId, deliveryMode, assessmentId) });
}
