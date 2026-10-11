// ---------------------------------------------------------------------------
// deriveQuestionTextForGuidance — answer-key-FREE stem for hint generation
// (feature #4, Phase B)
// ---------------------------------------------------------------------------
//
// SAFETY: the answer-format-hint generator must never see the answer. This
// returns only candidate-visible stem text per type and deliberately OMITS:
//   - mcq:          options / correct / rationale
//   - log_analysis: expected_findings / sample_solution / log_excerpt
//   - scenario:     steps[].expected (keeps only steps[].prompt)
//   - subjective/kql: (no answer key in content beyond the stem)
//
// Distinct from question-bank service's deriveQuestionTextForRubric, which DOES
// pass the full content because the rubric legitimately needs the reference
// answer. Pure / dependency-free so the no-leak property is unit-testable.

import { isQuestionType, getQuestionType } from "@assessiq/question-types";

export function deriveQuestionTextForGuidance(
  question: { type: string; content: unknown },
): string {
  // Unknown stored types fall back to the stem-only behaviour (was the switch default).
  if (!isQuestionType(question.type)) {
    const c = (question.content ?? {}) as Record<string, unknown>;
    return typeof c.question === "string" ? c.question.trim() : "";
  }
  return getQuestionType(question.type).guidanceText(question.content);
}
