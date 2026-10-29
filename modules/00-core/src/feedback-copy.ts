// Z-44: the ONE plain sentence that says what per-question feedback a candidate can read.
// Pure (no node imports): used by the result email (13), the Submitted page and the
// result page (11). The level comes only from assessments.settings.feedback_level (Z-145).

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

/** A stored value to a level; anything unknown or missing reads as "none" (never guess). */
export function toFeedbackLevel(v: unknown): FeedbackLevel {
  return v === "right_wrong" || v === "with_expected_answer" || v === "with_ai_justification" ? v : "none";
}

/** Rank of each level: a higher number shows more. Used by effectiveLevel and the feedback query. */
export const FEEDBACK_LEVEL_RANK: Record<FeedbackLevel, number> = {
  none: 0,
  right_wrong: 1,
  with_expected_answer: 2,
  with_ai_justification: 3,
};

/**
 * Z-145/Z-148: the level a candidate sees. Only a Mock attempt that is not an embed
 * attempt gets the assessment's own level. A Real attempt or any embed attempt gets none.
 * Z-172: `orgKeyOn` is tenant_settings.candidate_answer_key. Off means none, whatever the assessment says,
 * so the organisation switch can only hide more. Required (no default) so a call site cannot forget it.
 */
export function effectiveLevel(
  level: FeedbackLevel,
  ctx: { isMockAttempt: boolean; isEmbed: boolean; orgKeyOn: boolean },
): FeedbackLevel {
  return ctx.orgKeyOn && ctx.isMockAttempt && !ctx.isEmbed ? level : "none";
}
