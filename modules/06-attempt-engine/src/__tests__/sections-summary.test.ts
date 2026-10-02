import { describe, it, expect } from "vitest";
import { buildSectionsSummary } from "../sections.js";

const sections = [
  { name: "Quant", question_count: 2, minutes: 10 },
  { name: "Verbal", question_count: 2, minutes: 10 },
  { name: "Logic", question_count: 1, minutes: 5 },
];
const questions = [
  { question_id: "q1", section_index: 0 },
  { question_id: "q2", section_index: 0 },
  { question_id: "q3", section_index: 1 },
  { question_id: "q4", section_index: 1 },
  { question_id: "q5", section_index: 2 },
];
const answers = [
  { question_id: "q1", answer: { selected: 1 } },
  { question_id: "q2", answer: { selected: null } }, // empty
  { question_id: "q3", answer: "x" },
  { question_id: "q4", answer: [] }, // empty
  { question_id: "q5", answer: 0 }, // 0 is an answer
];

describe("buildSectionsSummary", () => {
  it("counts per section and marks done / current / upcoming", () => {
    expect(buildSectionsSummary(sections, 1, questions, answers)).toEqual([
      { index: 0, name: "Quant", question_count: 2, answered_count: 1, status: "done" },
      { index: 1, name: "Verbal", question_count: 2, answered_count: 1, status: "current" },
      { index: 2, name: "Logic", question_count: 1, answered_count: 1, status: "upcoming" },
    ]);
  });

  it("exposes counts only: no question ids or content", () => {
    const json = JSON.stringify(buildSectionsSummary(sections, 0, questions, answers));
    expect(json).not.toMatch(/q[1-5]/);
    for (const item of buildSectionsSummary(sections, 0, questions, answers)) {
      expect(Object.keys(item).sort()).toEqual(["answered_count", "index", "name", "question_count", "status"]);
    }
  });
});
