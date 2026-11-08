/**
 * Import v2 `style` column: resolves to an exam-style node, and the mcq option-count rule
 * (style bank = 5 options, any other or empty style = 4). Pure logic, no database.
 */
import { describe, it, expect } from "vitest";
import { parseV2, styleOptionError, V2_COLUMNS, type TaxonomyIndex } from "../import/v2.js";
import { validateRowV2 } from "../import/staging.js";

const taxonomy: TaxonomyIndex = {
  nodes: [
    { id: "n-stage", parentId: null, kind: "stage", code: "ssc-cgl-tier-1", label: "SSC CGL Tier 1", fw: "exam-structure" },
    { id: "n-style-bank", parentId: null, kind: "stage", code: "bank", label: "Bank style", fw: "exam-style" },
    { id: "n-style-ssc", parentId: null, kind: "stage", code: "ssc", label: "SSC style", fw: "exam-style" },
  ],
};
const ctx = { format: "csv" as const, taxonomy };
const four = '["a","b","c","d"]';
const five = '["a","b","c","d","e"]';
const base = { type: "mcq", topic: "t", points: "1", level: "1", question: "Style probe?", options: four, correct: "1", rationale: "r", rights_status: "original" };

describe("styleOptionError", () => {
  it("bank needs exactly 5 options", () => {
    expect(styleOptionError("mcq", "bank", five)).toBeNull();
    expect(styleOptionError("mcq", "bank", four)).toMatch(/exactly 5 options; this row has 4/);
  });
  it("any other style and an empty style need exactly 4 options", () => {
    expect(styleOptionError("mcq", "ssc", four)).toBeNull();
    expect(styleOptionError("mcq", "", four)).toBeNull();
    expect(styleOptionError("mcq", "ssc", five)).toMatch(/exactly 4 options/);
    expect(styleOptionError("mcq", "", five)).toMatch(/no style/);
  });
  it("skips non-mcq rows and unreadable option cells", () => {
    expect(styleOptionError("short", "bank", four)).toBeNull();
    expect(styleOptionError("mcq", "bank", "not json")).toBeNull();
  });
});

describe("parseV2 style column", () => {
  it("is a template column", () => {
    expect(V2_COLUMNS).toContain("style");
  });
  it("resolves a known style to its node and inserts it as a node link", () => {
    const v = validateRowV2(2, { ...base, style: "bank", options: five }, ctx);
    expect(v.errors).toEqual([]);
    expect(v.normalized!.meta).toMatchObject({ styleNodeId: "n-style-bank" });
  });
  it("an empty style leaves styleNodeId null (neutral)", () => {
    const v = validateRowV2(2, { ...base, style: "" }, ctx);
    expect(v.errors).toEqual([]);
    expect(v.normalized!.meta).toMatchObject({ styleNodeId: null });
  });
  it("style 'neutral' inserts no node and uses the 4-option rule", () => {
    const withNeutral: TaxonomyIndex = { nodes: [...taxonomy.nodes, { id: "n-style-neutral", parentId: null, kind: "criterion", code: "neutral", label: "Neutral", fw: "exam-style" }] };
    const v = validateRowV2(2, { ...base, style: "neutral" }, { format: "csv", taxonomy: withNeutral });
    expect(v.errors).toEqual([]);
    expect(v.normalized!.meta).toMatchObject({ styleNodeId: null });
  });
  it("fails the row with a clear message when bank has 4 options", () => {
    const v = validateRowV2(2, { ...base, style: "bank" }, ctx);
    expect(v.normalized).toBeNull();
    expect(v.errors).toEqual([expect.objectContaining({ row: 2, column: "options", message: expect.stringMatching(/exactly 5/) })]);
  });
  it("fails an unknown style and names the column", () => {
    const r = parseV2(2, { rights_status: "original", style: "nope" }, { requireRights: true, taxonomy });
    expect(r.errors.map((e) => e.column)).toEqual(["style"]);
  });
});
