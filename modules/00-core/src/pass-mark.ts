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
