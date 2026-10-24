// AssessIQ — Phase 2 runtime: Anthropic Messages API (metered, per-call token usage).
//
// Same three-stage grading as the CLI runtime (anchors, band, escalation, score,
// provenance): it reuses gradeWithRunner from claude-code-vps.ts and supplies a
// stage runner that calls the Messages API with a forced tool call. The runner
// returns stream-json-shaped events, so every parser and the scoring path are shared.
//
// Why it exists (owner 2026-10-23): the CLI runtime runs on one flat-rate login with
// a 5-hour window and cannot serve volume. This runtime gives a real unit cost: every
// call logs input, output and cache token counts (never any answer text).
//
// Rules that still hold:
//   - Reached only when AI_PIPELINE_MODE=anthropic-api (runtime-selector.ts). Config
//     requires ANTHROPIC_API_KEY in that mode and refuses it in claude-code-vps mode.
//   - Admin-click, single-flight callers only (handlers/admin-grade.ts). No cron, no queue.
//   - Plain fetch: no new dependency and no SDK import (the lint allow-list keeps the
//     only SDK slot reserved for this file).
//   - Skills are the same VPS files; their sha256 is recorded on every grading row.
//   - Not shipped to production: AI_PIPELINE_MODE stays claude-code-vps until the owner
//     decides. D6 per-tenant budget gate: grading-budget.ts (checked before a grading, counted after).

import { AppError, config, streamLogger } from "@assessiq/core";

import { AI_GRADING_ERROR_CODES } from "../types.js";
import type { GradingInput, GradingProposal } from "../types.js";
import { skillSha, readSkillBody } from "../skill-sha.js";
import type { StreamJsonEvent } from "../stream-json-parser.js";
import { gradeWithRunner, type RunSkillOpts } from "./claude-code-vps.js";
import { assertBudget, callCostUsd, recordUsage, type UsageMeter } from "../grading-budget.js";

const log = streamLogger("grading");

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const STAGE_TIMEOUT_MS = 120_000;
// Thinking tokens count inside max_tokens (the 5.5 models think by default). 1500 cut replies short
// (owner 2026-10-23); a reply that still hits the cap is an error, never a partial tool input.
const MAX_OUTPUT_TOKENS = 8000;
const MAX_RETRIES = 4;
const MAX_RETRY_WAIT_MS = 30_000;
let retryBaseMs = 1000;
/** Test hook: shorten the backoff so the retry tests do not wait. */
export function setRetryBaseMsForTests(ms: number): void {
  retryBaseMs = ms;
}

// Tool schemas mirror AnchorFindingSchema and BandFindingSchema in ../types.ts.
const TOOLS: Record<string, { description: string; input_schema: Record<string, unknown> }> = {
  submit_anchors: {
    description: "Submit one finding per rubric anchor.",
    input_schema: {
      type: "object",
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              anchor_id: { type: "string" },
              hit: { type: "boolean" },
              evidence_quote: { type: "string", description: "Exact phrase from the answer, max 25 words. Omit when there is no hit." },
              confidence: { type: "number", minimum: 0, maximum: 1 },
            },
            required: ["anchor_id", "hit"],
          },
        },
      },
      required: ["findings"],
    },
  },
  submit_band: {
    description: "Submit the reasoning band for the answer.",
    input_schema: {
      type: "object",
      properties: {
        reasoning_band: { type: "integer", minimum: 0, maximum: 4 },
        ai_justification: { type: "string" },
        error_class: { type: ["string", "null"] },
        needs_escalation: { type: "boolean" },
      },
      required: ["reasoning_band", "ai_justification"],
    },
  },
};

// ---------------------------------------------------------------------------
// Token usage totals (read by the eval harness; counts only)
// ---------------------------------------------------------------------------

export interface ApiUsageTotals {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  by_model: Record<
    string,
    { calls: number; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
  >;
}

/** US$ spent so far, from the token counts (cache write 1.25x and read 0.1x of the input price). */
export function apiUsageCostUsd(u: ApiUsageTotals): number {
  return Object.entries(u.by_model).reduce((sum, [model, m]) => sum + callCostUsd(model, m), 0);
}

let totals: ApiUsageTotals = emptyTotals();

function emptyTotals(): ApiUsageTotals {
  return { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, by_model: {} };
}

/** Token counts so far, without resetting (the eval budget check). */
export function peekApiUsage(): ApiUsageTotals {
  return totals;
}

/** Returns the token counts since the last call and resets them. */
export function takeApiUsage(): ApiUsageTotals {
  const out = totals;
  totals = emptyTotals();
  return out;
}

// ---------------------------------------------------------------------------
// Stage runner
// ---------------------------------------------------------------------------

function modelFor(skill: string, skillModel: string): string {
  // Per-stage override, then the skill frontmatter model. Example: AI_API_MODEL_GRADE_BAND=claude-sonnet-5-5.
  const env = process.env[`AI_API_MODEL_${skill.toUpperCase().replace(/-/g, "_")}`];
  return env && env.trim() ? env.trim() : skillModel;
}

// Keys: the config key, then an optional fallback (set by the eval script only). When a key fails on
// credit or auth, the runtime moves to the next key and stays on it for the rest of the process.
let activeKey = 0;

function apiKeys(): string[] {
  return [config.ANTHROPIC_API_KEY, process.env["ANTHROPIC_API_KEY_FALLBACK"]].filter(
    (k): k is string => typeof k === "string" && k.trim().length > 0,
  );
}

/**
 * Credit exhausted or a bad or revoked key: move to the fallback key. A rate limit (429) is NOT a key
 * problem: the other key would only hide it, and the call is retried with a wait instead.
 */
function isKeyProblem(status: number, message: string): boolean {
  return status === 401 || status === 402 || status === 403 || (status === 400 && /credit balance/i.test(message));
}

/** Rate limit, overload and server errors are worth another try after a wait. */
function isRetryable(status: number): boolean {
  return status === 429 || status === 529 || status >= 500;
}

function retryWaitMs(attempt: number, retryAfter: string | null): number {
  const fromHeader = retryAfter !== null ? Number(retryAfter) * 1000 : NaN;
  const wait = Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : retryBaseMs * 2 ** attempt;
  return Math.min(wait, MAX_RETRY_WAIT_MS);
}

/**
 * Models that reject a forced tool call with a 400 (Sonnet 5.5, Opus 5.x, Fable and Mythos).
 * For these the request uses tool_choice auto: the user message already says to answer only by
 * calling the tool, and the reply is validated by the same parsers as before.
 */
function rejectsForcedToolChoice(model: string): boolean {
  return /sonnet-5-5|opus-5|fable|mythos/.test(model);
}

/** Optional effort level for the 5.x models (env AI_API_EFFORT: low, medium, high, xhigh or max). */
function effortFor(model: string): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  const e = (process.env["AI_API_EFFORT"] ?? "").trim();
  if (!/(haiku|sonnet|opus|fable|mythos)-5/.test(model)) return undefined; // major version 5 only: 4.x models do not all accept effort
  return e === "low" || e === "medium" || e === "high" || e === "xhigh" || e === "max" ? e : undefined;
}

/** Test hook: start again on the first key. */
export function resetApiKeyFailover(): void {
  activeKey = 0;
}

async function runStage(opts: RunSkillOpts, meter?: UsageMeter): Promise<StreamJsonEvent[]> {
  if (opts.signal?.aborted) {
    throw new AppError("grading lease lost before the API call", AI_GRADING_ERROR_CODES.LEASE_LOST, 409);
  }
  const keys = apiKeys();
  if (keys.length === 0) {
    throw new AppError("ANTHROPIC_API_KEY is not set", AI_GRADING_ERROR_CODES.RUNTIME_FAILURE, 503);
  }
  const toolName = (opts.allowedTools[0] ?? "").replace(/^mcp__assessiq__/, "");
  const tool = TOOLS[toolName];
  if (!tool) {
    throw new AppError(`no API tool schema for ${toolName}`, AI_GRADING_ERROR_CODES.SCHEMA_VIOLATION, 503);
  }

  const sha = await skillSha(opts.skill);
  const system = await readSkillBody(opts.skill);
  const model = opts.model ?? modelFor(opts.skill, sha.model);
  const user =
    `Apply the ${opts.skill} instructions from the system prompt to these inputs. ` +
    `Answer only by calling the ${toolName} tool.\n\n` +
    JSON.stringify(opts.promptVars, null, 2) +
    (opts.focusNote ? "\n\n" + opts.focusNote : "");

  const timeout = AbortSignal.timeout(opts.timeoutMs ?? STAGE_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const startedAt = Date.now();

  const send = (key: string): Promise<Response> =>
    fetch(API_URL, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": API_VERSION },
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        // The skill text repeats on every call: cache it.
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools: [{ name: toolName, description: tool.description, input_schema: tool.input_schema }],
        tool_choice: rejectsForcedToolChoice(model) ? { type: "auto" } : { type: "tool", name: toolName },
        ...(effortFor(model) ? { output_config: { effort: effortFor(model) } } : {}),
        messages: [{ role: "user", content: user }],
      }),
    });

  let res: Response;
  let retries = 0;
  for (;;) {
    try {
      res = await send(keys[Math.min(activeKey, keys.length - 1)] as string);
    } catch (err) {
      if (opts.signal?.aborted) {
        throw new AppError("grading lease lost during the API call", AI_GRADING_ERROR_CODES.LEASE_LOST, 409);
      }
      throw new AppError(`API request failed: ${(err as Error).name}`, AI_GRADING_ERROR_CODES.RUNTIME_FAILURE, 503, {
        details: { skill: opts.skill, attemptId: opts.attemptId },
      });
    }
    if (res.ok) break;

    // Status and error type only in logs and errors: never request content. The message text is
    // read only to recognise "credit balance too low".
    let errType = "unknown";
    let errMessage = "";
    try {
      const errBody = (await res.json()) as { error?: { type?: string; message?: string } };
      errType = errBody.error?.type ?? errType;
      errMessage = errBody.error?.message ?? "";
    } catch {
      // body not JSON
    }
    if (activeKey < keys.length - 1 && isKeyProblem(res.status, errMessage)) {
      activeKey += 1;
      log.warn({ skill: opts.skill, status: res.status, errType, nowUsingKey: activeKey + 1 }, "anthropic_api.key_failover");
      continue;
    }
    if (isRetryable(res.status) && retries < MAX_RETRIES) {
      const waitMs = retryWaitMs(retries, res.headers.get("retry-after"));
      retries += 1;
      log.warn({ skill: opts.skill, status: res.status, errType, retry: retries, waitMs }, "anthropic_api.retry");
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      if (opts.signal?.aborted) {
        throw new AppError("grading lease lost while waiting to retry", AI_GRADING_ERROR_CODES.LEASE_LOST, 409);
      }
      continue;
    }
    throw new AppError(`API returned ${res.status} (${errType})`, AI_GRADING_ERROR_CODES.RUNTIME_FAILURE, 503, {
      details: { skill: opts.skill, attemptId: opts.attemptId, status: res.status, errType },
    });
  }

  const body = (await res.json()) as {
    content?: Array<{ type: string; name?: string; input?: unknown }>;
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  };

  const u = body.usage ?? {};
  totals.calls += 1;
  totals.input_tokens += u.input_tokens ?? 0;
  totals.output_tokens += u.output_tokens ?? 0;
  totals.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
  totals.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
  if (meter) {
    meter.usd += callCostUsd(model, u);
    meter.inputTokens += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    meter.outputTokens += u.output_tokens ?? 0;
  }
  const m = (totals.by_model[model] ??= {
    calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
  m.calls += 1;
  m.input_tokens += u.input_tokens ?? 0;
  m.output_tokens += u.output_tokens ?? 0;
  m.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
  m.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
  log.info(
    {
      skill: opts.skill,
      model,
      durationMs: Date.now() - startedAt,
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    },
    "anthropic_api.call",
  );

  // A reply cut at the token cap or refused holds no complete tool input: fail, never use a partial one.
  if (body.stop_reason === "max_tokens" || body.stop_reason === "refusal") {
    throw new AppError(`API reply stopped early (${body.stop_reason})`, AI_GRADING_ERROR_CODES.RUNTIME_FAILURE, 503, {
      details: { skill: opts.skill, attemptId: opts.attemptId, stopReason: body.stop_reason },
    });
  }

  const matching = (body.content ?? []).filter((c) => c.type === "tool_use" && c.name === toolName);
  if (matching.length === 0) {
    throw new AppError(`API reply has no ${toolName} tool call`, AI_GRADING_ERROR_CODES.SCHEMA_VIOLATION, 503, {
      details: { skill: opts.skill, attemptId: opts.attemptId, blocks: (body.content ?? []).map((c) => c.type) },
    });
  }
  if (matching.length > 1) {
    // Use the first block, always: the choice must not depend on how the parser treats a list.
    log.warn({ skill: opts.skill, toolName, toolUseBlocks: matching.length, used: 0 }, "anthropic_api.multiple_tool_use");
  }
  const toolUse = [matching[0] as (typeof matching)[number]];
  return [
    { type: "system", subtype: "init", claude_code_version: "anthropic-api" },
    { type: "assistant", message: { content: toolUse.map((c) => ({ type: "tool_use", name: toolName, input: c.input })) } },
  ];
}

export async function gradeSubjective(input: GradingInput): Promise<GradingProposal> {
  const tenantId = input.tenant_id;
  if (tenantId === undefined) return gradeWithRunner(input, (o) => runStage(o)); // eval harness: no tenant
  await assertBudget(tenantId);
  const meter: UsageMeter = { usd: 0, inputTokens: 0, outputTokens: 0 };
  try {
    const proposal = await gradeWithRunner(input, (o) => runStage(o, meter));
    // Z-163: carry the real cost on the proposal; the accept path stores it on the gradings row.
    return { ...proposal, usage: { usd: meter.usd, input_tokens: meter.inputTokens, output_tokens: meter.outputTokens } };
  } finally {
    // A failed grading still spent tokens: count them. A ledger failure must not hide the grading result.
    if (meter.inputTokens > 0 || meter.outputTokens > 0) {
      await recordUsage(tenantId, meter).catch((err: unknown) =>
        log.error({ tenantId, err: (err as Error).name }, "grading_budget.record_failed"),
      );
    }
  }
}
