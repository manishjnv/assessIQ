/**
 * modules/13-notifications/src/repository.ts
 *
 * RLS-scoped Postgres queries for email_log, webhook_endpoints,
 * webhook_deliveries, and in_app_notifications.
 *
 * IMPORTANT — RLS-only scoping (CLAUDE.md rule #4):
 * Every query runs inside a withTenant() transaction where SET LOCAL ROLE
 * assessiq_app + set_config('app.current_tenant', ...) have already fired.
 * Do NOT add WHERE tenant_id = $x filters — that masks RLS bugs.
 * Exception: INSERT statements pass tenant_id to satisfy the WITH CHECK policy.
 *
 * Transaction semantics:
 * This file issues individual queries against the supplied PoolClient.
 * It does NOT call BEGIN/COMMIT/ROLLBACK — callers handle that via withTenant().
 */

import type { PoolClient } from 'pg';
import type { EmailRecord, WebhookEndpoint, WebhookDelivery, InAppNotification } from './types.js';

// ---------------------------------------------------------------------------
// email_log
// ---------------------------------------------------------------------------

const EMAIL_LOG_COLUMNS = `
  id, tenant_id, to_address, subject, template_id,
  body_text, body_html, status, provider, provider_message_id,
  attempts, last_error, sent_at, created_at
`.trim();

interface EmailLogRow {
  id: string;
  tenant_id: string;
  to_address: string;
  subject: string;
  template_id: string;
  body_text: string | null;
  body_html: string | null;
  status: string;
  provider: string | null;
  provider_message_id: string | null;
  attempts: number;
  last_error: string | null;
  sent_at: Date | null;
  created_at: Date;
}

function rowToEmailRecord(row: EmailLogRow): EmailRecord {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    to_address: row.to_address,
    subject: row.subject,
    template_id: row.template_id,
    body_text: row.body_text,
    body_html: row.body_html,
    status: row.status as EmailRecord['status'],
    provider: row.provider,
    provider_message_id: row.provider_message_id,
    attempts: row.attempts,
    last_error: row.last_error,
    sent_at: row.sent_at,
    created_at: row.created_at,
  };
}

export interface InsertEmailLogInput {
  id: string;
  tenantId: string;
  toAddress: string;
  subject: string;
  templateId: string;
  bodyText: string | null;
  bodyHtml: string | null;
  status: EmailRecord['status'];
  provider?: string;
}

export async function insertEmailLog(
  client: PoolClient,
  input: InsertEmailLogInput,
): Promise<EmailRecord> {
  const result = await client.query<EmailLogRow>(
    `INSERT INTO email_log
       (id, tenant_id, to_address, subject, template_id,
        body_text, body_html, status, provider)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${EMAIL_LOG_COLUMNS}`,
    [
      input.id,
      input.tenantId,
      input.toAddress,
      input.subject,
      input.templateId,
      input.bodyText,
      input.bodyHtml,
      input.status,
      input.provider ?? null,
    ],
  );
  return rowToEmailRecord(result.rows[0]!);
}

export async function updateEmailLogStatus(
  client: PoolClient,
  id: string,
  updates: {
    status: EmailRecord['status'];
    providerMessageId?: string;
    lastError?: string;
    sentAt?: Date;
    attempts?: number;
  },
): Promise<void> {
  await client.query(
    `UPDATE email_log SET
       status = $2,
       provider_message_id = COALESCE($3, provider_message_id),
       last_error = COALESCE($4, last_error),
       sent_at = COALESCE($5, sent_at),
       attempts = COALESCE($6, attempts)
     WHERE id = $1`,
    [
      id,
      updates.status,
      updates.providerMessageId ?? null,
      updates.lastError ?? null,
      updates.sentAt ?? null,
      updates.attempts ?? null,
    ],
  );
}

export async function getEmailLogById(
  client: PoolClient,
  id: string,
): Promise<EmailRecord | null> {
  const result = await client.query<EmailLogRow>(
    `SELECT ${EMAIL_LOG_COLUMNS} FROM email_log WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row !== undefined ? rowToEmailRecord(row) : null;
}

// ---------------------------------------------------------------------------
// webhook_endpoints
// ---------------------------------------------------------------------------

const WEBHOOK_ENDPOINT_COLUMNS = `
  id, tenant_id, name, url, events, status, requires_fresh_mfa, created_at
`.trim();

interface WebhookEndpointRow {
  id: string;
  tenant_id: string;
  name: string;
  url: string;
  events: string[];
  status: string;
  requires_fresh_mfa: boolean;
  created_at: Date;
}

function rowToWebhookEndpoint(row: WebhookEndpointRow): WebhookEndpoint {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    url: row.url,
    events: row.events,
    status: row.status as WebhookEndpoint['status'],
    requires_fresh_mfa: row.requires_fresh_mfa,
    created_at: row.created_at,
  };
}

export async function insertWebhookEndpoint(
  client: PoolClient,
  input: {
    id: string;
    tenantId: string;
    name: string;
    url: string;
    secretEnc: Buffer;
    events: string[];
    requiresFreshMfa: boolean;
  },
): Promise<WebhookEndpoint> {
  const result = await client.query<WebhookEndpointRow>(
    `INSERT INTO webhook_endpoints
       (id, tenant_id, name, url, secret_enc, events, requires_fresh_mfa)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${WEBHOOK_ENDPOINT_COLUMNS}`,
    [
      input.id,
      input.tenantId,
      input.name,
      input.url,
      input.secretEnc,
      input.events,
      input.requiresFreshMfa,
    ],
  );
  return rowToWebhookEndpoint(result.rows[0]!);
}

export async function listWebhookEndpoints(
  client: PoolClient,
): Promise<WebhookEndpoint[]> {
  const result = await client.query<WebhookEndpointRow>(
    `SELECT ${WEBHOOK_ENDPOINT_COLUMNS} FROM webhook_endpoints
     ORDER BY created_at DESC`,
  );
  return result.rows.map(rowToWebhookEndpoint);
}

export async function getWebhookEndpointById(
  client: PoolClient,
  id: string,
): Promise<WebhookEndpoint | null> {
  const result = await client.query<WebhookEndpointRow>(
    `SELECT ${WEBHOOK_ENDPOINT_COLUMNS} FROM webhook_endpoints WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row !== undefined ? rowToWebhookEndpoint(row) : null;
}

/** Returns the encrypted secret for signing — never returned to API callers. */
export async function getWebhookEndpointSecret(
  client: PoolClient,
  id: string,
): Promise<Buffer | null> {
  const result = await client.query<{ secret_enc: Buffer }>(
    `SELECT secret_enc FROM webhook_endpoints WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row !== undefined ? row.secret_enc : null;
}

export async function deleteWebhookEndpoint(
  client: PoolClient,
  id: string,
): Promise<void> {
  await client.query(`DELETE FROM webhook_endpoints WHERE id = $1`, [id]);
}

/** Find endpoints subscribed to a specific event (exact or wildcard 'audit.*' etc.) */
export async function findEndpointsForEvent(
  client: PoolClient,
  event: string,
): Promise<WebhookEndpoint[]> {
  // Matches if events array contains the exact event OR a wildcard prefix like 'audit.*'
  const prefix = event.split('.')[0] + '.*';
  const result = await client.query<WebhookEndpointRow>(
    `SELECT ${WEBHOOK_ENDPOINT_COLUMNS} FROM webhook_endpoints
     WHERE status = 'active'
       AND (events @> ARRAY[$1]::text[] OR events @> ARRAY[$2]::text[])`,
    [event, prefix],
  );
  return result.rows.map(rowToWebhookEndpoint);
}

// ---------------------------------------------------------------------------
// webhook_deliveries
// ---------------------------------------------------------------------------

const WEBHOOK_DELIVERY_COLUMNS = `
  id, endpoint_id, event, payload, status,
  http_status, attempts, retry_at, delivered_at, last_error, created_at
`.trim();

interface WebhookDeliveryRow {
  id: string;
  endpoint_id: string;
  event: string;
  payload: unknown;
  status: string;
  http_status: number | null;
  attempts: number;
  retry_at: Date | null;
  delivered_at: Date | null;
  last_error: string | null;
  created_at: Date;
}

function rowToWebhookDelivery(row: WebhookDeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    endpoint_id: row.endpoint_id,
    event: row.event,
    payload: row.payload,
    status: row.status as WebhookDelivery['status'],
    http_status: row.http_status,
    attempts: row.attempts,
    retry_at: row.retry_at,
    delivered_at: row.delivered_at,
    last_error: row.last_error,
    created_at: row.created_at,
  };
}

export async function insertWebhookDelivery(
  client: PoolClient,
  input: {
    id: string;
    endpointId: string;
    event: string;
    payload: unknown;
  },
): Promise<WebhookDelivery> {
  const result = await client.query<WebhookDeliveryRow>(
    `INSERT INTO webhook_deliveries (id, endpoint_id, event, payload)
     VALUES ($1, $2, $3, $4)
     RETURNING ${WEBHOOK_DELIVERY_COLUMNS}`,
    [input.id, input.endpointId, input.event, JSON.stringify(input.payload)],
  );
  return rowToWebhookDelivery(result.rows[0]!);
}

export async function getWebhookDeliveryById(
  client: PoolClient,
  id: string,
): Promise<WebhookDelivery | null> {
  const result = await client.query<WebhookDeliveryRow>(
    `SELECT ${WEBHOOK_DELIVERY_COLUMNS} FROM webhook_deliveries WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row !== undefined ? rowToWebhookDelivery(row) : null;
}

export async function updateWebhookDeliveryStatus(
  client: PoolClient,
  id: string,
  updates: {
    status: WebhookDelivery['status'];
    httpStatus?: number;
    lastError?: string;
    deliveredAt?: Date;
    attempts?: number;
    retryAt?: Date | null;
  },
): Promise<void> {
  await client.query(
    `UPDATE webhook_deliveries SET
       status      = $2,
       http_status = COALESCE($3, http_status),
       last_error  = COALESCE($4, last_error),
       delivered_at = COALESCE($5, delivered_at),
       attempts    = COALESCE($6, attempts),
       retry_at    = $7
     WHERE id = $1`,
    [
      id,
      updates.status,
      updates.httpStatus ?? null,
      updates.lastError ?? null,
      updates.deliveredAt ?? null,
      updates.attempts ?? null,
      updates.retryAt !== undefined ? updates.retryAt : null,
    ],
  );
}

export async function listWebhookDeliveries(
  client: PoolClient,
  filter: { endpointId?: string; status?: string },
): Promise<WebhookDelivery[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.endpointId !== undefined) {
    params.push(filter.endpointId);
    conditions.push(`endpoint_id = $${params.length}`);
  }
  if (filter.status !== undefined) {
    params.push(filter.status);
    conditions.push(`status = $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await client.query<WebhookDeliveryRow>(
    `SELECT ${WEBHOOK_DELIVERY_COLUMNS} FROM webhook_deliveries
     ${where}
     ORDER BY created_at DESC
     LIMIT 100`,
    params,
  );
  return result.rows.map(rowToWebhookDelivery);
}

// ---------------------------------------------------------------------------
// in_app_notifications
// ---------------------------------------------------------------------------

const IN_APP_COLUMNS = `
  id, tenant_id, audience, user_id, role, kind, message, link, read_at, created_at
`.trim();

interface InAppNotificationRow {
  id: string;
  tenant_id: string;
  audience: string;
  user_id: string | null;
  role: string | null;
  kind: string;
  message: string;
  link: string | null;
  read_at: Date | null;
  created_at: Date;
}

function rowToInAppNotification(row: InAppNotificationRow): InAppNotification {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    audience: row.audience as InAppNotification['audience'],
    user_id: row.user_id,
    role: row.role as InAppNotification['role'],
    kind: row.kind,
    message: row.message,
    link: row.link,
    read_at: row.read_at,
    created_at: row.created_at,
  };
}

export async function insertInAppNotification(
  client: PoolClient,
  input: {
    id: string;
    tenantId: string;
    audience: InAppNotification['audience'];
    userId: string | null;
    role: InAppNotification['role'];
    kind: string;
    message: string;
    link: string | null;
  },
): Promise<InAppNotification> {
  const result = await client.query<InAppNotificationRow>(
    `INSERT INTO in_app_notifications
       (id, tenant_id, audience, user_id, role, kind, message, link)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${IN_APP_COLUMNS}`,
    [
      input.id,
      input.tenantId,
      input.audience,
      input.userId,
      input.role,
      input.kind,
      input.message,
      input.link,
    ],
  );
  return rowToInAppNotification(result.rows[0]!);
}

export interface ListInAppNotificationsInput {
  tenantId: string;
  /** User ID requesting their notifications */
  userId: string;
  /** User's role for role-based audience matching */
  userRole: string;
  /** Cursor = id of the last-seen notification (exclusive lower bound by created_at) */
  since?: string;
  limit?: number;
}

export async function listInAppNotificationsForUser(
  client: PoolClient,
  input: ListInAppNotificationsInput,
): Promise<InAppNotification[]> {
  const limit = Math.min(input.limit ?? 50, 100);

  // Build cursor condition if provided
  const params: unknown[] = [input.userId, input.userRole, limit];
  let cursorCondition = '';
  if (input.since !== undefined && input.since.length > 0) {
    // since is a created_at ISO timestamp (the cursor value from the last response)
    params.push(input.since);
    cursorCondition = `AND created_at > $${params.length}::timestamptz`;
  }

  const result = await client.query<InAppNotificationRow>(
    `SELECT ${IN_APP_COLUMNS} FROM in_app_notifications
     WHERE (
       (audience = 'user'  AND user_id = $1)
       OR (audience = 'role' AND role = $2)
       OR (audience = 'all')
     )
     ${cursorCondition}
     ORDER BY created_at ASC
     LIMIT $3`,
    params,
  );
  return result.rows.map(rowToInAppNotification);
}

export async function markInAppNotificationRead(
  client: PoolClient,
  id: string,
  userId: string,
): Promise<void> {
  // Only the owning user (or role/all audience) can mark read.
  // RLS ensures tenant isolation; this WHERE ensures the user owns the notification.
  await client.query(
    `UPDATE in_app_notifications
     SET read_at = now()
     WHERE id = $1
       AND read_at IS NULL
       AND (user_id = $2 OR audience IN ('role', 'all'))`,
    [id, userId],
  );
}
