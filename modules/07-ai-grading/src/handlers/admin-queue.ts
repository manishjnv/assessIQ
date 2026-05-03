/**
 * Handler: GET /admin/grading/queue
 *
 * Phase 2 G2.A Session 1.b — service-layer handler (no Fastify req/reply).
 *
 * Decision references:
 *   D3 — Phase 1 has no grading_jobs table. Queue is derived from
 *        attempts.status IN ('submitted', 'pending_admin_grading').
 *        No job state machine; just attempt rows awaiting admin action.
 *
 * RLS: withTenant() scopes to current tenant. listGradingQueue query does
 * NOT add WHERE tenant_id — RLS on attempts enforces isolation.
 */

import { withTenant } from "@assessiq/tenancy";
import { listGradingQueue } from "../repository.js";
import type { QueueRow } from "../repository.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HandleAdminQueueInput {
  tenantId: string;
  filters?: {
    /** Filter by attempt status (e.g. 'submitted', 'pending_admin_grading'). */
    status?: string;
    /** Filter by assessment ID (not yet implemented in repo query — reserved). */
    assessmentId?: string;
    limit?: number;
  };
}

export interface HandleAdminQueueOutput {
  items: QueueRow[];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleAdminQueue(
  input: HandleAdminQueueInput,
): Promise<HandleAdminQueueOutput> {
  const { tenantId, filters } = input;

  const queueOpts: { limit?: number } = {};
  if (filters?.limit !== undefined) queueOpts.limit = filters.limit;

  const items = await withTenant(tenantId, (client) =>
    listGradingQueue(client, queueOpts),
  );

  // Post-filter by status if provided (listGradingQueue already filters to
  // gradeable statuses; this allows the caller to narrow further without
  // a separate query param in the SQL)
  const filtered =
    filters?.status !== undefined
      ? items.filter((r) => r.status === filters.status)
      : items;

  return { items: filtered };
}
