/**
 * Handler: GET /admin/grading/budget
 *
 * Phase 2 G2.A Session 1.b — service-layer handler (no Fastify req/reply).
 *
 * Decision references:
 *   D6 — tenant_grading_budgets table; default shape when no row exists:
 *        { monthly_budget_usd: 0, used_usd: 0, period_start: null, alert_threshold_pct: 80 }.
 *        No row = "unlimited / not yet configured" (not "locked out").
 *
 * claude-code-vps mode note:
 *   The budget is informational only in Phase 1. The admin's Max subscription
 *   is flat-rate — no per-call cost. The route layer may annotate its response
 *   description accordingly. This handler just returns the row (or the default
 *   shape) without enforcing any gate.
 *
 *   Phase 2 (anthropic-api mode): the runtimes/anthropic-api.ts runtime
 *   enforces the pre-call budget check (used_usd >= monthly_budget_usd → 429).
 *   That enforcement lives in the runtime, not here.
 */

import { withTenant } from "@assessiq/tenancy";
import { findTenantBudget } from "../repository.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HandleAdminBudgetOutput {
  monthly_budget_usd: number;
  used_usd: number;
  /** ISO date string or null when no budget row exists. */
  period_start: string | null;
  alert_threshold_pct: number;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleAdminBudget(input: {
  tenantId: string;
  userId?: string;
}): Promise<HandleAdminBudgetOutput> {
  const { tenantId } = input;

  const budget = await withTenant(tenantId, (client) =>
    findTenantBudget(client),
  );

  if (budget === null) {
    // D6 default shape: no row = "unlimited / not yet configured"
    return {
      monthly_budget_usd: 0,
      used_usd: 0,
      period_start: null,
      alert_threshold_pct: 80,
    };
  }

  return {
    monthly_budget_usd: budget.monthly_budget_usd,
    used_usd: budget.used_usd,
    period_start:
      budget.period_start instanceof Date
        ? budget.period_start.toISOString().slice(0, 10)
        : null,
    alert_threshold_pct: budget.alert_threshold_pct,
  };
}
