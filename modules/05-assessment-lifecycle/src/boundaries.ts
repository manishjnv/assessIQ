// AssessIQ — modules/05-assessment-lifecycle boundary cron logic.
//
// Pure-function logic for the lifecycle boundary advancement:
//   * published + opens_at ≤ now → active
//   * active    + closes_at ≤ now → closed
//   * published + opens_at ≤ now AND closes_at ≤ now → closed (skip active;
//                  whole window already in the past)
//
// THIS FILE DOES NOT WIRE BULLMQ. The KICKOFF plan (`docs/plans/PHASE_1_KICKOFF.md`
// § Session 3) calls for a BullMQ repeating job that invokes this logic every
// 60s. The `apps/worker/` Node process that would host the BullMQ scheduler
// does not exist yet (apps/api is the only application; no worker app, no
// BullMQ in package.json). Creating that app is a meaningful scope that
// belongs to a follow-up session — the SESSION_STATE handoff for this commit
// will explicitly flag this and reference an admin-trigger entry-point as the
// interim path.
//
// What this file SHIPS today:
//   * `processBoundariesForTenant(tenantId, now)` — wraps the bulk update in
//     a withTenant transaction. Returns the count of rows transitioned.
//     Idempotent: calling twice with the same `now` is safe; the second call
//     returns { activated: 0, closed: 0 }.
//
// How the boundary cron wires this in (future):
//   * The BullMQ scheduler iterates active tenants (tenants.status='active')
//     and calls `processBoundariesForTenant(tenant.id, now)` per tenant.
//     Per-tenant invocation keeps RLS clean — the bulk UPDATE inside is
//     scoped to the GUC `app.current_tenant`. A "global" version that joined
//     across tenants would need to bypass RLS, and that's a footgun.
//
// Idempotency contract:
//   * The 3 SQL UPDATEs in `repo.bulkUpdateBoundaries` are safe to retry.
//     - "published WHERE opens_at ≤ now AND (closes_at NULL or > now)" —
//       a re-run finds zero matching rows because the first run flipped
//       them to active.
//     - "active WHERE closes_at ≤ now" — same idempotency.
//     - "published WHERE opens_at ≤ now AND closes_at ≤ now" — same.
//   * If two boundary cron instances race against the same tenant (e.g. a
//     k8s replica scale-up), the worst case is one of them sees zero rows
//     to update. No double-transition possible because the WHERE clause
//     filters by current status.
//
// Audit-log integration:
//   * Phase 1 deliberately skips audit-log entries for boundary transitions.
//     They are NOT user-initiated — they're time-driven, idempotent, and
//     happen on every published/active row at the boundary instant. Logging
//     them at audit-log granularity creates noise that would drown legitimate
//     admin actions. The 14-audit-log module's "scheduled state advance"
//     event type lands in Phase 1.5 if the noise/value tradeoff justifies it.

import { streamLogger } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import * as repo from "./repository.js";

const log = streamLogger("app");

export interface BoundaryRunResult {
  tenantId: string;
  activated: number;
  closed: number;
}

/**
 * Run the boundary advancement for a single tenant. Wraps the bulk update
 * in `withTenant` so RLS is engaged and the transaction is committed atomically.
 *
 * `now` is injected so tests can pin the clock. Production callers pass
 * `new Date()` at scheduler-fire time.
 */
export async function processBoundariesForTenant(
  tenantId: string,
  now: Date,
): Promise<BoundaryRunResult> {
  const counts = await withTenant(tenantId, (client) =>
    repo.bulkUpdateBoundaries(client, now),
  );

  if (counts.activated > 0 || counts.closed > 0) {
    // INFO-level — boundary work happened. Operators care about non-zero runs;
    // zero-runs are noise (the cron fires every 60s on every active tenant).
    log.info(
      { tenantId, activated: counts.activated, closed: counts.closed, now: now.toISOString() },
      "lifecycle.boundary.advanced",
    );
  }

  return {
    tenantId,
    activated: counts.activated,
    closed: counts.closed,
  };
}
