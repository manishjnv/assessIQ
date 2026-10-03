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

/**
 * FU-C17 strict rules, enforced on SAVE only (04 question create/update).
 * `parseRubric` stays lenient so stored old rubrics still load and grade.
 * Returns human-readable issues; empty array = clean.
 */
export function strictRubricIssues(rubric: Rubric): string[] {
  const issues: string[] = [];
  const sum = rubric.anchors.reduce((s, a) => s + a.weight, 0);
  if (sum !== rubric.anchor_weight_total) {
    issues.push(`anchors: weights sum to ${sum}, must equal anchor_weight_total (${rubric.anchor_weight_total})`);
  }
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const a of rubric.anchors) (seen.has(a.id) ? dups : seen).add(a.id);
  if (dups.size > 0) issues.push(`anchors: duplicate anchor ids: ${[...dups].join(", ")}`);
  for (const [k, v] of Object.entries(rubric.reasoning_bands)) {
    if (v.trim().length === 0) issues.push(`reasoning_bands.${k}: band text must not be empty`);
  }
  return issues;
}
