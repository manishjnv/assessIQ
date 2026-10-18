// Shared candidate-facing copy. Wording follows docs/10-branding-guideline.md § 2.5.
export const AFTER_SUBMIT_TEXT =
  "Your answers are saved. You will see your result on this page or by email once it is final.";

// Z-16: a certificate follows every pass; the pass mark is set for each assessment.
export const certificateRuleText = (passMark: number): string =>
  `You earn a certificate every time you pass. The pass mark for this assessment is ${passMark}%.`;
export const CERTIFICATES_EMPTY_TEXT =
  "No certificates yet. Pass an assessment to earn one. The pass mark is set for each assessment.";
/**
 * Z-39: the real retake rule on a not-passed result. Without server data (older server) the
 * old line stays. Attempts left but no button (test closed, or an older attempt): ask the organisation.
 */
export const retakeLine = (
  retake: { attempt_number: number; attempts_allowed: number; can_retake: boolean } | undefined,
  org: string,
): string => {
  const ask = `Ask ${org} if you can try again.`;
  if (retake === undefined) return ask;
  const { attempt_number: n, attempts_allowed: m } = retake;
  if (retake.can_retake) return `You can try again. This was attempt ${n} of ${m}.`;
  if (n < m) return ask;
  return m <= 1
    ? `This test allows one attempt. Ask ${org} if you need another.`
    : `You used all ${m} attempts. Ask ${org} if you need another.`;
};
/** Result support line (owner decision 2026-10-17). `passMark` undefined: the number is hidden. */
export const resultSupportLine = (
  passed: boolean,
  earned: string,
  max: string,
  passMark?: number,
): string => {
  const score = `Your score is ${earned} out of ${max}.`;
  if (passMark === undefined) return score;
  return passed
    ? `${score} You met the pass mark of ${passMark}%.`
    : `${score} You need ${passMark}% to pass.`;
};
