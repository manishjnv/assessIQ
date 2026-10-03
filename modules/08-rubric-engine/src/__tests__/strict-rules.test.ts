// FU-C17 strict rubric rules (save-time only). Pure unit tests.
import { describe, it, expect } from "vitest";
import { strictRubricIssues, parseRubric, type Rubric } from "../index.js";

const bands = { band_4: "a", band_3: "b", band_2: "c", band_1: "d", band_0: "e" };
const base = (): Rubric => ({
  anchors: [
    { id: "a1", concept: "x", weight: 30, synonyms: ["x"] },
    { id: "a2", concept: "y", weight: 30, synonyms: ["y"] },
  ],
  reasoning_bands: { ...bands },
  anchor_weight_total: 60,
  reasoning_weight_total: 40,
});

describe("strictRubricIssues (FU-C17)", () => {
  it("clean rubric has no issues", () => {
    expect(strictRubricIssues(base())).toEqual([]);
  });
  it("(a) flags anchor weights not summing to anchor_weight_total", () => {
    const r = base();
    r.anchors[1]!.weight = 20;
    expect(strictRubricIssues(r)).toEqual([expect.stringMatching(/weights sum to 50/)]);
  });
  it("(b) flags duplicate anchor ids", () => {
    const r = base();
    r.anchors[1]!.id = "a1";
    expect(strictRubricIssues(r)).toEqual([expect.stringMatching(/duplicate anchor ids: a1/)]);
  });
  it("(c) flags empty / whitespace band text", () => {
    const r = base();
    r.reasoning_bands.band_2 = "   ";
    expect(strictRubricIssues(r)).toEqual([expect.stringMatching(/band_2/)]);
  });
  it("parseRubric stays lenient for the same bad rubrics", () => {
    const r = base();
    r.anchors[1]!.id = "a1";
    r.reasoning_bands.band_0 = "";
    expect(parseRubric(r).ok).toBe(true);
  });
});
