import { describe, it, expect } from "vitest";
import { feedbackSentence } from "../feedback-copy.js";

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
