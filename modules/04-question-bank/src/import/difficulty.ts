// EXP-4: source difficulty label -> platform 1..5 scale. The raw label is kept in
// question_source.source_difficulty_raw; the mapped value goes to questions.difficulty_est.
export const DIFFICULTY_SCALES = {
  words: { easy: 2, medium: 3, hard: 4 },
  "1-3": { "1": 1, "2": 3, "3": 5 },
  "1-5": { "1": 1, "2": 2, "3": 3, "4": 4, "5": 5 },
} as const satisfies Record<string, Record<string, number>>;

export type DifficultyScale = keyof typeof DIFFICULTY_SCALES;

export function isDifficultyScale(s: string): s is DifficultyScale {
  return Object.prototype.hasOwnProperty.call(DIFFICULTY_SCALES, s);
}

/** scale blank: a whole number 1..5 uses '1-5', any other label uses 'words'. */
export function mapDifficulty(label: string, scale: string): { value: number } | { error: string } {
  const raw = label.trim().toLowerCase();
  const name = scale.trim().toLowerCase() || (/^[1-5]$/.test(raw) ? "1-5" : "words");
  if (!isDifficultyScale(name)) {
    return { error: `unknown difficulty_scale '${scale}' (use ${Object.keys(DIFFICULTY_SCALES).join(", ")})` };
  }
  const table: Record<string, number> = DIFFICULTY_SCALES[name];
  const value = table[raw];
  if (value === undefined) {
    return { error: `difficulty '${label}' is not in scale '${name}' (allowed: ${Object.keys(table).join(", ")})` };
  }
  return { value };
}
