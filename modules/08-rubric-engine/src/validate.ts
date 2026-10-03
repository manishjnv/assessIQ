// AssessIQ — rubric validation public helper.
//
// Per PHASE_2_KICKOFF.md G2.B Session 2: a unified shape `{ valid, errors }`
// suitable for surfacing back to API callers and admin authoring UI.
//
// 04-question-bank re-exports `parseRubric` as its own `validateRubric` (ok/data shape).

import type { ZodIssue } from "zod";
import { RubricSchema, type Rubric } from "./types.js";

/** Single rubric parser (FR25). 04-question-bank re-exports this as its `validateRubric`. */
export function parseRubric(
  input: unknown,
): { ok: true; data: Rubric } | { ok: false; errors: ZodIssue[] } {
  const result = RubricSchema.safeParse(input);
  return result.success
    ? { ok: true, data: result.data }
    : { ok: false, errors: result.error.issues };
}

export function validateRubric(
  rubric: unknown,
): { valid: boolean; errors: string[] } {
  const result = parseRubric(rubric);
  if (result.ok) return { valid: true, errors: [] };
  return {
    valid: false,
    errors: result.errors.map((i) => {
      const path = i.path.length > 0 ? i.path.join(".") : "(root)";
      return `${path}: ${i.message}`;
    }),
  };
}
