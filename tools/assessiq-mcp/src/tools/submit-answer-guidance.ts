import { z } from "zod";

// ---------------------------------------------------------------------------
// submit_answer_guidance — candidate answer-format hint (feature #4, Phase B)
// ---------------------------------------------------------------------------
//
// The generate-answer-guidance skill calls this exactly once with a short,
// candidate-facing instruction on HOW to answer (length / form / structure).
// It is INSTRUCTIONAL and candidate-safe — never a rubric or answer key. The
// 280-char ceiling mirrors the DB column / route bound; the skill targets ≤140.

const SubmitAnswerGuidanceInputSchema = z
  .object({
    answer_guidance: z.string().min(1).max(280),
  })
  .strict();

// ---------------------------------------------------------------------------
// Tool definition (MCP ListTools response shape)
// ---------------------------------------------------------------------------

export const submitAnswerGuidanceTool = {
  name: "submit_answer_guidance",
  description:
    "Submit a single candidate-facing answer-format hint (HOW to answer, not WHAT). " +
    "One short imperative sentence, ≤280 chars. Never reveal or hint at the answer. " +
    "Call this tool exactly once.",
  inputSchema: {
    type: "object",
    required: ["answer_guidance"],
    properties: {
      answer_guidance: { type: "string", minLength: 1, maxLength: 280 },
    },
  },
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function handleSubmitAnswerGuidance(
  args: unknown,
): { content: Array<{ type: "text"; text: string }> } {
  const parsed = SubmitAnswerGuidanceInputSchema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return {
      content: [{ type: "text", text: `validation_error: ${issues}` }],
    };
  }
  // Emit the validated hint as JSON so the runtime can parse it from stream-json.
  return {
    content: [
      { type: "text", text: JSON.stringify({ answer_guidance: parsed.data.answer_guidance }) },
    ],
  };
}
