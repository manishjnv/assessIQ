/** FU-C17: save path rejects strict-rule violations; old stored rubric still parses. Pure. */
import { describe, it, expect } from "vitest";
import { ValidationError } from "@assessiq/core";
import { assertValidRubric, assertRubricGate } from "../service/_shared.js";
import { validateRubric, QB_ERROR_CODES } from "../types.js";

const bands = { band_4: "a", band_3: "b", band_2: "c", band_1: "d", band_0: "e" };
const dupRubric = {
  anchors: [
    { id: "a1", concept: "x", weight: 30, synonyms: ["x"] },
    { id: "a1", concept: "y", weight: 30, synonyms: ["y"] },
  ],
  reasoning_bands: bands,
  anchor_weight_total: 60,
  reasoning_weight_total: 40,
};

describe("strict rubric rules on save", () => {
  it("rejects duplicate anchor ids with INVALID_RUBRIC", () => {
    let err: unknown;
    try { assertValidRubric(dupRubric); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ValidationError);
    expect(JSON.stringify((err as ValidationError).details)).toContain(QB_ERROR_CODES.INVALID_RUBRIC);
    expect(() => assertRubricGate("subjective", dupRubric, true)).toThrow(ValidationError);
  });
  it("old stored bad rubric still parses leniently", () => {
    expect(validateRubric(dupRubric).ok).toBe(true);
  });
  it("accepts a clean rubric", () => {
    const fixed = { ...dupRubric, anchors: [dupRubric.anchors[0], { ...dupRubric.anchors[1], id: "a2" }] };
    expect(() => assertValidRubric(fixed)).not.toThrow();
  });
});
