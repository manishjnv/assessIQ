/**
 * modules/13-notifications/src/types.ts
 *
 * Zod schemas and TypeScript types for the notifications module.
 * Re-exports legacy stub input interfaces so consumers are unchanged.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Email template names (P3.D14 — 7 templates, both .html + .txt)
// ---------------------------------------------------------------------------

export const EmailTemplateNameSchema = z.enum([
  'invitation_admin',
  'invitation_candidate',
  'totp_enrolled',
  'attempt_submitted_candidate',
  'attempt_graded_candidate',
  'attempt_ready_for_review_admin',
  'weekly_digest_admin',
]);

export type EmailTemplateName = z.infer<typeof EmailTemplateNameSchema>;

// ---------------------------------------------------------------------------
// Per-template vars schemas (P3.D14 — Zod validation of vars)
// ---------------------------------------------------------------------------

export const InvitationAdminVarsSchema = z.object({
  recipientEmail: z.string().email(),
  role: z.string().min(1),
  invitationLink: z.string().url(),
  tenantName: z.string().optional(),
  expiresInDays: z.number().int().positive().default(7),
});

export const InvitationCandidateVarsSchema = z.object({
  candidateName: z.string().min(1),
  assessmentName: z.string().min(1),
  invitationLink: z.string().url(),
  expiresAt: z.string(), // ISO8601 string
  tenantName: z.string().min(1),
});

export const TotpEnrolledVarsSchema = z.object({
  recipientName: z.string().min(1),
  enrolledAt: z.string(), // ISO8601
  tenantName: z.string().optional(),
});

export const AttemptSubmittedCandidateVarsSchema = z.object({
  candidateName: z.string().min(1),
  assessmentName: z.string().min(1),
  submittedAt: z.string(), // ISO8601
  tenantName: z.string().min(1),
});

export const AttemptGradedCandidateVarsSchema = z.object({
  candidateName: z.string().min(1),
  assessmentName: z.string().min(1),
  tenantName: z.string().min(1),
  resultsLink: z.string().url().optional(),
});

export const AttemptReadyForReviewAdminVarsSchema = z.object({
  assessmentName: z.string().min(1),
  candidateName: z.string().min(1),
  attemptId: z.string().min(1),
  reviewLink: z.string().url(),
  tenantName: z.string().min(1),
});

export const WeeklyDigestAdminVarsSchema = z.object({
  tenantName: z.string().min(1),
  weekEnding: z.string(), // ISO8601 date
  totalAttempts: z.number().int().min(0),
  completedAttempts: z.number().int().min(0),
  pendingReview: z.number().int().min(0),
  gradedThisWeek: z.number().int().min(0),
  dashboardLink: z.string().url(),
});

export type InvitationAdminVars = z.infer<typeof InvitationAdminVarsSchema>;
export type InvitationCandidateVars = z.infer<typeof InvitationCandidateVarsSchema>;
export type TotpEnrolledVars = z.infer<typeof TotpEnrolledVarsSchema>;
export type AttemptSubmittedCandidateVars = z.infer<typeof AttemptSubmittedCandidateVarsSchema>;
export type AttemptGradedCandidateVars = z.infer<typeof AttemptGradedCandidateVarsSchema>;
export type AttemptReadyForReviewAdminVars = z.infer<typeof AttemptReadyForReviewAdminVarsSchema>;
export type WeeklyDigestAdminVars = z.infer<typeof WeeklyDigestAdminVarsSchema>;

export type TemplateVarsMap = {
  invitation_admin: InvitationAdminVars;
  invitation_candidate: InvitationCandidateVars;
  totp_enrolled: TotpEnrolledVars;
  attempt_submitted_candidate: AttemptSubmittedCandidateVars;
  attempt_graded_candidate: AttemptGradedCandidateVars;
  attempt_ready_for_review_admin: AttemptReadyForReviewAdminVars;
  weekly_digest_admin: WeeklyDigestAdminVars;
};

// ---------------------------------------------------------------------------
// email_log record
// ---------------------------------------------------------------------------

export const EmailRecordStatusSchema = z.enum([
  'queued', 'sending', 'sent', 'failed', 'bounced',
]);

export const EmailRecordSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  to_address: z.string().email(),
  subject: z.string(),
  template_id: z.string(),
  body_text: z.string().nullable(),
  body_html: z.string().nullable(),
  status: EmailRecordStatusSchema,
  provider: z.string().nullable(),
  provider_message_id: z.string().nullable(),
  attempts: z.number().int(),
  last_error: z.string().nullable(),
  sent_at: z.date().nullable(),
  created_at: z.date(),
});

export type EmailRecord = z.infer<typeof EmailRecordSchema>;

// ---------------------------------------------------------------------------
// SMTP config (P3.D9 — Resend as default via nodemailer generic SMTP)
// ---------------------------------------------------------------------------

export const SmtpConfigSchema = z.object({
  provider: z.enum(['resend', 'ses', 'sendgrid', 'smtp']).default('smtp'),
  /** Generic SMTP URL e.g. smtps://resend:re_xxx@smtp.resend.com:465 */
  smtp_url: z.string().optional(),
  from_address: z.string().optional(),
  from_name: z.string().optional(),
  reply_to: z.string().optional(),
  template_overrides: z.record(z.unknown()).optional(),
});

export type SmtpConfig = z.infer<typeof SmtpConfigSchema>;

// ---------------------------------------------------------------------------
// webhook_endpoints record
// ---------------------------------------------------------------------------

export const WebhookEndpointSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  name: z.string(),
  url: z.string().url(),
  events: z.array(z.string()),
  status: z.enum(['active', 'disabled']),
  requires_fresh_mfa: z.boolean(),
  created_at: z.date(),
  // secret_enc is BYTEA in DB — never returned to callers (except plaintext ONCE at create)
});

export type WebhookEndpoint = z.infer<typeof WebhookEndpointSchema>;

export const CreateWebhookEndpointInputSchema = z.object({
  tenantId: z.string().uuid(),
  name: z.string().min(1).max(100),
  url: z.string().url(),
  events: z.array(z.string().min(1)).min(1),
  requiresFreshMfa: z.boolean().default(false),
});

export type CreateWebhookEndpointInput = z.infer<typeof CreateWebhookEndpointInputSchema>;

// ---------------------------------------------------------------------------
// webhook_deliveries record
// ---------------------------------------------------------------------------

export const WebhookDeliveryStatusSchema = z.enum(['pending', 'delivered', 'failed']);

export const WebhookDeliverySchema = z.object({
  id: z.string().uuid(),
  endpoint_id: z.string().uuid(),
  event: z.string(),
  payload: z.unknown(),
  status: WebhookDeliveryStatusSchema,
  http_status: z.number().int().nullable(),
  attempts: z.number().int(),
  retry_at: z.date().nullable(),
  delivered_at: z.date().nullable(),
  last_error: z.string().nullable(),
  created_at: z.date(),
});

export type WebhookDelivery = z.infer<typeof WebhookDeliverySchema>;

// ---------------------------------------------------------------------------
// in_app_notifications record
// ---------------------------------------------------------------------------

export const InAppNotificationAudienceSchema = z.enum(['user', 'role', 'all']);
export const InAppNotificationRoleSchema = z.enum(['admin', 'reviewer']);

export const InAppNotificationSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  audience: InAppNotificationAudienceSchema,
  user_id: z.string().uuid().nullable(),
  role: InAppNotificationRoleSchema.nullable(),
  kind: z.string(),
  message: z.string(),
  link: z.string().nullable(),
  read_at: z.date().nullable(),
  created_at: z.date(),
});

export type InAppNotification = z.infer<typeof InAppNotificationSchema>;

export const NotifyInAppInputSchema = z.object({
  tenantId: z.string().uuid(),
  audience: InAppNotificationAudienceSchema,
  userId: z.string().uuid().optional(),
  role: InAppNotificationRoleSchema.optional(),
  kind: z.string().min(1),
  message: z.string().min(1),
  link: z.string().optional(),
});

export type NotifyInAppInput = z.infer<typeof NotifyInAppInputSchema>;

// ---------------------------------------------------------------------------
// sendEmail input
// ---------------------------------------------------------------------------

export interface SendEmailInput<T extends EmailTemplateName = EmailTemplateName> {
  to: string;
  template: T;
  vars: TemplateVarsMap[T];
  tenantId?: string;
}

// ---------------------------------------------------------------------------
// Re-export legacy stub interfaces so consumers keep working without changes.
// The actual interfaces are defined in email-stub.ts; we re-export them from
// types.ts so any consumer importing from this file gets the same shape.
// ---------------------------------------------------------------------------

export type { SendInvitationEmailInput, SendAssessmentInvitationEmailInput } from './email-stub.js';
