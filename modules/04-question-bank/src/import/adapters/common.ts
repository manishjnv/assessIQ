// RW-59: shared bits of the GIFT / Aiken / QTI adapters. They emit cells in exactly the CSV
// template formats (JSON array in a cell), so validateRow accepts them unchanged.
import { ValidationError } from "@assessiq/core";
import { IMPORT_MAX_ROWS } from "../limits.js";
import type { ParsedRow } from "../types.js";

export const tooManyRows = (): ValidationError =>
  new ValidationError(`File exceeds ${IMPORT_MAX_ROWS} data rows`, { details: { code: "IMPORT_TOO_MANY_ROWS" } });

/** One mcq row. `correct` is the 0-based option index. */
export function mcqRow(row: number, topic: string, question: string, options: string[], correct: number, rationale: string): ParsedRow {
  return {
    row,
    cells: {
      type: "mcq",
      topic: topic.slice(0, 200),
      points: "1",
      level: "1",
      question,
      options: JSON.stringify(options),
      correct: String(correct),
      rationale,
    },
  };
}

export const defaultTopic = (question: string): string => question.slice(0, 60);
