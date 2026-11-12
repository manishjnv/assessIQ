/** EXP-9 A3: optional Hindi import columns write content.i18n.hi for mcq rows. Fake fixtures, no database. */
import { describe, it, expect } from "vitest";
import { McqContentSchema } from "@assessiq/question-types";
import { validateRow } from "../import/staging.js";
import { templateRows } from "../import/templates.js";
import { normalisedText, normalisedTextHash } from "../import/v2.js";

const base = { type: "mcq", topic: "t", points: "1", level: "1", question: "Q one?", options: '["a","b","c","d"]', correct: "2", rationale: "r" };
const hi = { question_hi: "नमूना प्रश्न 1", options_hi: '["क","ख","ग","घ"]', rationale_hi: "नमूना व्याख्या" };

describe("import Hindi columns", () => {
  it("writes i18n.hi with options in order and leaves correct alone", () => {
    const r = validateRow(2, { ...base, ...hi });
    expect(r.errors).toEqual([]);
    expect(r.normalized?.content["i18n"]).toEqual({ hi: { question: "नमूना प्रश्न 1", options: ["क", "ख", "ग", "घ"], rationale: "नमूना व्याख्या" } });
    expect(r.normalized?.content["correct"]).toBe(2);
    expect(McqContentSchema.safeParse(r.normalized?.content).success).toBe(true);
  });
  it("rationale_hi is optional", () => {
    const r = validateRow(2, { ...base, ...hi, rationale_hi: "" });
    expect(r.errors).toEqual([]);
    expect(r.normalized?.content["i18n"]).toEqual({ hi: { question: "नमूना प्रश्न 1", options: ["क", "ख", "ग", "घ"] } });
  });
  it("count mismatch is a row error on options_hi", () => {
    const r = validateRow(2, { ...base, ...hi, options_hi: '["क","ख","ग"]' });
    expect(r.normalized).toBeNull();
    expect(r.errors[0]).toMatchObject({ row: 2, column: "options_hi", message: "Hindi options must match the English options: 4 English, 3 Hindi" });
  });
  it("question_hi missing while options_hi is filled is a row error", () => {
    const r = validateRow(2, { ...base, options_hi: hi.options_hi });
    expect(r.errors).toEqual([expect.objectContaining({ column: "question_hi" })]);
  });
  it("question_hi alone (no options_hi) is a row error", () => {
    expect(validateRow(2, { ...base, question_hi: "प्र" }).errors[0]).toMatchObject({ column: "options_hi" });
  });
  it("a non-mcq row with Hindi is a row error", () => {
    const r = validateRow(2, { type: "subjective", topic: "t", question: "Explain.", rubric: "[]", ...hi });
    expect(r.errors).toContainEqual({ row: 2, column: "question_hi", message: "Hindi columns are supported for mcq rows only" });
  });
  it("no Hindi cells: no i18n key, same as before", () => {
    const r = validateRow(2, base);
    expect(r.errors).toEqual([]);
    expect("i18n" in r.normalized!.content).toBe(false);
  });
  it("the mcq template carries the Hindi columns last; other types do not", () => {
    expect(templateRows("mcq").header.slice(-3)).toEqual(["question_hi", "options_hi", "rationale_hi"]);
    expect(templateRows("mcq").example.length).toBe(templateRows("mcq").header.length);
    expect(templateRows("subjective").header).not.toContain("question_hi");
  });
  it("the duplicate hash ignores the Hindi overlay (a re-import with Hindi added is still a duplicate)", () => {
    const en = { question: "Q one?", options: ["a", "b", "c", "d"], correct: 2, rationale: "r" };
    const withHi = { ...en, i18n: { hi: { question: "नमूना प्रश्न 1", options: ["क", "ख", "ग", "घ"], rationale: "नमूना व्याख्या" } } };
    expect(normalisedText(en)).toBe(["a", "b", "c", "d", "q one?"].join(String.fromCharCode(10))); // pinned: rows without Hindi hash as before
    expect(normalisedText(withHi)).toBe(normalisedText(en));
    expect(normalisedTextHash(withHi)).toBe(normalisedTextHash(en));
  });
  it("math=true checks the Hindi text too: bad TeX and a denied command are row errors", () => {
    const ok = validateRow(2, { ...base, ...hi, math: "true", question_hi: "नमूना \\(x^2\\) प्रश्न" });
    expect(ok.errors).toEqual([]);
    for (const bad of ["नमूना \\(\\frac{1}\\) प्रश्न", "नमूना \\(\\href{http://x.test}{y}\\) प्रश्न"]) {
      const r = validateRow(2, { ...base, ...hi, math: "true", question_hi: bad });
      expect(r.errors.map((e) => e.column)).toContain("math");
      expect(r.errors.some((e) => e.message.startsWith("i18n.hi.question"))).toBe(true);
    }
  });
});
