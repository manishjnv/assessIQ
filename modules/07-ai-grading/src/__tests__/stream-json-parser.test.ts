/**
 * Unit tests for ../stream-json-parser.ts
 *
 * Covers parseStreamLines and parseToolInput — pure in-memory, no I/O.
 *
 * parseStreamLines: newline-delimited JSON buffer splitting, remainder
 * tracking, whitespace-only lines, unparseable lines.
 *
 * parseToolInput: tool_use matching by exact name, MCP-namespaced endsWith,
 * no-match cases, multiple tool_use ordering (first match wins).
 */

import { describe, it, expect } from "vitest";
import {
  parseStreamLines,
  parseToolInput,
  type StreamJsonEvent,
} from "../stream-json-parser.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAssistantEvent(toolName: string, input: unknown): StreamJsonEvent {
  return {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", name: toolName, input },
      ],
    },
  };
}

function makeTextEvent(text: string): StreamJsonEvent {
  return {
    type: "assistant",
    message: {
      content: [{ type: "text", text }],
    },
  };
}

// ---------------------------------------------------------------------------
// parseStreamLines
// ---------------------------------------------------------------------------

describe("parseStreamLines", () => {
  it("three complete lines → 3 events, empty remainder", () => {
    const e1 = { type: "ping" };
    const e2 = { type: "pong" };
    const e3 = { type: "done" };
    const buf =
      JSON.stringify(e1) + "\n" +
      JSON.stringify(e2) + "\n" +
      JSON.stringify(e3) + "\n";

    const { events, remainder } = parseStreamLines(buf);
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual(e1);
    expect(events[1]).toEqual(e2);
    expect(events[2]).toEqual(e3);
    expect(remainder).toBe("");
  });

  it("two complete lines + partial third → 2 events, partial line as remainder", () => {
    const e1 = { type: "a" };
    const e2 = { type: "b" };
    const partial = '{"type":"c","unfinished":';
    const buf =
      JSON.stringify(e1) + "\n" +
      JSON.stringify(e2) + "\n" +
      partial;

    const { events, remainder } = parseStreamLines(buf);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(e1);
    expect(events[1]).toEqual(e2);
    expect(remainder).toBe(partial);
  });

  it("empty buffer → 0 events, empty remainder", () => {
    const { events, remainder } = parseStreamLines("");
    expect(events).toHaveLength(0);
    expect(remainder).toBe("");
  });

  it("buffer with whitespace-only lines → those lines silently skipped", () => {
    const e1 = { type: "real" };
    // All lines end with \n so the last split produces an empty string that
    // gets popped as remainder. The whitespace-only lines ("   ", "\t", "  ")
    // are complete lines (before the \n), trimmed to empty, and skipped.
    const buf =
      "   \n" +
      "\t\n" +
      JSON.stringify(e1) + "\n" +
      "  \n";

    const { events, remainder } = parseStreamLines(buf);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(e1);
    // After trailing "\n", split produces "" as the last element, which pop()
    // returns as remainder.
    expect(remainder).toBe("");
  });

  it("buffer with one unparseable line surrounded by valid → valid events parsed, bad line silently dropped", () => {
    const e1 = { type: "before" };
    const e2 = { type: "after" };
    const buf =
      JSON.stringify(e1) + "\n" +
      "this is not json at all!!!\n" +
      JSON.stringify(e2) + "\n";

    const { events, remainder } = parseStreamLines(buf);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(e1);
    expect(events[1]).toEqual(e2);
    expect(remainder).toBe("");
  });

  it("single line without trailing newline → 0 events, full line as remainder", () => {
    const buf = JSON.stringify({ type: "pending" });
    const { events, remainder } = parseStreamLines(buf);
    expect(events).toHaveLength(0);
    expect(remainder).toBe(buf);
  });

  it("multiple complete lines all unparseable → 0 events, empty remainder", () => {
    const buf = "not-json\nalso-not-json\n";
    const { events, remainder } = parseStreamLines(buf);
    expect(events).toHaveLength(0);
    expect(remainder).toBe("");
  });
});

// ---------------------------------------------------------------------------
// parseToolInput
// ---------------------------------------------------------------------------

describe("parseToolInput", () => {
  it("event with tool_use of exact name 'submit_anchors' → returns its input", () => {
    const input = { findings: [{ anchor_id: "a1", hit: true }] };
    const events = [makeAssistantEvent("submit_anchors", input)];
    expect(parseToolInput(events, "submit_anchors")).toEqual(input);
  });

  it("event with MCP-namespaced name 'mcp__assessiq__submit_anchors' matches via endsWith", () => {
    const input = { findings: [{ anchor_id: "a2", hit: false }] };
    const events = [makeAssistantEvent("mcp__assessiq__submit_anchors", input)];
    expect(parseToolInput(events, "submit_anchors")).toEqual(input);
  });

  it("event with no tool_use content item → returns null", () => {
    const events: StreamJsonEvent[] = [makeTextEvent("some narration")];
    expect(parseToolInput(events, "submit_anchors")).toBeNull();
  });

  it("event with tool_use but wrong name → returns null", () => {
    const events = [makeAssistantEvent("submit_band", { reasoning_band: 3, ai_justification: "ok", error_class: null })];
    expect(parseToolInput(events, "submit_anchors")).toBeNull();
  });

  it("empty events array → returns null", () => {
    expect(parseToolInput([], "submit_anchors")).toBeNull();
  });

  it("events with multiple tool_use — first matching name wins", () => {
    const first = { findings: [{ anchor_id: "first", hit: true }] };
    const second = { findings: [{ anchor_id: "second", hit: false }] };
    const events: StreamJsonEvent[] = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "submit_anchors", input: first },
            { type: "tool_use", name: "submit_anchors", input: second },
          ],
        },
      },
    ];
    expect(parseToolInput(events, "submit_anchors")).toEqual(first);
  });

  it("matching tool_use in second event is found when first event has no match", () => {
    const input = { reasoning_band: 2, ai_justification: "good", error_class: null };
    const events: StreamJsonEvent[] = [
      makeTextEvent("thinking..."),
      makeAssistantEvent("submit_band", input),
    ];
    expect(parseToolInput(events, "submit_band")).toEqual(input);
  });

  it("event whose message.content is missing → skipped without throwing", () => {
    const events: StreamJsonEvent[] = [
      { type: "message_stop" },
      makeAssistantEvent("submit_anchors", { findings: [] }),
    ];
    expect(parseToolInput(events, "submit_anchors")).toEqual({ findings: [] });
  });

  it("tool_use with input null → returns null (item.input ?? null)", () => {
    const events: StreamJsonEvent[] = [
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "submit_anchors", input: null }],
        },
      },
    ];
    // item.input is null → null ?? null = null — this is the documented behaviour
    expect(parseToolInput(events, "submit_anchors")).toBeNull();
  });

  it("namespaced endsWith match does not fire on partial suffix overlap", () => {
    // "bad__submit_anchors_extra" does NOT endWith "submit_anchors"
    const events = [makeAssistantEvent("mcp__assessiq__submit_anchors_extra", { findings: [] })];
    expect(parseToolInput(events, "submit_anchors")).toBeNull();
  });
});
