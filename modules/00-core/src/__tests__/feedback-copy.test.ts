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

describe("effectiveLevel (Z-111)", () => {
  const mock = { isMockAttempt: true, assessmentIsMock: true };
  it("mock attempt on a mock assessment shows the expected answer even when the tenant level is none", () => {
    expect(effectiveLevel("none", mock)).toBe("with_expected_answer");
  });
  it("real attempt follows the tenant level", () => {
    expect(effectiveLevel("none", { isMockAttempt: false, assessmentIsMock: true })).toBe("none");
    expect(effectiveLevel("right_wrong", { isMockAttempt: false, assessmentIsMock: false })).toBe("right_wrong");
  });
  it("mock attempt on a non-mock assessment follows the tenant level", () => {
    expect(effectiveLevel("none", { isMockAttempt: true, assessmentIsMock: false })).toBe("none");
  });
  it("a tenant level already higher than expected answer stays higher", () => {
    expect(effectiveLevel("with_ai_justification", mock)).toBe("with_ai_justification");
    expect(effectiveLevel("with_expected_answer", mock)).toBe("with_expected_answer");
  });
});
