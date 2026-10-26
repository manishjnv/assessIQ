// CT-0: the ONE place that decides whether a question passes a section's type and difficulty filters.
// Module 06 (the draw at attempt start) and module 05 (the publish pre-flight) both call it, so a test
// that passes publish cannot run short in the draw. Topic (node/category) membership stays with each caller.
export interface SectionTypeDifficultyFilter {
  allowed_types?: readonly string[] | undefined;
  difficulty_min?: number | undefined;
  difficulty_max?: number | undefined;
}

export function passesSectionTypeAndDifficulty(
  s: SectionTypeDifficultyFilter,
  q: { type: string; difficulty_est: number | null },
): boolean {
  return (
    (s.allowed_types === undefined || s.allowed_types.includes(q.type)) && // EXP-34
    (s.difficulty_min === undefined || (q.difficulty_est !== null && q.difficulty_est >= s.difficulty_min)) && // FUT-9
    (s.difficulty_max === undefined || (q.difficulty_est !== null && q.difficulty_est <= s.difficulty_max))
  );
}
