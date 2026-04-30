import { ValidationError } from "./errors.js";

/**
 * The ONLY place in the codebase that calls `new Date()`.
 * Returns the current time as a UTC ISO 8601 string (ends in "Z").
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Parses a UTC ISO 8601 string into a Date.
 *
 * Rejects:
 *   - Strings that do not end in "Z" (local-timezone strings like "+05:30" are
 *     refused — UTC enforcement per SKILL.md line 48).
 *   - Strings that produce an invalid Date (NaN milliseconds).
 *   - Empty strings.
 */
export function parseIso(s: string): Date {
  if (!s || !s.endsWith("Z")) {
    throw new ValidationError(
      `parseIso: string must end with "Z" (UTC required), got: ${JSON.stringify(s)}`
    );
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) {
    throw new ValidationError(
      `parseIso: invalid ISO 8601 date string: ${JSON.stringify(s)}`
    );
  }
  return d;
}
