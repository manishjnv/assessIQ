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

import { apiUsageCostUsd, gradeSubjective, resetApiKeyFailover, setRetryBaseMsForTests, takeApiUsage } from "../runtimes/anthropic-api.js";
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
  resetApiKeyFailover();
  setRetryBaseMsForTests(0);
  delete process.env["ANTHROPIC_API_KEY_FALLBACK"];
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["ANTHROPIC_API_KEY_FALLBACK"];
});

const creditError = (): Response =>
  new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }), { status: 400 });
const keyUsed = (call: number): string => (fetchMock.mock.calls[call] as [string, { headers: Record<string, string> }])[1].headers["x-api-key"] as string;

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
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), { status: 429 })));
    const err = await gradeSubjective(INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(AI_GRADING_ERROR_CODES.RUNTIME_FAILURE);
    expect((err as AppError).message).toBe("API returned 429 (rate_limit_error)");
    expect(fetchMock).toHaveBeenCalledTimes(5); // 1 try + 4 retries
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

describe("key failover", () => {
  it("moves to the fallback key on a credit error and stays on it", async () => {
    process.env["ANTHROPIC_API_KEY_FALLBACK"] = "fallback-key-not-real";
    fetchMock
      .mockResolvedValueOnce(creditError()) // stage 1 on key 1
      .mockResolvedValueOnce(apiReply("submit_anchors", { findings: [{ anchor_id: "a1", hit: true }, { anchor_id: "a2", hit: false }] })) // retry on key 2
      .mockResolvedValueOnce(apiReply("submit_band", { reasoning_band: 2, ai_justification: "ok" })); // stage 2 stays on key 2
    const proposal = await gradeSubjective(INPUT);
    expect(proposal.band.reasoning_band).toBe(2);
    expect(keyUsed(0)).toBe("test-key-not-real");
    expect(keyUsed(1)).toBe("fallback-key-not-real");
    expect(keyUsed(2)).toBe("fallback-key-not-real");
  });

  it("does not switch keys on a server error", async () => {
    process.env["ANTHROPIC_API_KEY_FALLBACK"] = "fallback-key-not-real";
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ error: { type: "api_error" } }), { status: 500 })));
    const err = await gradeSubjective(INPUT).catch((e: unknown) => e);
    expect((err as AppError).message).toBe("API returned 500 (api_error)");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    for (let i = 0; i < 5; i++) expect(keyUsed(i)).toBe("test-key-not-real"); // never the fallback key
  });

  it("fails when both keys are out of credit", async () => {
    process.env["ANTHROPIC_API_KEY_FALLBACK"] = "fallback-key-not-real";
    fetchMock.mockResolvedValueOnce(creditError()).mockResolvedValueOnce(creditError());
    const err = await gradeSubjective(INPUT).catch((e: unknown) => e);
    expect((err as AppError).code).toBe(AI_GRADING_ERROR_CODES.RUNTIME_FAILURE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("model choice", () => {
  it("uses tool_choice auto for a model that rejects forced tool calls, and sends the effort", async () => {
    process.env["AI_API_MODEL_GRADE_ANCHORS"] = "claude-sonnet-5-5";
    process.env["AI_API_EFFORT"] = "low";
    try {
      fetchMock
        .mockResolvedValueOnce(apiReply("submit_anchors", { findings: [{ anchor_id: "a1", hit: true }, { anchor_id: "a2", hit: false }] }))
        .mockResolvedValueOnce(apiReply("submit_band", { reasoning_band: 2, ai_justification: "ok" }));
      await gradeSubjective(INPUT);
      const first = JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body);
      expect(first.model).toBe("claude-sonnet-5-5");
      expect(first.tool_choice).toEqual({ type: "auto" });
      expect(first.output_config).toEqual({ effort: "low" });
      const second = JSON.parse((fetchMock.mock.calls[1] as [string, { body: string }])[1].body);
      expect(second.model).toBe("claude-haiku-4-5"); // frontmatter model, no override for the band stage
      expect(second.tool_choice).toEqual({ type: "tool", name: "submit_band" });
      expect(second.output_config).toBeUndefined(); // 4.x model: no effort sent
    } finally {
      delete process.env["AI_API_MODEL_GRADE_ANCHORS"];
      delete process.env["AI_API_EFFORT"];
    }
  });
});

describe("retry, stop reason and tool blocks (Z-164 E10-E13)", () => {
  const goodBand = () => apiReply("submit_band", { reasoning_band: 2, ai_justification: "ok" });
  const goodAnchors = () => apiReply("submit_anchors", { findings: [{ anchor_id: "a1", hit: true }, { anchor_id: "a2", hit: false }] });

  it("E10: asks for 8000 output tokens", async () => {
    fetchMock.mockResolvedValueOnce(goodAnchors()).mockResolvedValueOnce(goodBand());
    await gradeSubjective(INPUT);
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body).max_tokens).toBe(8000);
  });

  it("E10: a reply cut at max_tokens fails and does not use the partial tool input", async () => {
    const cut = new Response(
      JSON.stringify({ stop_reason: "max_tokens", content: [{ type: "tool_use", name: "submit_anchors", input: { findings: [] } }], usage: { input_tokens: 10, output_tokens: 8000 } }),
      { status: 200 },
    );
    fetchMock.mockResolvedValueOnce(cut);
    const err = await gradeSubjective(INPUT).catch((e: unknown) => e);
    expect((err as AppError).code).toBe(AI_GRADING_ERROR_CODES.RUNTIME_FAILURE);
    expect((err as AppError).message).toContain("max_tokens");
    expect(takeApiUsage().output_tokens).toBe(8000); // the spend is still counted
  });

  it("E10: a refusal fails", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ stop_reason: "refusal", content: [], usage: {} }), { status: 200 }));
    const err = await gradeSubjective(INPUT).catch((e: unknown) => e);
    expect((err as AppError).code).toBe(AI_GRADING_ERROR_CODES.RUNTIME_FAILURE);
  });

  it("E11: retries a 529 and a 429 after a wait, then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { type: "overloaded_error" } }), { status: 529 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), { status: 429 }))
      .mockResolvedValueOnce(goodAnchors())
      .mockResolvedValueOnce(goodBand());
    const p = await gradeSubjective(INPUT);
    expect(p.band.reasoning_band).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("E11: a rate limit does not switch to the fallback key", async () => {
    process.env["ANTHROPIC_API_KEY_FALLBACK"] = "fallback-key-not-real";
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), { status: 429 }))
      .mockResolvedValueOnce(goodAnchors())
      .mockResolvedValueOnce(goodBand());
    await gradeSubjective(INPUT);
    expect(keyUsed(0)).toBe("test-key-not-real");
    expect(keyUsed(1)).toBe("test-key-not-real");
  });

  it("E12: usage by model keeps cache write and read tokens, and the cost counts them", async () => {
    const usage = { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 4000, cache_read_input_tokens: 8000 };
    fetchMock.mockResolvedValueOnce(apiReply("submit_anchors", { findings: [] }, usage as never)).mockResolvedValueOnce(apiReply("submit_band", { reasoning_band: 1, ai_justification: "x" }, usage as never));
    await gradeSubjective(INPUT);
    const u = takeApiUsage();
    expect(u.by_model["claude-haiku-4-5"]).toMatchObject({ calls: 2, cache_creation_input_tokens: 8000, cache_read_input_tokens: 16000 });
    // haiku-4 price $1 in / $5 out per million: (2000 + 1.25*8000 + 0.1*16000) in + 200 out
    expect(apiUsageCostUsd(u)).toBeCloseTo(((2000 + 10000 + 1600) * 1 + 200 * 5) / 1_000_000, 8);
  });

  it("E13: with several tool_use blocks the first is used", async () => {
    const two = new Response(
      JSON.stringify({
        content: [
          { type: "tool_use", name: "submit_anchors", input: { findings: [{ anchor_id: "a1", hit: true }, { anchor_id: "a2", hit: false }] } },
          { type: "tool_use", name: "submit_anchors", input: { findings: [{ anchor_id: "a1", hit: false }, { anchor_id: "a2", hit: false }] } },
        ],
        usage: { input_tokens: 5, output_tokens: 5 },
      }),
      { status: 200 },
    );
    fetchMock.mockResolvedValueOnce(two).mockResolvedValueOnce(goodBand());
    const p = await gradeSubjective(INPUT);
    expect(p.anchors[0]?.hit).toBe(true);
  });

  it("E13: no matching tool_use block is an error that names the block types", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: "text" }, { type: "tool_use", name: "other_tool", input: {} }], usage: {} }), { status: 200 }));
    const err = await gradeSubjective(INPUT).catch((e: unknown) => e);
    expect((err as AppError).code).toBe(AI_GRADING_ERROR_CODES.SCHEMA_VIOLATION);
    expect(JSON.stringify((err as AppError).details)).toContain("tool_use");
  });
});
