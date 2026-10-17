// Shared candidate-facing copy. Wording follows docs/10-branding-guideline.md § 2.5.
export const AFTER_SUBMIT_TEXT =
  "Your answers are saved. You will see your result on this page or by email once it is final.";

// Z-16: a certificate follows every pass; the pass mark is set for each assessment.
export const certificateRuleText = (passMark: number): string =>
  `You earn a certificate every time you pass. The pass mark for this assessment is ${passMark}%.`;
export const CERTIFICATES_EMPTY_TEXT =
  "No certificates yet. Pass an assessment to earn one. The pass mark is set for each assessment.";
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
