/** Import `math` column: true rows pass KaTeX, bad TeX and unmarked TeX fail with a clear row error. No database. */
import { describe, it, expect } from "vitest";
import { validateRow } from "../import/staging.js";
import { V2_COLUMNS } from "../import/v2.js";

const base = { type: "mcq", topic: "t", points: "1", level: "1", question: "Find \\(x\\) if \\(2x = 6\\).", options: '["\\\\(1\\\\)","\\\\(2\\\\)","\\\\(3\\\\)","\\\\(4\\\\)"]', correct: "2", rationale: "r" };

describe("import math column", () => {
  it("is a v2 column", () => expect(V2_COLUMNS).toContain("math"));

  it("math=true with valid TeX passes and sets content.math", () => {
    const r = validateRow(2, { ...base, math: "true" });
    expect(r.errors).toEqual([]);
    expect(r.normalized?.content["math"]).toBe(true);
  });

  it("math=true with malformed TeX fails with a clear message", () => {
    const r = validateRow(2, { ...base, question: "Find \\(\\frac{1}{\\) now", math: "true" });
    expect(r.normalized).toBeNull();
    expect(r.errors[0]).toMatchObject({ row: 2, column: "math" });
    expect(r.errors[0]!.message).toMatch(/question: maths does not parse/);
  });

  it("TeX marks without math=true are refused", () => {
    const r = validateRow(2, base);
    expect(r.errors[0]).toMatchObject({ column: "math", message: "the text has LaTeX marks but math is not true" });
  });

  it("plain text without a math cell is unchanged", () => {
    const r = validateRow(2, { ...base, question: "Q one?", options: '["a","b","c","d"]' });
    expect(r.errors).toEqual([]);
    expect(r.normalized?.content["math"]).toBeUndefined();
  });

  it("an unreadable math cell is a row error", () => {
    expect(validateRow(2, { ...base, math: "maybe" }).errors[0]).toMatchObject({ column: "math" });
  });
});
