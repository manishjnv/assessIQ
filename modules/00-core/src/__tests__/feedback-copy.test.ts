import { describe, it, expect } from "vitest";
import { effectiveLevel, feedbackSentence } from "../feedback-copy.js";

describe("feedbackSentence (Z-44)", () => {
  it("returns a distinct sentence for each level and null for none or unknown", () => {
    const s = (["right_wrong", "with_expected_answer", "with_ai_justification"] as const).map(feedbackSentence);
    expect(s.every((x) => typeof x === "string" && x !== "")).toBe(true);
    expect(new Set(s).size).toBe(3);
    expect(feedbackSentence("none")).toBeNull();
    expect(feedbackSentence("bogus")).toBeNull();
    expect(feedbackSentence(undefined)).toBeNull();
  });
});

describe("effectiveLevel (Z-145, Z-148)", () => {
  const levels = ["none", "right_wrong", "with_expected_answer", "with_ai_justification"] as const;
  it("a Mock attempt that is not embed gets the assessment level", () => {
    for (const l of levels) expect(effectiveLevel(l, { isMockAttempt: true, isEmbed: false, orgKeyOn: true })).toBe(l);
  });
  it("a Real attempt gets none at every level", () => {
    for (const l of levels) {
      expect(effectiveLevel(l, { isMockAttempt: false, isEmbed: false, orgKeyOn: true })).toBe("none");
      expect(effectiveLevel(l, { isMockAttempt: false, isEmbed: true, orgKeyOn: true })).toBe("none");
    }
  });
  it("an embed attempt gets none even when Mock", () => {
    for (const l of levels) expect(effectiveLevel(l, { isMockAttempt: true, isEmbed: true, orgKeyOn: true })).toBe("none");
  });
  it("Z-172: the organisation switch off gives none at every level, even for Mock", () => {
    for (const l of levels) expect(effectiveLevel(l, { isMockAttempt: true, isEmbed: false, orgKeyOn: false })).toBe("none");
  });
});
