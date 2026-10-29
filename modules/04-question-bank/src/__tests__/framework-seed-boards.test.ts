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
  it("exam-structure has 7 boards and 15 stages (EXP-25a: campus stage 0, SBI, RRB Group D, NDA)", () => {
    expect(exam.nodes.map((n) => n.code)).toEqual(["ssc", "ibps", "rrb", "upsc", "nta", "campus", "sbi"]);
    expect(exam.nodes.reduce((a, b) => a + (b.children ?? []).length, 0)).toBe(15);
  });
  it("subject-map has 5 subjects and every part A outcome still exists under the same parent", () => {
    expect(subj.nodes.map((n) => n.code)).toEqual(["quant", "reasoning", "english", "general-awareness", "technical-aptitude"]);
    // The 17 outcomes of part A (they include the 15 pilot template outcomes). Never rename, move or delete.
    const PILOT: Record<string, string[]> = {
      "quant/arithmetic": ["percentage", "profit-and-loss", "ratio", "time-and-work", "time-speed-distance", "simple-and-compound-interest", "average", "mixture"],
      "quant/algebra": ["linear-equations"],
      "quant/number-system": ["divisibility-and-remainders"],
      "quant/progressions": ["arithmetic-progression", "geometric-progression"],
      "reasoning/puzzles-and-series": ["number-series", "coding-decoding", "blood-relations", "direction-sense", "ranking-and-order"],
    };
    for (const [path, codes] of Object.entries(PILOT)) {
      const [s, u] = path.split("/");
      const unit = subj.nodes.find((n) => n.code === s)!.children!.find((c) => c.code === u)!;
      const have = (unit.children ?? []).map((o) => o.code);
      for (const c of codes) expect(have, `${path} keeps ${c}`).toContain(c);
    }
    const units = subj.nodes.flatMap((s) => s.children ?? []);
    for (const c of ["clocks", "calendars", "critical-reasoning", "progressions"]) expect(units.some((u) => u.code === c)).toBe(true);
  });
  it("EXP-25 b: every unit of Quant, Reasoning and English has an outcome; codes are kebab-case; GA and Technical stay open", () => {
    const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    const APT = subj.nodes.filter((n) => ["quant", "reasoning", "english"].includes(n.code));
    const aptUnits = APT.flatMap((s) => s.children ?? []);
    expect(aptUnits).toHaveLength(30); // 18 from part A plus 12 new units (see docs/02-data-model.md, EXP-25 part b)
    for (const u of aptUnits) {
      expect((u.children ?? []).length, `${u.code} has outcomes`).toBeGreaterThan(0);
      expect(KEBAB.test(u.code)).toBe(true);
      expect(u.children!.every((o) => o.kind === "outcome" && KEBAB.test(o.code))).toBe(true);
    }
    expect(aptUnits.flatMap((u) => u.children ?? [])).toHaveLength(125);
    // Owner 2026-10-29: General awareness and Technical aptitude stay without outcomes.
    for (const s of subj.nodes.filter((n) => ["general-awareness", "technical-aptitude"].includes(n.code))) {
      expect((s.children ?? []).flatMap((u) => u.children ?? [])).toHaveLength(0);
    }
  });
});
