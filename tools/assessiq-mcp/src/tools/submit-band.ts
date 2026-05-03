import { z } from "zod";

export const submitBandTool = {
  name: "submit_band",
  description:
    "Submit reasoning-band classification for the candidate answer. reasoning_band: 0-4 integer; ai_justification: 1-2 paragraph rationale; error_class: one of the 8-class catalog or null when band=4; needs_escalation: true when band crossed multiple thresholds (Stage 3 trigger).",
  inputSchema: {
    type: "object",
    properties: {
      reasoning_band: { type: "integer", minimum: 0, maximum: 4 },
      ai_justification: { type: "string" },
      error_class: { type: ["string", "null"] },
      needs_escalation: { type: "boolean" },
    },
    required: ["reasoning_band", "ai_justification"],
  },
} as const;

const SubmitBandSchema = z.object({
  reasoning_band: z.number().int().min(0).max(4),
  ai_justification: z.string(),
  error_class: z.string().nullable().optional(),
  needs_escalation: z.boolean().optional(),
});

export async function handleSubmitBand(args: unknown) {
  const parsed = SubmitBandSchema.safeParse(args);
  if (!parsed.success) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `submit_band validation failed: ${JSON.stringify(parsed.error.issues)}`,
        },
      ],
    };
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ accepted: true, ...parsed.data }),
      },
    ],
  };
}
