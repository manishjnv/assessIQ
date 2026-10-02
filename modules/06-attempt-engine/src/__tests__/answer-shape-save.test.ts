/**
 * Unit tests for the save-time answer shape check (N15).
 * Pure logic — no DB / testcontainer.
 */
import { describe, it, expect } from "vitest";
import { checkAnswerForSave } from "../types.js";

describe("checkAnswerForSave", () => {
  it("accepts the canonical scenario shape and removes unknown keys", () => {
    const r = checkAnswerForSave("scenario", {
      steps: [{ stepIndex: 0, response: "a", extra: 1 }],
      junk: true,
    });
    expect(r).toEqual({ ok: true, answer: { steps: [{ stepIndex: 0, response: "a" }] } });
  });

  it("rejects a wrong scenario shape", () => {
    for (const bad of ["text", 3, [], {}, { steps: "x" }, { steps: [{ stepIndex: -1, response: "a" }] }, { steps: [{ stepIndex: 0 }] }, { response: "a" }]) {
      expect(checkAnswerForSave("scenario", bad)).toEqual({ ok: false });
    }
  });

  it("null means no answer and passes for every type", () => {
    expect(checkAnswerForSave("scenario", null)).toEqual({ ok: true, answer: null });
  });

  it("is keyed on the question type: other types are stored as sent", () => {
    const scenarioShaped = { steps: "not-an-array" };
    for (const t of ["mcq", "subjective", "kql", "log_analysis", "numeric", "multi_select", "ordering", null]) {
      expect(checkAnswerForSave(t, scenarioShaped)).toEqual({ ok: true, answer: scenarioShaped });
    }
  });
});
