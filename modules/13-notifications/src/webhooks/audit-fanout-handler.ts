/**
 * modules/13-notifications/src/webhooks/audit-fanout-handler.ts
 *
 * Registered as a post-commit listener on the 14-audit-log module (G3.A).
 * For every audit row, looks up webhook_endpoints subscribed to 'audit.<action>'
 * or the 'audit.*' wildcard and calls emitWebhook for each.
 *
 * P3.D16 coordination note:
 * If @assessiq/audit-log is not yet installed (G3.A is a parallel session),
 * this handler short-circuits to a no-op + INFO log. G3.A's merge will
 * register this handler via its post-commit hook.
 *
 * NEVER import claude / @anthropic-ai from this file (Rule #1).
 */

import { streamLogger } from '@assessiq/core';
import { emitWebhook } from './service.js';

const log = streamLogger('webhook');

export interface AuditRow {
  id: string;
  tenant_id: string;
  actor_user_id: string;
  action: string;
  entity_type?: string;
  entity_id?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
  user_agent?: string;
  at: Date | string;
}

/**
 * Fan out an audit event to all matching webhook endpoints.
 *
 * Called by G3.A's post-commit hook after audit() writes a row.
 * G3.A coordination: if @assessiq/audit-log is not present, this is a no-op.
 */
export async function handleAuditFanout(auditRow: AuditRow): Promise<void> {
  // G3.A coordination: verify the module exists before doing any work.
  // This prevents a hard crash during the window when G3.A hasn't merged yet.
  // We use a variable to hold the specifier so TypeScript does not attempt
  // compile-time module resolution for @assessiq/audit-log (not yet installed).
  const auditLogModule = '@assessiq/audit-log';
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const mod = await (Function('m', 'return import(m)')(auditLogModule) as Promise<unknown>).catch(() => null);
    if (mod === null) {
      log.info(
        { tenantId: auditRow.tenant_id, action: auditRow.action },
        'audit-fanout: @assessiq/audit-log not available — skipping fanout',
      );
      return;
    }
  } catch {
    // @assessiq/audit-log not installed — no-op.
    log.info(
      { tenantId: auditRow.tenant_id, action: auditRow.action },
      'audit-fanout: @assessiq/audit-log not available — skipping fanout',
    );
    return;
  }

  const event = `audit.${auditRow.action}`;
  const payload = {
    event,
    tenant_id: auditRow.tenant_id,
    audit_id: auditRow.id,
    actor_user_id: auditRow.actor_user_id,
    action: auditRow.action,
    entity_type: auditRow.entity_type ?? null,
    entity_id: auditRow.entity_id ?? null,
    at: typeof auditRow.at === 'string' ? auditRow.at : auditRow.at.toISOString(),
  };

  try {
    await emitWebhook({
      tenantId: auditRow.tenant_id,
      event,
      payload,
    });
  } catch (err: unknown) {
    // Never let fanout errors propagate to the audit write path.
    log.error(
      { err, tenantId: auditRow.tenant_id, action: auditRow.action },
      'audit-fanout: emitWebhook failed',
    );
  }
}
