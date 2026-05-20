// AssessIQ — modules/01-auth/src/lifecycle-log.ts
//
// Phase A — structured streamLogger helper for lifecycle events.
//
// PURPOSE: supplementary operational JSONL log alongside the structured
// audit_log DB row. The audit_log is the system-of-record for compliance
// forensics; this JSONL output is grep-able by operators and ingested by
// log aggregators for real-time alerting. Both exist intentionally.
//
// NOT yet wired into any production path in Phase A — Phase B/C handlers
// import and call logLifecycleEvent after they record their audit rows.

import { streamLogger } from "@assessiq/core";
import type { ActionName } from "@assessiq/audit-log";

const log = streamLogger("lifecycle");

// ---------------------------------------------------------------------------
// LifecycleEvent shape
// ---------------------------------------------------------------------------

export interface LifecycleEvent {
  /** Catalog action name — must be a known ActionName. */
  action: ActionName;
  /** Who performed the transition. */
  actor: {
    userId: string;
    role: string;
    ip?: string;
    ua?: string;
  };
  /** Entity whose lifecycle was mutated. */
  target: {
    entityType: "tenant" | "user" | "invitation";
    entityId: string;
  };
  /** State snapshot before the transition (optional). */
  before?: Record<string, unknown>;
  /** State snapshot after the transition (optional). */
  after?: Record<string, unknown>;
  /** Sessions revoked atomically with this transition (optional). */
  sessionsRevoked?: {
    count: number;
    userIds?: string[];
  };
  /**
   * True when a super-admin exercised an override path (e.g. last-admin
   * bypass). Logged at WARN level so operators can filter on override events.
   */
  isOverride?: boolean;
}

// ---------------------------------------------------------------------------
// logLifecycleEvent
// ---------------------------------------------------------------------------

/**
 * Emit a structured JSONL lifecycle event at INFO level (or WARN when
 * `isOverride === true` so override events surface in default log alerts).
 *
 * Phase A: helper is ready for import; no production call site yet.
 * Phase B/C: called in tenant suspend/resume/archive and user disable/reenable
 * handlers immediately after the auditInTx commit.
 */
export function logLifecycleEvent(evt: LifecycleEvent): void {
  const payload = { category: "lifecycle", ...evt };
  if (evt.isOverride === true) {
    log.warn(payload, "lifecycle event (override)");
  } else {
    log.info(payload, "lifecycle event");
  }
}
