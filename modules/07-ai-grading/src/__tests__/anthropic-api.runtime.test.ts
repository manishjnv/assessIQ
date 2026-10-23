/**
 * Unit tests for ../runtimes/anthropic-api.ts (Messages API runtime, Z-163).
 *
 * Mocks: global fetch, ../skill-sha.js (canned sha, model and skill body), and
 * @assessiq/core config (adds ANTHROPIC_API_KEY). No network, no real key.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("@assessiq/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@assessiq/core")>();
  return { ...actual, config: { ...actual.config, ANTHROPIC_API_KEY: "test-key-not-real" } };
});

vi.mock("../skill-sha.js", () => ({
  skillSha: vi.fn(() =>
    Promise.resolve({ short: "abc12345", label: "v2", model: "claude-haiku-4-5", sha256: "abc12345" + "0".repeat(56) }),
  ),
  readSkillBody: vi.fn(() => Promise.resolve("SKILL BODY: grade carefully.")),
}));

import { gradeSubjective, takeApiUsage } from "../runtimes/anthropic-api.js";
import { AI_GRADING_ERROR_CODES } from "../types.js";
import type { GradingInput } from "../types.js";
import { AppError } from "@assessiq/core";

const INPUT: GradingInput = {
  attempt_id: "00000000-0000-4000-8000-000000000001",
  question_id: "00000000-0000-4000-8000-000000000002",
  question_content: { text: "What is lateral movement?" },
  rubric: {
    anchors: [
      { id: "a1", weight: 12 },
      { id: "a2", weight: 12 },
    ],
    anchor_weight_total: 24,
    reasoning_weight_total: 36,
  },
  answer: { text: "Moving from one host to another after the first compromise." },
};

function apiReply(toolName: string, input: unknown, usage = { input_tokens: 1000, output_tokens: 100 }): Response {
  return new Response(JSON.stringify({ content: [{ type: "tool_use", name: toolName, input }], usage }), { status: 200 });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  takeApiUsage();
});
afterEach(() => vi.unstubAllGlobals());

describe("anthropic-api runtime", () => {
  it("grades in two stages, sends a forced tool call with a cached system prompt, and counts tokens", async () => {
    fetchMock
      .mockResolvedValueOnce(apiReply("submit_anchors", { findings: [{ anchor_id: "a1", hit: true, confidence: 0.9 }, { anchor_id: "a2", hit: false }] }))
      .mockResolvedValueOnce(apiReply("submit_band", { reasoning_band: 3, ai_justification: "ok", error_class: null, needs_escalation: false }));

    const proposal = await gradeSubjective(INPUT);

    expect(proposal.band.reasoning_band).toBe(3);
    expect(proposal.anchors).toHaveLength(2);
    expect(proposal.cli_version).toBe("anthropic-api");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers["x-api-key"]).toBe("test-key-not-real");
    const body = JSON.parse(init.body);
    expect(body.tool_choice).toEqual({ type: "tool", name: "submit_anchors" });
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.system[0].text).toContain("SKILL BODY");
    expect(body.model).toBe("claude-haiku-4-5");
    expect(body.messages[0].content).toContain("candidate_answer");

    const usage = takeApiUsage();
    expect(usage.calls).toBe(2);
    expect(usage.input_tokens).toBe(2000);
    expect(usage.output_tokens).toBe(200);
    expect(takeApiUsage().calls).toBe(0); // reset after take
  });

  it("turns an API error into AIG_RUNTIME_FAILURE without echoing the request", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), { status: 429 }));
    const err = await gradeSubjective(INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(AI_GRADING_ERROR_CODES.RUNTIME_FAILURE);
    expect((err as AppError).message).toBe("API returned 429 (rate_limit_error)");
    expect(JSON.stringify(err)).not.toContain("first compromise");
  });

  it("fails with AIG_SCHEMA_VIOLATION when the reply has no tool call", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: "text" }], usage: {} }), { status: 200 }));
    const err = await gradeSubjective(INPUT).catch((e: unknown) => e);
    expect((err as AppError).code).toBe(AI_GRADING_ERROR_CODES.SCHEMA_VIOLATION);
  });

  it("rejects with AIG_LEASE_LOST when the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const err = await gradeSubjective({ ...INPUT, signal: ctrl.signal }).catch((e: unknown) => e);
    expect((err as AppError).code).toBe(AI_GRADING_ERROR_CODES.LEASE_LOST);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
