#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  submitAnchorsTool,
  handleSubmitAnchors,
} from "./tools/submit-anchors.js";
import { submitBandTool, handleSubmitBand } from "./tools/submit-band.js";

const server = new Server(
  { name: "assessiq-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [submitAnchorsTool, submitBandTool],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  switch (name) {
    case "submit_anchors":
      return handleSubmitAnchors(args);
    case "submit_band":
      return handleSubmitBand(args);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("assessiq-mcp ready\n");
