/**
 * modules/13-notifications/src/index.ts
 *
 * Public barrel for @assessiq/notifications.
 *
 * CRITICAL: This barrel REPLACES the Phase 0 export of sendInvitationEmail +
 * sendAssessmentInvitationEmail from email-stub.ts with the same functions
 * from email/legacy-shims.ts (which delegates to the real sendEmail pipeline).
 *
 * Existing callers (03-users, 05-assessment-lifecycle) import from
 * '@assessiq/notifications' — they get the shim implementations transparently.
 *
 * email-stub.ts is preserved UNTOUCHED per spec. The legacy shims re-export
 * the same function signatures from a new implementation path.
 *
 * NEVER import claude / @anthropic-ai from this file (Rule #1).
 */

// ---------------------------------------------------------------------------
// Primary email API (Phase 3)
// ---------------------------------------------------------------------------
export { sendEmail } from './email/index.js';
export { processEmailSendJob } from './email/index.js';
export type { EmailSendJobData, EmailSendAttempt } from './email/index.js';
// Email delivery classes (auth vs bulk) + the worker's single custom backoff strategy.
export { notificationsBackoffStrategy } from './email/delivery-policy.js';

// SP4: candidate result email, sent after the release tx commits (best-effort,
// never throws). Called by 07 (manual release / release-all) and the worker sweep.
export { sendResultReleasedEmail } from './email/result-released.js';

// Phase II SP11: platform-owner alert when evaluations wait > 24 h (worker job
// evaluation.queue_alert; best-effort per recipient, never throws).
export { sendInvitationReminderEmail } from './email/invitation-reminder.js';
export { sendEvaluationQueueAlertEmail } from './email/evaluation-queue-alert.js';

// ---------------------------------------------------------------------------
// Contact-form enquiry (public, unauthenticated — no tenant context)
// ---------------------------------------------------------------------------
export { sendContactEnquiry } from './email/contact.js';
export type { ContactEnquiryInput } from './email/contact.js';

// ---------------------------------------------------------------------------
// Legacy shims — SAME signatures as Phase 0 stub; existing callers unchanged
// ---------------------------------------------------------------------------
export {
  sendInvitationEmail,
  sendAssessmentInvitationEmail,
} from './email/legacy-shims.js';
export type {
  SendInvitationEmailInput,
  SendAssessmentInvitationEmailInput,
} from './email/legacy-shims.js';

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------
export { emitWebhook, listWebhookEndpoints, createWebhookEndpoint, deleteWebhookEndpoint, sendTestEvent, listDeliveries, replayDelivery } from './webhooks/service.js';
export { emitAttemptEventAfterCommit, BUSINESS_WEBHOOK_EVENTS } from './webhooks/business-events.js';
export type { BusinessWebhookEvent, BusinessEventPayload } from './webhooks/business-events.js';
export { processWebhookDeliverJob } from './webhooks/deliver-job.js';
export type { WebhookDeliverJobData } from './webhooks/deliver-job.js';
export { handleAuditFanout } from './webhooks/audit-fanout-handler.js';
export type { AuditRow } from './webhooks/audit-fanout-handler.js';
export { WEBHOOK_RETRY_DELAYS_MS, delayFor, webhookBackoffStrategy } from './webhooks/retry-schedule.js';
export { signPayload, verifySignature, signPayloadV2, verifySignatureV2 } from './webhooks/signature.js';

// ---------------------------------------------------------------------------
// In-app notifications
// ---------------------------------------------------------------------------
export { notifyInApp, listInAppNotifications, markRead } from './in-app/service.js';

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export { registerNotificationsRoutes } from './routes.js';
export type { RegisterNotificationsRoutesOptions } from './routes.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type {
  EmailTemplateName,
  EmailRecord,
  SmtpConfig,
  WebhookEndpoint,
  WebhookDelivery,
  InAppNotification,
  NotifyInAppInput,
  SendEmailInput,
  CreateWebhookEndpointInput,
  TemplateVarsMap,
} from './types.js';
