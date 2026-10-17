// RW-57 part 2: structural checks on the bundled CBSE / ICSE / IB seeds. No DB.
import { describe, it, expect } from "vitest";
import { validateFrameworkSeed, type SeedNode } from "../framework-seeds.js";
import cbse from "../frameworks/cbse.json" with { type: "json" };
import icse from "../frameworks/icse.json" with { type: "json" };
import ib from "../frameworks/ib.json" with { type: "json" };
import examStructure from "../frameworks/exam-structure.json" with { type: "json" };
import subjectMap from "../frameworks/subject-map.json" with { type: "json" };

const count = (n: SeedNode): number => 1 + (n.children ?? []).reduce((a, c) => a + count(c), 0);
const dupes = (n: SeedNode): boolean =>
  new Set((n.children ?? []).map((c) => c.code)).size !== (n.children ?? []).length || (n.children ?? []).some(dupes);

describe.each([["cbse", cbse, "CBSE"], ["icse", icse, "CISCE"], ["ib", ib, "IB"]] as const)("%s seed", (code, raw, board) => {
  const seed = validateFrameworkSeed(raw);
  it("validates and has source URLs", () => {
    expect(seed.code).toBe(code);
    expect(seed.board).toBe(board);
    expect(seed.sourceUrls?.length).toBeGreaterThan(0);
  });
  it("has unique sibling codes at every level", () => {
    expect(new Set(seed.nodes.map((n) => n.code)).size).toBe(seed.nodes.length);
    expect(seed.nodes.some(dupes)).toBe(false);
  });
  it("has nodes under every top-level node", () => {
    for (const n of seed.nodes) expect(count(n)).toBeGreaterThan(1);
  });
});

describe("cbse content", () => {
  const seed = validateFrameworkSeed(cbse);
  it("covers grades 6-12 with the core subjects", () => {
    for (let g = 6; g <= 12; g++) {
      const grade = seed.nodes.find((n) => n.code === `grade-${g}`);
      expect(grade?.kind).toBe("grade");
      const subs = (grade?.children ?? []).map((s) => s.code);
      expect(subs).toContain("mathematics");
      expect(subs).toContain("english");
      expect(subs.includes("science") || subs.includes("physics")).toBe(true);
      for (const s of grade?.children ?? []) expect((s.children ?? []).length).toBeGreaterThan(0);
    }
  });
});

describe("icse and ib content", () => {
  it("icse has ICSE and ISC stages with grades", () => {
    const s = validateFrameworkSeed(icse);
    expect(s.nodes.map((n) => [n.code, n.kind])).toEqual([["icse", "stage"], ["isc", "stage"]]);
    expect(s.nodes.map((n) => (n.children ?? []).length)).toEqual([2, 2]);
  });
  it("ib has PYP, MYP and DP; every MYP subject has criteria A-D", () => {
    const s = validateFrameworkSeed(ib);
    expect(s.nodes.map((n) => n.code)).toEqual(["pyp", "myp", "dp"]);
    const myp = s.nodes.find((n) => n.code === "myp")!;
    expect(myp.children).toHaveLength(8);
    for (const sub of myp.children ?? []) {
      expect((sub.children ?? []).map((c) => [c.code, c.kind])).toEqual(
        ["a", "b", "c", "d"].map((l) => [`criterion-${l}`, "criterion"]),
      );
    }
  });
});

// EXP-1: exam-structure and subject-map platform frameworks. Syllabus is unverified (official sites not opened).
describe("exam-structure and subject-map seeds", () => {
  const exam = validateFrameworkSeed(examStructure);
  const subj = validateFrameworkSeed(subjectMap);
  it("validate, are marked draft-unverified, and have unique codes", () => {
    expect([exam.code, subj.code]).toEqual(["exam-structure", "subject-map"]);
    expect([exam.version, subj.version]).toEqual(["draft-unverified", "draft-unverified"]);
    expect(exam.nodes.some(dupes) || subj.nodes.some(dupes)).toBe(false);
  });
  it("exam-structure has 5 boards and 10 stages", () => {
    expect(exam.nodes.map((n) => n.code)).toEqual(["ssc", "ibps", "rrb", "upsc", "nta"]);
    expect(exam.nodes.reduce((a, b) => a + (b.children ?? []).length, 0)).toBe(10);
  });
  it("subject-map has 4 subjects; only Quant > Arithmetic has outcomes", () => {
    expect(subj.nodes.map((n) => n.code)).toEqual(["quant", "reasoning", "english", "general-awareness"]);
    const withOutcomes = subj.nodes.flatMap((s) => s.children ?? []).filter((u) => (u.children ?? []).length > 0);
    expect(withOutcomes.map((u) => u.code)).toEqual(["arithmetic"]);
    expect(withOutcomes[0]!.children).toHaveLength(8);
  });
});
