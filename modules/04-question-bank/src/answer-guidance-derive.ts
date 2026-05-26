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

export function deriveQuestionTextForGuidance(
  question: { type: string; content: unknown },
): string {
  const c = (question.content ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");

  switch (question.type) {
    case "scenario": {
      const parts: string[] = [str(c.title), str(c.intro)];
      if (Array.isArray(c.steps)) {
        for (const s of c.steps) {
          if (s && typeof s === "object") {
            // ONLY the candidate-visible prompt — never steps[].expected.
            parts.push(str((s as Record<string, unknown>).prompt));
          }
        }
      }
      return parts.filter(Boolean).join("\n").trim();
    }
    case "log_analysis":
      // question + log_format only — never expected_findings/sample_solution/log_excerpt.
      return [str(c.question), str(c.log_format)].filter(Boolean).join("\n").trim();
    case "mcq":
    case "subjective":
    case "kql":
    default:
      // Stem only — for mcq this omits options/correct/rationale.
      return str(c.question).trim();
  }
}
