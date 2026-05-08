import { z } from "zod";

// ---------------------------------------------------------------------------
// Rubric schema (mirrors @assessiq/rubric-engine RubricSchema without dep)
// ---------------------------------------------------------------------------

const AnchorSchema = z.object({
  id: z.string().min(1),
  concept: z.string().min(1),
  weight: z.number().int().min(0).max(100),
  synonyms: z.array(z.string().min(1)).min(1),
}).strict();

const ReasoningBandsSchema = z.object({
  band_4: z.string().min(1),
  band_3: z.string().min(1),
  band_2: z.string().min(1),
  band_1: z.string().min(1),
  band_0: z.string().min(1),
}).strict();

const SubmitRubricInputSchema = z.object({
  anchors: z.array(AnchorSchema).min(1),
  reasoning_bands: ReasoningBandsSchema,
  anchor_weight_total: z.number().int().min(0).max(100),
  reasoning_weight_total: z.number().int().min(0).max(100),
}).strict().refine(
  (r) => r.anchor_weight_total + r.reasoning_weight_total === 100,
  { message: "anchor_weight_total + reasoning_weight_total must equal 100" },
);

// ---------------------------------------------------------------------------
// Tool definition (MCP ListTools response shape)
// ---------------------------------------------------------------------------

export const submitRubricTool = {
  name: "submit_rubric",
  description:
    "Submit a generated rubric draft. " +
    "anchor_weight_total + reasoning_weight_total MUST equal 100. " +
    "Include at least 2 anchors. All 5 bands (band_0..band_4) required. " +
    "Do not call this tool more than once per generation.",
  inputSchema: {
    type: "object",
    required: ["anchors", "reasoning_bands", "anchor_weight_total", "reasoning_weight_total"],
    properties: {
      anchors: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "concept", "weight", "synonyms"],
          properties: {
            id: { type: "string" },
            concept: { type: "string" },
            weight: { type: "integer", minimum: 0, maximum: 100 },
            synonyms: { type: "array", items: { type: "string" } },
          },
        },
      },
      reasoning_bands: {
        type: "object",
        required: ["band_0", "band_1", "band_2", "band_3", "band_4"],
        properties: {
          band_0: { type: "string" },
          band_1: { type: "string" },
          band_2: { type: "string" },
          band_3: { type: "string" },
          band_4: { type: "string" },
        },
      },
      anchor_weight_total: { type: "integer", minimum: 0, maximum: 100 },
      reasoning_weight_total: { type: "integer", minimum: 0, maximum: 100 },
    },
  },
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function handleSubmitRubric(
  args: unknown,
): { content: Array<{ type: "text"; text: string }> } {
  const parsed = SubmitRubricInputSchema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return {
      content: [{ type: "text", text: `validation_error: ${issues}` }],
    };
  }
  // Emit valid rubric as JSON so the runtime can parse it from stream-json output
  return {
    content: [{ type: "text", text: JSON.stringify({ rubric: parsed.data }) }],
  };
}
