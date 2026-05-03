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
export type { EmailSendJobData } from './email/index.js';

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
export { processWebhookDeliverJob } from './webhooks/deliver-job.js';
export type { WebhookDeliverJobData } from './webhooks/deliver-job.js';
export { handleAuditFanout } from './webhooks/audit-fanout-handler.js';
export type { AuditRow } from './webhooks/audit-fanout-handler.js';
export { WEBHOOK_RETRY_DELAYS_MS, delayFor, webhookBackoffStrategy } from './webhooks/retry-schedule.js';
export { signPayload, verifySignature } from './webhooks/signature.js';

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
