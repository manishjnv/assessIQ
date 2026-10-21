// Z-103 suggested test time. SUGGESTION ONLY: the admin time limit stays the override.
// Edit the numbers here. Minutes per question; no code anywhere else holds them.

type Band = "easy" | "medium" | "hard";

const FLAT = (m: number) => ({ easy: m, medium: m, hard: m });
const OBJECTIVE = { easy: 0.75, medium: 1.25, hard: 1.75 };

const MINUTES_PER_QUESTION: Record<string, Record<Band, number>> = {
  mcq: OBJECTIVE,
  multi_select: OBJECTIVE,
  numeric: OBJECTIVE,
  ordering: OBJECTIVE,
  subjective: FLAT(5),
  kql: FLAT(6),
  log_analysis: FLAT(6),
  scenario: FLAT(10),
  structured_case: FLAT(10),
};

/** 1-2 easy, 3 medium, 4-5 hard, null (or anything else) medium. */
function band(difficultyEst: number | null | undefined): Band {
  if (difficultyEst === 1 || difficultyEst === 2) return "easy";
  if (difficultyEst === 4 || difficultyEst === 5) return "hard";
  return "medium";
}

export function minutesForQuestion(type: string, difficultyEst: number | null | undefined): number {
  // Unknown type: the medium mcq value, whatever the difficulty.
  const row = MINUTES_PER_QUESTION[type];
  return row ? row[band(difficultyEst)] : OBJECTIVE.medium;
}

/** Average minutes per question for a set of questions, 2 decimals; 0 when empty. */
export function averageMinutesPerQuestion(rows: ReadonlyArray<{ type: string; difficulty_est: number | null }>): number {
  if (rows.length === 0) return 0;
  const sum = rows.reduce((a, r) => a + minutesForQuestion(r.type, r.difficulty_est), 0);
  return Math.round((sum / rows.length) * 100) / 100;
}
