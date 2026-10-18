// Z-44: the ONE plain sentence that says what per-question feedback a candidate can read.
// Pure (no node imports): used by the result email (13), the Submitted page and the
// result page (11). The level comes only from tenant_settings.result_feedback_level.

export type FeedbackLevel = "none" | "right_wrong" | "with_expected_answer" | "with_ai_justification";

const SENTENCES: Record<Exclude<FeedbackLevel, "none">, string> = {
  right_wrong: "Your feedback shows which answers were right and which were wrong.",
  with_expected_answer:
    "Your feedback shows which answers were right or wrong, and the expected answer where one exists.",
  with_ai_justification:
    "Your feedback shows which answers were right or wrong, the expected answer where one exists, and a short reason for answers graded by AI.",
};

/** The sentence for a level, or null for "none" (and for any unknown value: never guess). */
export function feedbackSentence(level: string | null | undefined): string | null {
  return level === "right_wrong" || level === "with_expected_answer" || level === "with_ai_justification"
    ? SENTENCES[level]
    : null;
}
