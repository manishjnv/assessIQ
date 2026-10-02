/**
 * ordering: the candidate view carries only question + items, items are always shown in a
 * per-attempt order that is never the correct order, and answers map display <-> original.
 * Pure, no DB.
 */
import { describe, it, expect } from "vitest";
import { sanitizeContentForCandidate } from "../repository.js";
import { buildOrderingOrder, displayQuestions, answerToOriginal, answerToDisplayed } from "../option-shuffle.js";
import { answerGuidanceFor } from "../answer-guidance.js";
import type { FrozenQuestion } from "../types.js";

const content = {
  question: "Order the response steps",
  items: ["Detect", "Contain", "Eradicate", "Recover"],
  correct_order: [0, 1, 2, 3],
  scoring: "partial",
  explanation: "NIST order",
};

function keysDeep(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keysDeep(x, out);
    }
  }
  return out;
}

describe("ordering sanitizer", () => {
  it("keeps only question + items", () => {
    expect(sanitizeContentForCandidate("ordering", content)).toEqual({ question: content.question, items: content.items });
  });

  it("no key named correct_order / scoring / explanation anywhere in the output", () => {
    const out = sanitizeContentForCandidate("ordering", content);
    const keys = keysDeep(out);
    for (const k of ["correct_order", "scoring", "explanation"]) expect(keys).not.toContain(k);
    expect(JSON.stringify(out)).not.toMatch(/correct_order|explanation|NIST/);
  });
});

describe("buildOrderingOrder", () => {
  // small deterministic PRNG (mulberry32) so 50 "seeds" are reproducible
  const prng = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it("is a permutation and never equals the correct order across 50 seeds", () => {
    for (let s = 1; s <= 50; s++) {
      const o = buildOrderingOrder(content.items, content.correct_order, prng(s)) as number[];
      expect([...o].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
      expect(o).not.toEqual(content.correct_order);
    }
  });

  it("rotates by one when the draw lands on the correct order", () => {
    // rng()=0.9999 -> j = i at every step -> the shuffle is the identity = the key
    expect(buildOrderingOrder(["a", "b", "c"], [0, 1, 2], () => 0.9999)).toEqual([1, 2, 0]);
    // a non-identity key that the identity draw does not hit is left alone
    expect(buildOrderingOrder(["a", "b", "c"], [2, 0, 1], () => 0.9999)).toEqual([0, 1, 2]);
  });

  it("holds for 2 and 10 items and for every key of 3 items", () => {
    for (const co of [[0, 1], [1, 0]]) expect(buildOrderingOrder(["a", "b"], co, prng(3))).not.toEqual(co);
    const ten = Array.from({ length: 10 }, (_, i) => `i${i}`);
    const tenKey = ten.map((_, i) => i);
    for (let s = 1; s <= 50; s++) expect(buildOrderingOrder(ten, tenKey, prng(s))).not.toEqual(tenKey);
    for (const co of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
      for (let s = 1; s <= 20; s++) expect(buildOrderingOrder(["a", "b", "c"], co, prng(s))).not.toEqual(co);
    }
  });

  it("returns null for malformed content", () => {
    expect(buildOrderingOrder(["a"], [0])).toBeNull();
    expect(buildOrderingOrder(["a", "b"], [0, 0])).toBeNull();
    expect(buildOrderingOrder(["a", "b"], [0, 1, 2])).toBeNull();
    expect(buildOrderingOrder("ab", [0, 1])).toBeNull();
    expect(buildOrderingOrder(["a", "b"], undefined)).toBeNull();
  });
});

describe("ordering display + answer mapping reuse the option-order mechanism", () => {
  const order = [2, 0, 3, 1]; // order[displayPos] = originalIdx

  it("displayQuestions rearranges `items` (and not `options`)", () => {
    const q = {
      question_id: "q1",
      type: "ordering",
      content: sanitizeContentForCandidate("ordering", content),
    } as unknown as FrozenQuestion;
    const shown = displayQuestions([q], new Map([["q1", order]]))[0]!;
    expect((shown.content as { items: string[] }).items).toEqual(order.map((i) => content.items[i]));
    expect(shown.content).not.toHaveProperty("options");
    expect(shown.content).not.toHaveProperty("correct_order");
  });

  it("display -> original and back is the identity", () => {
    const sent = { order: [3, 2, 1, 0] }; // displayed positions, in the candidate's arrangement
    const stored = answerToOriginal(sent, order, "order") as { order: number[] };
    expect(stored.order).toEqual([1, 3, 0, 2]); // order[3], order[2], order[1], order[0]
    expect(answerToDisplayed(stored, order, "order")).toEqual(sent);
  });

  it("the correct arrangement as shown is stored as the original order", () => {
    const shownSeq = [1, 3, 0, 2]; // displayed positions that hold originals 0,1,2,3
    expect((answerToOriginal({ order: shownSeq }, order, "order") as { order: number[] }).order).toEqual([0, 1, 2, 3]);
  });

  it("an invalid element leaves the answer untouched (fail-safe)", () => {
    expect(answerToOriginal({ order: [0, 1, 2, 9] }, order, "order")).toEqual({ order: [0, 1, 2, 9] });
  });

  it("has an answer-guidance default", () => {
    expect(answerGuidanceFor("ordering", null)).toBe("Put the items in the correct order.");
  });
  // codex review 2026-10-02: the key comes from the question type, never from the answer's shape.
  it("a crafted {selected, order} MCQ answer still translates `selected`", () => {
    const mcqOrder = [2, 0, 1];
    expect(answerToOriginal({ selected: 0, order: [0, 1, 2] }, mcqOrder)).toEqual({ selected: 2, order: [0, 1, 2] });
  });

  it("an ordering answer with an extra `selected` still translates `order`", () => {
    const order = [3, 2, 1, 0];
    const stored = answerToOriginal({ order: [0, 1, 2, 3], selected: 0 }, order, "order") as { order: number[] };
    expect(stored.order).toEqual([3, 2, 1, 0]);
  });

  it("ordering with no usable display order serves no items (fails closed)", () => {
    const q = { question_id: "q1", type: "ordering", content: { question: "x", items: ["a", "b", "c"] } } as unknown as FrozenQuestion;
    const shown = displayQuestions([q], new Map())[0]!;
    expect((shown.content as { items: unknown[] }).items).toEqual([]);
  });
});
