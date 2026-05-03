# assessiq-mcp

A minimal stdio MCP server that exposes the two structured-output tools Claude Code
uses during admin-triggered grading runs.

## What it does

`assessiq-mcp` makes `submit_anchors` and `submit_band` appear in Claude Code's
allowed-tool surface so the grading skill prompts can call them. Each tool
**validates its input with Zod and echoes it back as the tool result**. The
backend runtime never reads the return value — it reads the same structured input
from the `stream-json` event stream that Claude Code emits. Echoing is just enough
to satisfy the JSON-RPC round-trip and let Claude continue.

This is the "force a JSON-shaped tool call" pattern described in
`docs/05-ai-pipeline.md` § "Custom MCP server for structured output" (lines 89-95).

## Tools exposed

| Tool | Purpose |
|------|---------|
| `submit_anchors` | Per-anchor hit/miss findings (`anchor_id`, `hit`, optional `evidence_quote`, optional `confidence`) |
| `submit_band` | Reasoning-band classification (`reasoning_band` 0-4, `ai_justification`, optional `error_class`, optional `needs_escalation`) |

## Build

From `tools/assessiq-mcp/`:

```bash
pnpm install
pnpm build        # tsc → dist/
pnpm typecheck    # dry-run, no emit
```

The built artifact is `dist/server.js`. Node 22+ required (`"type": "module"`).

## Deploy to VPS

```bash
# 1. Build locally
cd tools/assessiq-mcp && pnpm build

# 2. Copy to VPS (scp preserves the dist/ tree)
scp -r tools/assessiq-mcp/ assessiq-vps:/srv/assessiq/mcp/

# 3. Install production deps on VPS (no devDependencies)
ssh assessiq-vps "cd /srv/assessiq/mcp && npm install --omit=dev"

# 4. Register in the admin user's ~/.claude/.mcp.json
#    Copy .mcp.json.example as a starting point:
#      cp tools/assessiq-mcp/.mcp.json.example  ~/.claude/.mcp.json
#    Merge into an existing ~/.claude/.mcp.json if the file already exists.
```

The `.mcp.json.example` in this directory is the template. Its content:

```json
{
  "mcpServers": {
    "assessiq": {
      "command": "node",
      "args": ["/srv/assessiq/mcp/dist/server.js"],
      "env": {}
    }
  }
}
```

Claude Code spawns this process as a stdio subprocess when the admin's grading
runtime calls `claude --allowedTools assessiq:submit_anchors,assessiq:submit_band`.

## Why the tools just echo

The grading runtime (`modules/07-ai-grading/`) invokes Claude Code with
`--output-format stream-json`. Every tool-use event appears as a structured JSON
line on stdout. The runtime scans those lines for `submit_anchors` and
`submit_band` events and extracts the `input` field — the same data the tool
received. The tool return value is irrelevant to the runtime; echoing keeps the
Claude conversation coherent.

See `docs/05-ai-pipeline.md` § "Custom MCP server for structured output"
(lines 89-95) for the full D2 contract.

## No secrets, no state

This server holds no API keys, no candidate data, and no session state. It is a
pure stdio process that lives only for the duration of a single `claude` invocation.
