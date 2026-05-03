// AssessIQ — modules/14-audit-log/src/webhook-fanout.ts
//
// Phase 3 G3.A — post-commit SIEM fanout via @assessiq/notifications (P3.D16).
//
// Called AFTER every successful audit INSERT. Forwards the audit event to all
// matching webhook_endpoints via @assessiq/notifications.handleAuditFanout.
//
// FAILURE SEMANTICS:
//   Fanout failure does NOT propagate. The audit row is already committed.
//   A failed fanout is logged at warn level. The audit trail is intact.
//   This is intentionally different from audit() itself, which must propagate.
//
// G3.B COORDINATION:
//   If @assessiq/notifications is absent or handleAuditFanout throws, the
//   fanout short-circuits to a no-op + warn log. G3.B's merge wires the
//   handler; pre-G3.B it is a graceful no-op.
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any AI SDK.

import { streamLogger } from '@assessiq/core';
import type { AuditRow } from './types.js';

const log = streamLogger('webhook');

/**
 * Fan out a committed audit event to matching webhook endpoints.
 * Best-effort — never throws. Logs warn on failure.
 */
export async function fanoutAuditEvent(auditRow: AuditRow): Promise<void> {
  try {
    const { handleAuditFanout } = await import('@assessiq/notifications');
    await handleAuditFanout({
      id: auditRow.id,
      tenant_id: auditRow.tenant_id,
      actor_user_id: auditRow.actor_user_id ?? '',
      action: auditRow.action,
      entity_type: auditRow.entity_type,
      ...(auditRow.entity_id !== null ? { entity_id: auditRow.entity_id } : {}),
      // NOTE: before/after are deliberately NOT forwarded to webhooks.
      // They may contain redacted-but-still-sensitive payloads. SIEM
      // consumers receive action + entity references only; they must
      // query the admin API with fresh-MFA for full before/after.
      ...(auditRow.ip !== null ? { ip: auditRow.ip } : {}),
      ...(auditRow.user_agent !== null ? { user_agent: auditRow.user_agent } : {}),
      at: auditRow.at,
    });
  } catch (err) {
    // Best-effort — log warn but do NOT rethrow. The audit row is committed.
    log.warn(
      { err, tenantId: auditRow.tenant_id, action: auditRow.action },
      'audit-fanout: webhook fanout failed (audit row already committed)',
    );
  }
}
