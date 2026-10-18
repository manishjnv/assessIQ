// Z-16: the ONE pass/fail rule. Integer math in hundredths, so a score such as
// 59.99% never rounds up to a 60% pass mark. Used by 06 (result/progress) and
// 18 (certificate issue). Do not re-implement `earned / max >= x` elsewhere.

/** Owner decision (Z-16): a score of 90% or more earns the Distinction tier. */
export const DISTINCTION_PCT = 90;

const hundredths = (v: number | string): number => Math.round(Number(v) * 100);

/** True when earned/max reaches `pct` percent. False when max <= 0 or an input is not finite. */
export function meetsPct(earned: number | string, max: number | string, pct: number): boolean {
  const e = hundredths(earned);
  const m = hundredths(max);
  if (!Number.isFinite(e) || !Number.isFinite(m) || m <= 0) return false;
  // A threshold outside 1..100 (or not whole) is a caller bug: never pass on it.
  if (!Number.isInteger(pct) || pct < 1 || pct > 100) return false;
  return e * 100 >= pct * m;
}

/** Pass rule: score reaches the assessment's pass mark (1..100). */
export const isPass = meetsPct;

// Z-39: the ONE retake limit rule. max_attempts null or 1 means a single attempt
// (no retake); extraAttempts is what an admin granted to one candidate on top.
// Used by 05 (re-open invitation) and 06 (start attempt, preview, result).

/** Owner limit (Z-39): an assessment allows at most 10 attempts. */
export const MAX_ATTEMPTS_LIMIT = 10;

/** Total attempts one candidate may make: max(1, maxAttempts) + extraAttempts. */
export function attemptsAllowed(maxAttempts: number | null | undefined, extraAttempts = 0): number {
  const base =
    maxAttempts === null || maxAttempts === undefined || !Number.isInteger(maxAttempts)
      ? 1
      : Math.min(MAX_ATTEMPTS_LIMIT, Math.max(1, maxAttempts));
  return base + (Number.isFinite(extraAttempts) ? Math.max(0, Math.trunc(extraAttempts)) : 0);
}
