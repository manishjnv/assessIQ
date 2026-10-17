/**
 * EXP-4: import v2 pure logic (no database): difficulty mapping, normalised-text hash,
 * v2 column validation, duplicate classes, template columns.
 */
import { describe, it, expect } from "vitest";
import { DIFFICULTY_SCALES, mapDifficulty } from "../import/difficulty.js";
import { normalisedTextHash, parseV2, V2_COLUMNS, type TaxonomyIndex } from "../import/v2.js";
import { decide, validateRowV2, contentHash } from "../import/staging.js";
import { templateRows } from "../import/templates.js";

const taxonomy: TaxonomyIndex = {
  nodes: [
    { id: "n-stage", parentId: null, kind: "stage", code: "ssc-cgl-tier-1", label: "SSC CGL Tier 1", fw: "exam-structure" },
    { id: "n-quant", parentId: null, kind: "subject", code: "quant", label: "Quant", fw: "subject-map" },
    { id: "n-arith", parentId: "n-quant", kind: "unit", code: "arithmetic", label: "Arithmetic", fw: "subject-map" },
    { id: "n-pct", parentId: "n-arith", kind: "outcome", code: "percentage", label: "Percentage", fw: "subject-map" },
  ],
};
const base = { type: "mcq", topic: "t", points: "1", level: "1", question: "Q one?", options: '["a","b"]', correct: "1", rationale: "r" };

describe("mapDifficulty", () => {
  it("maps each scale", () => {
    expect(mapDifficulty("Easy", "words")).toEqual({ value: 2 });
    expect(mapDifficulty("medium", "words")).toEqual({ value: 3 });
    expect(mapDifficulty("HARD", "")).toEqual({ value: 4 });
    expect(mapDifficulty("1", "1-3")).toEqual({ value: 1 });
    expect(mapDifficulty("2", "1-3")).toEqual({ value: 3 });
    expect(mapDifficulty("3", "1-3")).toEqual({ value: 5 });
    expect(mapDifficulty("4", "1-5")).toEqual({ value: 4 });
    expect(mapDifficulty("5", "")).toEqual({ value: 5 });
  });
  it("rejects an unknown label or scale", () => {
    expect(mapDifficulty("tough", "words")).toHaveProperty("error");
    expect(mapDifficulty("4", "1-3")).toHaveProperty("error");
    expect(mapDifficulty("easy", "nope")).toHaveProperty("error");
    expect(Object.keys(DIFFICULTY_SCALES)).toEqual(["words", "1-3", "1-5"]);
  });
});

describe("normalisedTextHash", () => {
  const a = { question: "Which port is HTTPS?", options: ["80", "443"], correct: 1 };
  it("ignores case, spacing and option labels", () => {
    const b = { question: "  WHICH   port is https? ", options: ["A) 80", "(b) 443"], correct: 1 };
    expect(normalisedTextHash(b)).toBe(normalisedTextHash(a));
  });
  it("differs when the text differs", () => {
    expect(normalisedTextHash({ ...a, question: "Which port is SSH?" })).not.toBe(normalisedTextHash(a));
  });
});

describe("validateRowV2", () => {
  const ctx = { format: "csv" as const, taxonomy };
  it("requires rights_status for csv and xlsx, with a clear message", () => {
    const v = validateRowV2(2, base, ctx);
    expect(v.normalized).toBeNull();
    expect(v.errors[0]).toMatchObject({ column: "rights_status" });
    expect(v.errors[0]!.message).toMatch(/required/);
  });
  it("defaults rights for gift/aiken/qti, which cannot carry the column", () => {
    const v = validateRowV2(2, base, { ...ctx, format: "gift" });
    expect(v.errors).toEqual([]);
    expect(v.normalized!.meta).toMatchObject({ rightsStatus: "original", origin: "original_human" });
  });
  it("resolves tags, difficulty and the default origin", () => {
    const v = validateRowV2(2, {
      ...base, rights_status: "scraped_raw", exam_stage: "ssc cgl tier 1", subject_path: "Quant/Arithmetic/Percentage",
      difficulty: "Hard", difficulty_scale: "words", language: "HI", pyq_year: "2023", pyq_shift: "Shift 2",
      source_url: "https://example.org/p",
    }, ctx);
    expect(v.errors).toEqual([]);
    expect(v.normalized!.meta).toMatchObject({
      origin: "scraped_raw", rightsStatus: "scraped_raw", stageNodeId: "n-stage", subjectNodeId: "n-pct",
      sourceDifficultyRaw: "Hard", difficultyEst: 4, language: "hi", pyqYear: 2023, pyqShift: "Shift 2",
    });
  });
  it("maps the other rights values to their default origin", () => {
    const origin = (r: string) => validateRowV2(2, { ...base, rights_status: r }, ctx).normalized!.meta!.origin;
    expect([origin("original"), origin("derived_from_source"), origin("licensed"), origin("metadata_only")])
      .toEqual(["original_human", "derived_from_source", "licensed", "original_human"]);
  });
  it("rejects withdrawn, unknown values and unknown tags (never a silent skip)", () => {
    expect(validateRowV2(2, { ...base, rights_status: "withdrawn" }, ctx).errors[0]).toMatchObject({ column: "rights_status" });
    expect(validateRowV2(2, { ...base, rights_status: "original", origin: "tenant_upload" }, ctx).errors[0]).toMatchObject({ column: "origin" });
    expect(validateRowV2(2, { ...base, rights_status: "scraped_raw", origin: "original_human" }, ctx).errors[0]).toMatchObject({ column: "origin" });
    expect(validateRowV2(2, { ...base, rights_status: "original", exam_stage: "Nope" }, ctx).errors[0]).toMatchObject({ column: "exam_stage" });
    const bad = validateRowV2(2, { ...base, rights_status: "original", subject_path: "Quant/Geometry" }, ctx);
    expect(bad.errors[0]).toMatchObject({ column: "subject_path" });
    expect(bad.errors[0]!.message).toMatch(/Geometry/);
    expect(validateRowV2(2, { ...base, rights_status: "original", difficulty: "tough" }, ctx).errors[0]).toMatchObject({ column: "difficulty" });
  });
  it("parseV2 alone reports bad language, year and url", () => {
    const r = parseV2(2, { rights_status: "original", language: "x", pyq_year: "1800", source_url: "ftp://a" }, { requireRights: true, taxonomy });
    expect(r.errors.map((e) => e.column).sort()).toEqual(["language", "pyq_year", "source_url"]);
  });
});

describe("decide duplicate classes", () => {
  const row = (question: string, similar = false) => {
    const v = validateRowV2(2, { ...base, question, rights_status: "original" }, { format: "csv", taxonomy });
    return { normalized: v.normalized, errors: v.errors, hash: contentHash("mcq", v.normalized!.content), skipped: false, similar };
  };
  it("labels exact, normalised and similar", () => {
    const r1 = row("Alpha question?");
    const exact = row("Alpha question?");
    const norm = row("ALPHA   question?");
    const sim = row("Different text?", true);
    const out = decide([r1, exact, norm, sim], new Set());
    expect(out).toEqual([
      { decision: "ok", dup: null }, { decision: "duplicate", dup: "exact" },
      { decision: "duplicate", dup: "normalised" }, { decision: "ok", dup: "similar" },
    ]);
  });
  it("compares against existing exact and normalised hashes", () => {
    const r = row("Beta question?");
    expect(decide([r], new Set([r.hash]))[0]).toEqual({ decision: "duplicate", dup: "exact" });
    expect(decide([r], new Set(), new Set([r.normalized!.meta!.normalisedHash]))[0]).toEqual({ decision: "duplicate", dup: "normalised" });
  });
});

describe("template columns", () => {
  it("carries every v2 column and rights_status is filled in the example", () => {
    const { header, example } = templateRows("mcq");
    for (const c of V2_COLUMNS) expect(header).toContain(c);
    expect(example[header.indexOf("rights_status")]).toBe("original");
    expect(header.length).toBe(example.length);
  });
});
