// ---------------------------------------------------------------------------
// Candidate answer-format hint — per-type defaults + resolver (feature #4)
// ---------------------------------------------------------------------------
//
// `answer_guidance` is a per-question, candidate-facing instruction on HOW to
// answer (e.g. "Select the one best option."). It is INSTRUCTIONAL and
// candidate-safe — never a rubric or answer key. When a question carries no
// authored value the candidate is shown a per-type default so every question
// has a hint.
//
// This module is intentionally dependency-free (no DB, no I/O) so it can be
// unit-tested directly and reused by the Phase B AI-generation path.

/**
 * Per-type fallback shown when a question has no authored `answer_guidance`.
 * Keep these short and imperative; they are rendered verbatim to the candidate.
 */
export const ANSWER_GUIDANCE_DEFAULTS: Record<string, string> = {
  mcq: "Select the one best option.",
  kql: "Write a KQL query.",
  subjective: "Write a focused answer — about 3–6 sentences.",
  log_analysis: "List each finding, then a short explanation.",
  scenario: "Answer each step in 2–4 sentences.",
};

/** Generic fallback for any type without a specific default. */
export const ANSWER_GUIDANCE_FALLBACK = "Answer in the space provided.";

/**
 * Resolve the candidate-facing hint: an authored value if present and
 * non-blank, else the per-type default, else the generic fallback. Always
 * returns a non-empty string so the candidate UI can render it unconditionally.
 */
export function answerGuidanceFor(type: string, stored: string | null | undefined): string {
  if (typeof stored === "string" && stored.trim().length > 0) return stored;
  return ANSWER_GUIDANCE_DEFAULTS[type] ?? ANSWER_GUIDANCE_FALLBACK;
}
