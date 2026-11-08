import { describe, it, expect } from "vitest";
import { assertSectionPoolsFillable } from "../service/blueprint.js";
import { compilePatternSections } from "../service/compile-test.js";
import { passesSectionTypeAndDifficulty } from "@assessiq/question-types";
import type { ExamBlueprint } from "../../../04-question-bank/src/exam-blueprints.js";

const N = "11111111-1111-4111-8111-111111111111";
const SSC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BANK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
type Fact = { type: string; difficulty_est: number | null; style_node_ids: string[] };
const f = (n: number, style: string[]): Fact[] => Array.from({ length: n }, () => ({ type: "mcq", difficulty_est: 3, style_node_ids: style }));
const POOL = [...f(2, []), ...f(3, [SSC]), ...f(4, [BANK])];
const client = (rows: Fact[]) => ({ query: async () => ({ rows }) }) as never;
const settings = (extra: Record<string, unknown> = {}) => ({ sections: [{ name: "Part A", node_id: N, question_count: 5, ...extra }] });

describe("EXAM-STYLE publish pre-flight", () => {
  it("counts neutral plus own style for a styled section (2 + 3 = 5 passes, 6 needed fails with 5 available)", async () => {
    await expect(assertSectionPoolsFillable(client(POOL), N, N, settings({ style_node_id: SSC }))).resolves.toBeUndefined();
    await expect(assertSectionPoolsFillable(client(POOL), N, N, settings({ style_node_id: SSC, question_count: 6 }))).rejects.toMatchObject({ details: { available: 5, required: 6 } });
  });
  it("counts neutral only for an unstyled section", async () => {
    await expect(assertSectionPoolsFillable(client(POOL), N, N, settings({ question_count: 3 }))).rejects.toMatchObject({ details: { available: 2, required: 3 } });
  });
  it("pre-flight count equals the draw count (same shared filter)", async () => {
    for (const s of [{ style_node_id: SSC }, { style_node_id: BANK }, {}]) {
      const drawn = POOL.filter((q) => passesSectionTypeAndDifficulty(s, q)).length;
      await expect(assertSectionPoolsFillable(client(POOL), N, N, settings({ ...s, question_count: drawn + 1 }))).rejects.toMatchObject({ details: { available: drawn } });
    }
  });
  it("a pattern section with no subject node (NULL) fails publish; a plain section without a node does not", async () => {
    const bad = { sections: [{ name: "Part A", question_count: 2 }], exam_blueprint: { id: "bp1", edition: "2026", verification_status: "verified" } };
    await expect(assertSectionPoolsFillable(client(POOL), N, N, bad)).rejects.toMatchObject({ details: { code: "SECTION_SUBJECT_MISSING", section: "Part A" } });
    await expect(assertSectionPoolsFillable(client(POOL), N, N, { sections: [{ name: "Part A", question_count: 2 }] })).resolves.toBeUndefined();
  });
});

describe("EXAM-STYLE compile", () => {
  const bp = (style: string | null): ExamBlueprint => ({
    id: "bp1", stage_node_id: null, style_node_id: style, edition: "2026", name: "Sample", total_minutes: 60, qualifying: false, verification_status: "verified", source_note: null,
    max_questions: 100, owner_contact: null, archived_at: null, supersedes_id: null, last_checked_at: null, next_check_due: "2026-12-01", total_questions: 5, total_marks: 10,
    sections: [{ position: 1, name: "A", subject_node_id: N, question_count: 5, marks_per_question: 2, negative_marks_per_question: 0, minutes: null, sectional_timing: false, qualifying: false, cutoff_marks: null, calculator_allowed: false, allowed_types: ["mcq"] }],
  });
  it("copies the pattern style into every compiled section; no style adds no key", () => {
    expect(compilePatternSections(bp(SSC)).sections[0]).toMatchObject({ style_node_id: SSC });
    expect(compilePatternSections(bp(null)).sections[0]).not.toHaveProperty("style_node_id");
  });
});
