import { describe, it, expect } from "vitest";
import { assertQuestionLimit } from "../service/assessments.js";

describe("owner rule 2026-10-25: at most 100 questions per assessment", () => {
  it("accepts exactly 100 in every shape", () => {
    expect(() => assertQuestionLimit(100, undefined)).not.toThrow();
    expect(() => assertQuestionLimit(undefined, { sections: [{ name: "A", question_count: 60, minutes: 5 }, { name: "B", question_count: 40, minutes: 5 }] } as never)).not.toThrow();
    expect(() => assertQuestionLimit(undefined, { blueprint: { criteria: [{ count: 100 }] } } as never)).not.toThrow();
  });
  it("rejects 101 by count, by section sum and by blueprint sum", () => {
    for (const bad of [
      () => assertQuestionLimit(101, undefined),
      () => assertQuestionLimit(undefined, { sections: [{ question_count: 60 }, { question_count: 41 }] } as never),
      () => assertQuestionLimit(undefined, { blueprint: { criteria: [{ count: 50 }, { count: 51 }] } } as never),
    ]) {
      expect(bad).toThrow(/at most 100/);
    }
  });
});
