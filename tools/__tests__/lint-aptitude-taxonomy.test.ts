// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  checkCoverage, checkExamStyleSeed, checkFamilyClasses, checkStageSubjects, checkUnreferencedSubjects, parseCsv,
} from "../lint-aptitude-taxonomy.js";

describe("checkFamilyClasses (i)", () => {
  const head = "category,subtopic,family,method,class,style_or_owner\n";
  it("passes a row with class and a closed-enum style, quoted multi-style included", () => {
    expect(checkFamilyClasses(head + 'Quant,SI,BODMAS,C,style,"bank,ssc"\nQuant,SI,Ratio,C,common,neutral\n')).toEqual([]);
  });
  it("fails a row with no class, no style or a style outside the enum", () => {
    const v = checkFamilyClasses(head + "Quant,SI,BODMAS,C,,neutral\nQuant,SI,Ratio,C,common,\nQuant,SI,Ring,C,common,rrb2\n");
    expect(v).toHaveLength(3);
    expect(v[0]).toMatch(/class is empty/);
    expect(v[1]).toMatch(/style is empty/);
    expect(v[2]).toMatch(/'rrb2' is not in the closed enum/);
  });
});

describe("parseCsv", () => {
  it("keeps commas inside quotes and doubled quotes", () => {
    expect(parseCsv('a,"b,c","d ""e"""\r\n1,2,3\r\n')).toEqual([["a", "b,c", 'd "e"'], ["1", "2", "3"]]);
  });
});

describe("checkExamStyleSeed (ii)", () => {
  it("accepts exactly the closed enum in any order", () => {
    expect(checkExamStyleSeed({ nodes: ["campus", "neutral", "bank", "rrb", "ssc"].map((code) => ({ code })) })).toEqual([]);
  });
  it("rejects an extra or missing style", () => {
    expect(checkExamStyleSeed({ nodes: ["neutral", "ssc", "bank", "rrb", "campus", "sbi"].map((code) => ({ code })) })).toHaveLength(1);
    expect(checkExamStyleSeed({ nodes: ["neutral", "ssc"].map((code) => ({ code })) })).toHaveLength(1);
  });
});

describe("checkStageSubjects (iii)", () => {
  it("allows quant, reasoning and english on stage 0 only", () => {
    expect(checkStageSubjects([{ stage: "campus-aptitude-stage-0", sections: [{ subject: "quant" }, { subject: "english" }] }])).toEqual([]);
    const v = checkStageSubjects([{ stage: "campus-aptitude-stage-0", sections: [{ subject: "computer-aptitude" }] }]);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/computer-aptitude/);
    expect(checkStageSubjects([{ stage: "other-stage", sections: [{ subject: "computer-aptitude" }] }])).toEqual([]);
  });
});

describe("checkCoverage (iv)", () => {
  it("fails below 1x, warns below 3x, passes at 3x or more", () => {
    const draws = [{ section: "A", difficulty: 1, questionCount: 10 }];
    expect(checkCoverage(draws, { 1: 9 }).errors).toHaveLength(1);
    expect(checkCoverage(draws, { 1: 10 })).toEqual({ errors: [], warnings: [expect.stringMatching(/below 3x/)] });
    expect(checkCoverage(draws, { 1: 30 })).toEqual({ errors: [], warnings: [] });
  });
  it("sums draws of one difficulty across sections", () => {
    const draws = [
      { section: "A", difficulty: 3, questionCount: 10 },
      { section: "B", difficulty: 3, questionCount: 10 },
    ];
    expect(checkCoverage(draws, { 3: 15 }).errors).toHaveLength(1);
  });
});

describe("checkUnreferencedSubjects (v)", () => {
  it("names each subject no blueprint uses", () => {
    const v = checkUnreferencedSubjects(["quant", "english", "programming-logic"], [{ stage: "s", sections: [{ subject: "quant" }] }]);
    expect(v).toEqual(["subject 'english' is not referenced by any blueprint", "subject 'programming-logic' is not referenced by any blueprint"]);
  });
});
