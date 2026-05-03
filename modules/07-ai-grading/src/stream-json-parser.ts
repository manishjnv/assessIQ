// AssessIQ — Phase 1 claude-code stream-json parser.
//
// `claude -p ... --output-format stream-json` emits one newline-delimited JSON
// object per agent event (assistant turn, tool_use, tool_result, message_stop,
// etc.). The runtime captures the stdout buffer across multiple `data` events
// and parses lines as they complete. Tool-use events' `input` field carries
// the structured grade data we need (submit_anchors / submit_band).
//
// Tool-name matching uses an EXACT prefix match (`mcp__assessiq__<short>`)
// not a suffix match. The looser `endsWith` form was rejected during the
// 1.b adversarial rescue (Finding #2): `endsWith("submit_band")` would also
// match a hypothetical `mcp__rogue__submit_band` from a future MCP server in
// the admin's .mcp.json. The exact-prefix check binds the parser to our
// known MCP server identity. The Anthropic-side `--allowed-tools` flag is
// the primary defense (Claude can only CALL allowed tools); this is the
// layered defense at the parse-the-output side.

import { streamLogger } from "@assessiq/core";

const log = streamLogger("grading");

export interface StreamJsonContentItem {
  type: string;
  name?: string;
  input?: unknown;
  text?: string;
  [k: string]: unknown;
}

export interface StreamJsonEvent {
  type: string;
  message?: {
    content?: StreamJsonContentItem[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/**
 * Splits a stdout buffer into newline-delimited JSON events plus a leftover
 * (possibly empty) remainder. The caller is expected to carry `remainder`
 * across subsequent `data` callbacks until the subprocess exits.
 *
 * Lines that fail JSON.parse are silently dropped after a debug log — Claude
 * Code occasionally emits non-JSON status lines and we shouldn't crash on
 * them. Never logs full content (PII risk per docs/11-observability.md § 4).
 */
export function parseStreamLines(buf: string): {
  events: StreamJsonEvent[];
  remainder: string;
} {
  const lines = buf.split("\n");
  const remainder = lines.pop() ?? "";
  const events: StreamJsonEvent[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const ev = JSON.parse(trimmed) as StreamJsonEvent;
      events.push(ev);
    } catch {
      log.debug({ lineLength: trimmed.length }, "stream-json.unparseable");
    }
  }
  return { events, remainder };
}

/** MCP namespace owned by AssessIQ — must match `tools/assessiq-mcp/`. */
const MCP_NAMESPACE = "mcp__assessiq__";

/**
 * Walk all events, find the first `tool_use` content item whose `name`
 * is either the bare short name (`toolName`) or our exact MCP-namespaced
 * form (`mcp__assessiq__<toolName>`). Returns the tool's `input` payload,
 * or `null` if no matching tool use is found.
 *
 * Exact-prefix match (rather than `endsWith`) prevents collision with any
 * future MCP server whose tool happens to end in the same short name.
 */
export function parseToolInput(
  events: StreamJsonEvent[],
  toolName: string,
): unknown | null {
  const namespaced = MCP_NAMESPACE + toolName;
  for (const ev of events) {
    const content = ev.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item.type !== "tool_use") continue;
      const name = typeof item.name === "string" ? item.name : "";
      if (name === toolName || name === namespaced) {
        return item.input ?? null;
      }
    }
  }
  return null;
}
