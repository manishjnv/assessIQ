/** EXP-7: pure tests on synthetic data only. No real exam content, no DB, no AI call. */
import { describe, it, expect } from "vitest";
import {
  similarity, gateA1, gateA2, itemText, provenanceFor, tokenize,
  A1_MAX_SEED_SIMILARITY, A2_MIN_SOURCE_SIMILARITY,
} from "../exam-item-gate.js";
import { parseExamItemBody, gateExamDrafts, runExamItemGenerate } from "../service/exam-item-generation.js";

const SEED = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
const SRC = "red green blue yellow orange purple pink brown black white grey cyan";

describe("similarity", () => {
  it("is 1 for identical, 0 for disjoint, deterministic", () => {
    expect(similarity(SEED, SEED)).toBe(1);
    expect(similarity(SEED, SRC)).toBe(0);
    expect(similarity(SEED, "Alpha, BETA gamma!")).toBe(similarity(SEED, "Alpha, BETA gamma!"));
  });
  it("handles Hindi words and empty text", () => {
    expect(tokenize("यह एक परीक्षा है")).toEqual(["यह", "एक", "परीक्षा", "है"]);
    expect(similarity("", SEED)).toBe(0);
  });
});

describe("gateA1", () => {
  it("rejects an item close to any seed", () => {
    const near = SEED.replace("mu", "nu");
    const r = gateA1(near, [SRC, SEED]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("too_close_to_seed");
    expect(r.closestIndex).toBe(1);
    expect(r.score).toBeGreaterThanOrEqual(A1_MAX_SEED_SIMILARITY);
  });
  it("accepts an unrelated item", () => {
    expect(gateA1("one two three four five six seven eight", [SEED, SRC]).ok).toBe(true);
  });
});

describe("gateA2", () => {
  it("accepts a light edit close to the source", () => {
    const edit = SRC.replace("grey", "gray").replace("cyan", "teal");
    const r = gateA2(edit, SRC, [SEED]);
    expect(r.ok).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(A2_MIN_SOURCE_SIMILARITY);
  });
  it("rejects drift, unchanged copy, missing source and a bank duplicate", () => {
    expect(gateA2("totally different words appear in this long sentence now", SRC).reason).toBe("too_far_from_source");
    expect(gateA2(SRC, SRC).reason).toBe("unchanged_copy");
    expect(gateA2(SRC, null).reason).toBe("missing_source");
    const edit = SRC.replace("grey", "gray");
    expect(gateA2(edit, SRC, [edit]).reason).toBe("duplicate_in_bank");
  });
});

describe("provenance and body parsing", () => {
  it("A1 is ai_original, A2 keeps source_ref", () => {
    expect(provenanceFor("a1").origin).toBe("ai_original");
    const p = provenanceFor("a2", " ref-1 ");
    expect(p).toEqual({ origin: "derived_from_source", rightsStatus: "derived_from_source", sourceRef: "ref-1" });
    expect(() => provenanceFor("a2")).toThrow();
  });
  it("validates mode, concept and source_refs", () => {
    expect(() => parseExamItemBody({ mode: "x" }, 3)).toThrow();
    expect(() => parseExamItemBody({ mode: "a1", concept: "" }, 3)).toThrow();
    expect(() => parseExamItemBody({ mode: "a2", source_refs: [] }, 3)).toThrow();
    expect(parseExamItemBody({ mode: "a1", concept: " ratio " }, 3).concept).toBe("ratio");
    expect(parseExamItemBody({ mode: "a2", source_refs: ["r1"] }, 2).sourceRefs).toEqual(["r1"]);
  });
});

describe("runExamItemGenerate", () => {
  it("runs under the lock and returns only gate-passing items", async () => {
    let locked = false;
    const out = await runExamItemGenerate("t1", { mode: "a1", concept: "c", count: 2 }, {
      lock: async (_k, run) => { locked = true; return run(new AbortController().signal); },
      run: async () => ({
        drafts: [{ stem: SEED }, { stem: "fresh unrelated words about something else entirely", options: ["a", "b"] }],
        seeds: [SEED], sources: {}, bank: [],
      }),
    });
    expect(locked).toBe(true);
    expect(out.accepted).toHaveLength(1);
    expect(out.rejected[0]?.reason).toBe("too_close_to_seed");
  });
  it("gateExamDrafts rejects an A2 draft without a source", () => {
    const r = gateExamDrafts("a2", { drafts: [{ stem: SRC }], seeds: [], sources: {}, bank: [] });
    expect(r[0]?.gate.reason).toBe("missing_source");
    expect(itemText({ stem: "s", options: ["a"] })).toContain("a");
  });
});
