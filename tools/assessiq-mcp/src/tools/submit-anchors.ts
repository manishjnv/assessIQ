import { z } from "zod";

export const submitAnchorsTool = {
  name: "submit_anchors",
  description:
    "Submit per-anchor hit/miss findings for the candidate answer. Each finding has anchor_id, hit (boolean), evidence_quote (max 200 chars, may be null), confidence (0.0-1.0).",
  inputSchema: {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            anchor_id: { type: "string" },
            hit: { type: "boolean" },
            evidence_quote: { type: ["string", "null"], maxLength: 200 },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["anchor_id", "hit"],
        },
      },
    },
    required: ["findings"],
  },
} as const;

const SubmitAnchorsSchema = z.object({
  findings: z.array(
    z.object({
      anchor_id: z.string(),
      hit: z.boolean(),
      evidence_quote: z.string().max(200).nullable().optional(),
      confidence: z.number().min(0).max(1).optional(),
    }),
  ),
});

export async function handleSubmitAnchors(args: unknown) {
  const parsed = SubmitAnchorsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `submit_anchors validation failed: ${JSON.stringify(parsed.error.issues)}`,
        },
      ],
    };
  }
  // The runtime extracts the input from the stream-json tool-use event,
  // not from this return value. Echo as a structured JSON content block
  // so Claude Code's stream-json output captures it.
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ accepted: true, findings: parsed.data.findings }),
      },
    ],
  };
}
