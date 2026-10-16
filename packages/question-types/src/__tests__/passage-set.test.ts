// EX-3 passage sets: literal expected outputs (no computed expectations).
import { describe, expect, it } from "vitest";
import { QUESTION_TYPE_REGISTRY, StructuredCaseContentSchema, deterministicMarks, structuredCaseMarks } from "../index.js";

const steps = [
  { id: "a", prompt: "p1", select: "one", options: ["x", "y", "z"], correct: [1], points: 2 },
  { id: "b", prompt: "p2", select: "one", options: ["x", "y"], correct: [0] },
  { id: "c", prompt: "p3", select: "many", options: ["x", "y", "z"], correct: [0, 2], negative_marks: 0.5 },
];
const PASSAGE = { title: "Passage", context: "Read this.", steps, scoring: "partial" };
const PASSAGE_AON = { ...PASSAGE, scoring: "all_or_nothing" };
const ctx = { points: 4, negativeMarks: 1 };
const marks = (c: unknown, s: Record<string, number[]>) => deterministicMarks("structured_case", c, { steps: s }, ctx);

describe("structured_case passage set marks (weights 2/1/1, c.negative_marks 0.5, W=4, points 4, penalty 1)", () => {
  it("schema accepts the weights", () => {
    expect(StructuredCaseContentSchema.safeParse(PASSAGE).success).toBe(true);
    expect(StructuredCaseContentSchema.safeParse({ ...PASSAGE, steps: [{ ...steps[0], points: 0 }] }).success).toBe(false);
  });
  it("all correct", () => expect(marks(PASSAGE, { a: [1], b: [0], c: [0, 2] })).toEqual({ earned: 4, max: 4, status: "correct" }));
  it("b wrong: -1x1/4", () => expect(marks(PASSAGE, { a: [1], b: [1], c: [0, 2] })).toEqual({ earned: 2.75, max: 4, status: "partial" }));
  it("a wrong: -1x2/4", () => expect(marks(PASSAGE, { a: [0], b: [0], c: [0, 2] })).toEqual({ earned: 1.5, max: 4, status: "partial" }));
  it("c wrong: explicit -0.5", () => expect(marks(PASSAGE, { a: [1], b: [0], c: [1] })).toEqual({ earned: 2.5, max: 4, status: "partial" }));
  it("c partly right: no penalty", () => expect(marks(PASSAGE, { a: [1], b: [0], c: [0] })).toEqual({ earned: 3.5, max: 4, status: "partial" }));
  it("blank", () => {
    expect(marks(PASSAGE, {})).toEqual({ earned: 0, max: 4, status: "incorrect" });
    expect(marks(PASSAGE, { a: [] })).toEqual({ earned: 0, max: 4, status: "incorrect" });
  });
  it("all wrong", () => expect(marks(PASSAGE, { a: [0], b: [1], c: [1] })).toEqual({ earned: -1.25, max: 4, status: "incorrect" }));
  it("unknown step id is malformed", () => expect(marks(PASSAGE, { zz: [0] })).toEqual({ earned: 0, max: 4, status: "incorrect" }));
  it("all_or_nothing", () => {
    expect(marks(PASSAGE_AON, { a: [1], b: [0], c: [0, 2] })).toEqual({ earned: 4, max: 4, status: "correct" });
    expect(marks(PASSAGE_AON, { a: [1], b: [1], c: [0, 2] })).toEqual({ earned: -1, max: 4, status: "incorrect" });
    expect(marks(PASSAGE_AON, { a: [1], b: [0], c: [0] })).toEqual({ earned: -1, max: 4, status: "incorrect" });
    expect(marks(PASSAGE_AON, {})).toEqual({ earned: 0, max: 4, status: "incorrect" });
  });
  it("candidateView exposes weights, never the key", () => {
    const v = QUESTION_TYPE_REGISTRY.structured_case.candidateView(PASSAGE) as { steps: unknown[] };
    expect(v.steps).toEqual([
      { id: "a", prompt: "p1", select: "one", options: ["x", "y", "z"], points: 2 },
      { id: "b", prompt: "p2", select: "one", options: ["x", "y"] },
      { id: "c", prompt: "p3", select: "many", options: ["x", "y", "z"], negative_marks: 0.5 },
    ]);
  });
  it("no weights: default weight 1, default penalty 1x1/4 (S 0.75 of W 2 -> 1.5)", () => {
    const c = { title: "t", context: "c", steps: [steps[1], { ...steps[1], id: "d" }] };
    expect(marks(c, { b: [0], d: [1] })).toEqual({ earned: 1.5, max: 4, status: "partial" });
  });
});

describe("structuredCaseMarks junk", () => {
  it("never throws", () => {
    const junk = [null, undefined, 5, "x", [], {}, { steps: 1 }, { steps: { a: "x" } }];
    for (const c of junk) for (const a of junk) expect(() => structuredCaseMarks(c, a, ctx)).not.toThrow();
  });
  it("registry dispatch equals the hook", () => {
    const a = { steps: { a: [1], b: [1], c: [0, 2] } };
    expect(deterministicMarks("structured_case", PASSAGE, a, ctx)).toEqual(QUESTION_TYPE_REGISTRY.structured_case.deterministicMarks!(PASSAGE, a, ctx));
    expect(Object.values(QUESTION_TYPE_REGISTRY).filter((d) => d.deterministicMarks).map((d) => d.id)).toEqual(["structured_case"]);
  });
});
