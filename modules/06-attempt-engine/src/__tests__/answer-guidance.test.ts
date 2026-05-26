/**
 * Unit tests for the candidate answer-format hint resolver (feature #4).
 * Pure logic — no DB / testcontainer.
 */
import { describe, it, expect } from "vitest";
import {
  answerGuidanceFor,
  ANSWER_GUIDANCE_DEFAULTS,
  ANSWER_GUIDANCE_FALLBACK,
} from "../answer-guidance.js";

describe("answerGuidanceFor", () => {
  it("returns the authored value when present", () => {
    expect(answerGuidanceFor("subjective", "Answer in exactly one word.")).toBe(
      "Answer in exactly one word.",
    );
  });

  it("falls back to the per-type default when null", () => {
    expect(answerGuidanceFor("mcq", null)).toBe(ANSWER_GUIDANCE_DEFAULTS.mcq);
    expect(answerGuidanceFor("scenario", null)).toBe(ANSWER_GUIDANCE_DEFAULTS.scenario);
  });

  it("falls back to the per-type default when blank/whitespace", () => {
    expect(answerGuidanceFor("kql", "")).toBe(ANSWER_GUIDANCE_DEFAULTS.kql);
    expect(answerGuidanceFor("kql", "   ")).toBe(ANSWER_GUIDANCE_DEFAULTS.kql);
  });

  it("uses the generic fallback for an unknown type with no authored value", () => {
    expect(answerGuidanceFor("unknown_type", null)).toBe(ANSWER_GUIDANCE_FALLBACK);
  });

  it("has a default for every shipped question type", () => {
    for (const t of ["mcq", "kql", "subjective", "log_analysis", "scenario"]) {
      expect(typeof ANSWER_GUIDANCE_DEFAULTS[t]).toBe("string");
      expect(ANSWER_GUIDANCE_DEFAULTS[t]!.length).toBeGreaterThan(0);
    }
  });

  it("never returns an empty string", () => {
    for (const t of ["mcq", "kql", "subjective", "log_analysis", "scenario", "weird"]) {
      expect(answerGuidanceFor(t, null).length).toBeGreaterThan(0);
      expect(answerGuidanceFor(t, undefined).length).toBeGreaterThan(0);
    }
  });
});
