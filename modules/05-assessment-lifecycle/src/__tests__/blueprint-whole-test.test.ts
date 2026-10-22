// Z-51 (option b): whole_test_minutes and marks_per_question live inside settings.blueprint.
// Happy path: both fields parse and are kept. Failure: out-of-range or non-integer values are
// rejected, and a blueprint combined with settings.sections is rejected.
import { describe, it, expect } from "vitest";
import { AssessmentBlueprintSchema } from "../types.js";
import { assertSectionsSettings } from "../service.js";

const DOMAIN = "0a1b2c3d-0000-4000-8000-000000000001";
const CAT = "0a1b2c3d-0000-4000-8000-000000000002";
const base = {
  domain_id: DOMAIN,
  level: "L1",
  criteria: [{ category_id: CAT, type: "mcq", count: 10 }],
};

describe("blueprint whole-test fields (Z-51)", () => {
  it("accepts whole_test_minutes and marks_per_question and keeps them", () => {
    const r = AssessmentBlueprintSchema.safeParse({ ...base, whole_test_minutes: 60, marks_per_question: 2 });
    expect(r.success).toBe(true);
    expect(r.success && r.data.whole_test_minutes).toBe(60);
    expect(r.success && r.data.marks_per_question).toBe(2);
    expect(() => assertSectionsSettings({ blueprint: { ...base, whole_test_minutes: 60 } } as never)).not.toThrow();
  });

  it.each([
    ["whole_test_minutes 0", { whole_test_minutes: 0 }],
    ["whole_test_minutes 601", { whole_test_minutes: 601 }],
    ["whole_test_minutes 1.5", { whole_test_minutes: 1.5 }],
    ["whole_test_minutes as text", { whole_test_minutes: "60" }],
    ["marks_per_question negative", { marks_per_question: -1 }],
    ["marks_per_question 0", { marks_per_question: 0 }],
    ["marks_per_question 2.5", { marks_per_question: 2.5 }],
    ["marks_per_question 1001", { marks_per_question: 1001 }],
  ])("rejects %s", (_n, extra) => {
    expect(AssessmentBlueprintSchema.safeParse({ ...base, ...extra }).success).toBe(false);
  });

  it("rejects settings.sections combined with settings.blueprint", () => {
    const sections = [{ name: "Quant", question_count: 10, minutes: 20 }];
    expect(() => assertSectionsSettings({ sections, blueprint: base } as never)).toThrow(
      /cannot be combined with settings\.blueprint/,
    );
  });
});
