/**
 * Scale a 0-4 reasoning band to a score out of the grading's own `scoreMax`.
 * Overrides must stay within 0..score_max (the API rejects anything else), and
 * score_max is the rubric total for AI rows but `questions.points` for
 * AI-failure placeholders — so a fixed `band * 25` is wrong for the latter.
 * Rounded to 2 dp to match the NUMERIC(6,2) column.
 */
export function bandToScore(band: number, scoreMax: number): number {
  return Math.round(((scoreMax * band) / 4) * 100) / 100;
}
