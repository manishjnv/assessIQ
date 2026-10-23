/**
 * D6 per-tenant grading budget (Z-163). Used by the metered anthropic-api runtime only:
 * the Max-plan CLI is flat rate and never reads this.
 *
 *   assertBudget  - before the first model call of a grading: roll the month, refuse when spent.
 *   recordUsage   - after the grading (also after a failure): add the real cost and tokens.
 *
 * monthly_budget_usd = 0 or no row means unlimited (the ledger still counts). To lock a tenant out,
 * set a tiny budget such as 0.01. A grading can overrun the budget by at most its own cost
 * (a few cents): the check is before the first call, not before every stage.
 */

import { AppError } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";

import { addBudgetUsage, rollAndFindBudget } from "./repository.js";
import { AI_GRADING_ERROR_CODES } from "./types.js";

/** US$ per million tokens: [prefix, input, output]. Cache write bills 1.25x input, cache read 0.1x. */
const PRICES: Array<[string, number, number]> = [
  ["claude-haiku-5", 0.1, 0.5],
  ["claude-sonnet-5", 2, 10],
  ["claude-opus-5", 4, 20],
  ["claude-haiku-4", 1, 5],
  ["claude-sonnet-4", 3, 15],
];
// Unknown model id: bill at the dearest known rate, so the ledger never under-counts.
const FALLBACK: [number, number] = [4, 20];

export interface UsageMeter {
  usd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CallUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export function callCostUsd(model: string, u: CallUsage): number {
  const hit = PRICES.find(([p]) => model.startsWith(p));
  const [pin, pout] = hit ? [hit[1], hit[2]] : FALLBACK;
  const inTok = (u.input_tokens ?? 0) + 1.25 * (u.cache_creation_input_tokens ?? 0) + 0.1 * (u.cache_read_input_tokens ?? 0);
  return (inTok * pin + (u.output_tokens ?? 0) * pout) / 1_000_000;
}

export async function assertBudget(tenantId: string): Promise<void> {
  const b = await withTenant(tenantId, (client) => rollAndFindBudget(client));
  if (b !== null && b.monthly_budget_usd > 0 && b.used_usd >= b.monthly_budget_usd) {
    throw new AppError("The monthly AI grading budget for this company is spent", AI_GRADING_ERROR_CODES.BUDGET_EXHAUSTED, 429);
  }
}

export async function recordUsage(tenantId: string, m: UsageMeter): Promise<void> {
  await withTenant(tenantId, (client) => addBudgetUsage(client, m));
}
