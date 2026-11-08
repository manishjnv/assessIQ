// CT-0: the ONE place that decides whether a question passes a section's type and difficulty filters.
// Module 06 (the draw at attempt start) and module 05 (the publish pre-flight) both call it, so a test
// that passes publish cannot run short in the draw. Topic (node/category) membership stays with each caller.
export interface SectionTypeDifficultyFilter {
  allowed_types?: readonly string[] | undefined;
  difficulty_min?: number | undefined;
  difficulty_max?: number | undefined;
  /** EXAM-STYLE: the house style of this section (a taxonomy node id). Absent = unstyled. */
  style_node_id?: string | undefined;
}

export function passesSectionTypeAndDifficulty(
  s: SectionTypeDifficultyFilter,
  q: { type: string; difficulty_est: number | null; style_node_ids?: readonly string[] | undefined },
): boolean {
  // EXAM-STYLE: a styled section takes its own style or no style; an unstyled section takes only items with no style.
  const styles = q.style_node_ids ?? [];
  return (
    (styles.length === 0 || (s.style_node_id !== undefined && styles.includes(s.style_node_id))) &&
    (s.allowed_types === undefined || s.allowed_types.includes(q.type)) && // EXP-34
    (s.difficulty_min === undefined || (q.difficulty_est !== null && q.difficulty_est >= s.difficulty_min)) && // FUT-9
    (s.difficulty_max === undefined || (q.difficulty_est !== null && q.difficulty_est <= s.difficulty_max))
  );
}
