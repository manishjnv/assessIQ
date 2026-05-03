// AssessIQ — rubric validation public helper.
//
// Per PHASE_2_KICKOFF.md G2.B Session 2: a unified shape `{ valid, errors }`
// suitable for surfacing back to API callers and admin authoring UI.
//
// NOTE: 04-question-bank ships its own `validateRubric` returning
// `{ ok, data | errors: ZodIssue[] }` for service-internal consumers (its
// `createQuestion` / `updateQuestion` paths bind to the ZodIssue shape for
// per-issue error code mapping). The two coexist on purpose — same name,
// different module, different return contract — and 04's local one is NOT
// re-exported from this module.

import { RubricSchema } from "./types.js";

export function validateRubric(
  rubric: unknown,
): { valid: boolean; errors: string[] } {
  const result = RubricSchema.safeParse(rubric);
  if (result.success) {
    return { valid: true, errors: [] };
  }
  return {
    valid: false,
    errors: result.error.issues.map((i) => {
      const path = i.path.length > 0 ? i.path.join(".") : "(root)";
      return `${path}: ${i.message}`;
    }),
  };
}
