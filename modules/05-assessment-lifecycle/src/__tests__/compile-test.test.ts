import { describe, it, expect } from "vitest";
import { compileTestSpec, compilePatternSections } from "../service/compile-test.js";
import type { ExamBlueprint } from "../../../04-question-bank/src/exam-blueprints.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const sec = (name: string, n: number, minutes: number | null = null) => ({
  position: 1, name, subject_node_id: A, question_count: n, marks_per_question: 2, negative_marks_per_question: 0.5, minutes,
  sectional_timing: minutes !== null, qualifying: false, cutoff_marks: null, calculator_allowed: false, allowed_types: ["mcq"],
});
const bp = (over: Partial<ExamBlueprint> = {}): ExamBlueprint => ({
  id: "bp1", stage_node_id: null, edition: "2026", name: "Sample", total_minutes: 60, qualifying: false, verification_status: "verified", source_note: null,
  max_questions: 100, owner_contact: null, archived_at: null, supersedes_id: null, last_checked_at: null, next_check_due: "2026-12-01",
  total_questions: 50, total_marks: 100, sections: [sec("Part A", 30), sec("Part B", 20)], ...over,
});

describe("CT-2 compileTestSpec", () => {
  it("whole set: the count and time limit, no sections, a default name", () => {
    const c = compileTestSpec({ cover: { kind: "whole", question_count: 60 }, minutes: 75, today: "2026-10-26" });
    expect(c).toMatchObject({ name: "Test 2026-10-26", question_count: 60, duration_minutes: 75, settings: {}, warnings: [] });
    expect(() => compileTestSpec({ cover: { kind: "whole", question_count: 101 } })).toThrow();
    expect(() => compileTestSpec({ cover: { kind: "whole", question_count: 0 } })).toThrow();
  });

  it("topics: uneven counts become sections with real names, one timer, drill flag; the time can be set", () => {
    const names = new Map([[A, "Percentages"]]);
    const c = compileTestSpec({ cover: { kind: "topics", topics: [{ node_id: A, count: 12 }, { node_id: B, count: 3 }] }, topicNames: names, difficulty_min: 2 });
    expect(c.question_count).toBe(15);
    expect(c.settings.sections?.map((s) => [s.name, s.question_count, s.difficulty_min])).toEqual([["Percentages", 12, 2], ["Topic 2", 3, 2]]);
    expect(c.settings).toMatchObject({ whole_test_minutes: 23, drill: true });
    expect(compileTestSpec({ cover: { kind: "topics", topics: [{ node_id: A, count: 4 }] }, minutes: 10 }).settings.whole_test_minutes).toBe(10);
  });

  it("pattern: one timer for a free-movement pattern, per-section minutes for a sectional one, a warning when unverified", () => {
    const free = compileTestSpec({ cover: { kind: "pattern", blueprint_id: "bp1" }, blueprint: bp({ verification_status: "unverified" }) });
    expect(free.settings.whole_test_minutes).toBe(60);
    expect(free.warnings).toEqual(["This blueprint is not verified."]);
    expect(free.name).toBe("Sample full mock");
    const sectional = compileTestSpec({ cover: { kind: "pattern", blueprint_id: "bp1" }, blueprint: bp({ sections: [sec("Part A", 30, 40), sec("Part B", 20, 20)] }) });
    expect(sectional.settings.whole_test_minutes).toBeUndefined();
    expect(sectional.settings.sections?.map((s) => s.minutes)).toEqual([40, 20]);
  });

  it("pattern: a short mock scales counts, keeps marks, drops cut-offs; bad positions or percent are refused; an archived pattern is refused", () => {
    const p = compilePatternSections(bp(), { section_positions: [1], scale_percent: 50 });
    expect(p.sections.map((s) => [s.name, s.question_count, s.marks_per_question])).toEqual([["Part B", 10, 2]]);
    expect(p.isShort).toBe(true);
    expect(() => compilePatternSections(bp(), { section_positions: [5] })).toThrow();
    expect(() => compilePatternSections(bp(), { scale_percent: 0 })).toThrow();
    expect(() => compileTestSpec({ cover: { kind: "pattern", blueprint_id: "bp1" }, blueprint: bp({ archived_at: "2026-10-01T00:00:00Z" }) })).toThrow(/archived/);
    expect(() => compileTestSpec({ cover: { kind: "pattern", blueprint_id: "bp1" } })).toThrow();
  });
});
