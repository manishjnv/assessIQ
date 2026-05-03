// AssessIQ — modules/14-audit-log/src/audit.ts
//
// Phase 3 G3.A — the audit() write helper.
//
// CONTRACT:
//   audit(input) → Promise<void>
//   - Validates action against ACTION_CATALOG
//   - Auto-fills ip + userAgent from RequestContext when not explicitly passed
//   - Redacts sensitive fields from before/after payloads
//   - INSERTs a row into audit_log (via withTenant for RLS)
//   - On DB failure: logs at error level AND rethrows — NEVER swallows silently
//   - After successful INSERT: triggers webhook fanout (best-effort; fanout
//     failure does NOT rethrow — the audit row is already committed)
//
// ANTI-PATTERN REFUSED:
//   Do NOT wrap the INSERT in a try/catch that swallows errors. A silent
//   failure to write audit evidence is worse than a 500 to the user.
//   Per CLAUDE.md load-bearing rule: audit-failure MUST propagate.
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any AI SDK.

import { getRequestContext, streamLogger } from '@assessiq/core';
import { withTenant } from '@assessiq/tenancy';
import { ACTION_CATALOG, type AuditInput, type AuditRow } from './types.js';
import { redactPayload } from './redact.js';
import { fanoutAuditEvent } from './webhook-fanout.js';

const log = streamLogger('app');

// Build a Set for O(1) validation.
const KNOWN_ACTIONS = new Set<string>(ACTION_CATALOG);

/**
 * Write a single audit event.
 *
 * Errors propagate. Never fire-and-forget.
 *
 * RequestContext auto-fill: if `ip` or `userAgent` are omitted, they are
 * read from the active AsyncLocalStorage context. When called outside a
 * request context (e.g. from a BullMQ job), pass them explicitly or accept
 * null — both are valid stored values.
 */
export async function audit(input: AuditInput): Promise<void> {
  // Validate action is a known catalog entry.
  if (!KNOWN_ACTIONS.has(input.action)) {
    const err = new Error(`audit: unknown action "${input.action}"`);
    log.error({ action: input.action }, 'audit: unknown action — this is a programmer error');
    throw err;
  }

  // Auto-fill ip + userAgent from RequestContext (if available + not overridden).
  const ctx = getRequestContext();
  const ip = input.ip ?? ctx?.ip ?? null;
  const userAgent = input.userAgent ?? ctx?.ua ?? null;

  // Redact sensitive fields from before/after payloads.
  const redactedBefore = input.before !== undefined
    ? (redactPayload(input.before) as Record<string, unknown>)
    : null;
  const redactedAfter = input.after !== undefined
    ? (redactPayload(input.after) as Record<string, unknown>)
    : null;

  // Write the row via RLS-scoped transaction.
  // withTenant sets app.current_tenant GUC so the INSERT policy passes.
  let insertedRow: AuditRow;
  try {
    insertedRow = await withTenant(input.tenantId, async (client) => {
      const result = await client.query<AuditRow>(
        `INSERT INTO audit_log
           (tenant_id, actor_user_id, actor_kind, action,
            entity_type, entity_id, before, after, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::inet, $10)
         RETURNING id::text, tenant_id::text, actor_user_id::text,
                   actor_kind, action, entity_type, entity_id::text,
                   before, after, ip::text, user_agent,
                   at::text`,
        [
          input.tenantId,
          input.actorUserId ?? null,
          input.actorKind,
          input.action,
          input.entityType,
          input.entityId ?? null,
          redactedBefore !== null ? JSON.stringify(redactedBefore) : null,
          redactedAfter !== null ? JSON.stringify(redactedAfter) : null,
          ip,
          userAgent,
        ],
      );
      return result.rows[0]!;
    });
  } catch (err) {
    // Log at error level (mirrors to error.log) then rethrow.
    // Do NOT swallow — a lost audit event is a compliance violation.
    log.error(
      { err, tenantId: input.tenantId, action: input.action },
      'audit: INSERT failed — propagating to caller',
    );
    throw err;
  }

  // Post-commit webhook fanout (P3.D16 SIEM forwarding).
  // This is best-effort: fanout failure does NOT rethrow because the audit
  // row is already committed. A failed fanout is logged at warn.
  // The audit trail is intact regardless of fanout status.
  await fanoutAuditEvent(insertedRow);
}
