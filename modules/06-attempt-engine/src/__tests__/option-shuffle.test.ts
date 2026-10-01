/**
 * Pure unit tests for the per-student MCQ option shuffle helpers.
 * No database, no testcontainer.
 */
import { describe, it, expect } from "vitest";
import {
  answerToDisplayed,
  answerToOriginal,
  buildOptionOrder,
  displayAnswers,
  displayQuestions,
  optionsCrossReference,
  usableOrder,
} from "../option-shuffle.js";
import type { AttemptAnswer, FrozenQuestion } from "../types.js";

/** Three plain options plus the one under test. */
const withPlain = (extra: string): string[] => ["Paris", "London", "Berlin", extra];

/** All permutations of 0..n-1. */
function permutations(n: number): number[][] {
  if (n === 0) return [[]];
  const out: number[][] = [];
  for (const p of permutations(n - 1)) {
    for (let i = 0; i <= p.length; i++) out.push([...p.slice(0, i), n - 1, ...p.slice(i)]);
  }
  return out;
}

describe("optionsCrossReference", () => {
  it.each([
    "All of the above",
    "all of these",
    "None of the above",
    "None of these",
    "Both of the above",
    "Any of them",
    "Both A and B",
    "A and C",
    "A and C only",
    "A, B and D",
    "A & B",
    "Either A or B",
    "Neither A nor B",
    "Neither of them",
    "Only B",
    "Only A and B",
    "B only",
    "Option C",
    "option (c)",
    "Choice B is correct",
    "Both (a) and (b)",
    "a and c",
    "(a), (c)",
    "I and II",
    "II, III and IV",
    "1 and 3 only",
    "Statements 1 and 2",
    "Both are correct",
    "All are true",
    "None is right",
    "All four",
    "None",
    "Both",
    "A",
    "(b)",
    "A. Paris",
    "b) Paris",
    "1. Paris",
    "The latter",
    "The first option",
    "Same as option B",
    "Same as above",
    "Same as A",
    "Any of the above",
    "Everything except B",
    "Not C",
    "None of the others",
    "All the rest",
    "The other option",
    "Previous option",
    "AB",
    "ACD",
    "A as well as B",
    "A + B",
    "A or B or C",
    "B is correct",
    "A is true, B is false",
    "first and second",
    "2nd and 4th",
    "The first two",
    "A - Paris",
    "Both TCP and UDP use ports", // deliberately conservative: "both" is flagged wherever it appears
  ])("flags %j as referring to its siblings", (text) => {
    expect(optionsCrossReference(withPlain(text))).toBe(true);
  });

  it.each([
    "Paris",
    "12",
    "3.5",
    "0.25",
    "1999",
    "5",
    "-4",
    "2/3",
    "1:2",
    "x = 5",
    "30 km/h",
    "Cannot be determined",
    "True",
    "False",
    "Disable all unused network ports",
    "Rotate the API key every 90 days",
    "Vitamin C",
    "Class B",
    "Grade A+",
    "Plan A",
    "12, 13",
    "Above 50%",
    "Ports above 1024",
    "Not Applicable",
    "Except Delhi",
  ])("does not flag %j", (text) => {
    expect(optionsCrossReference(withPlain(text))).toBe(false);
  });

  it("only needs one referring option to flag the whole question", () => {
    expect(optionsCrossReference(["12", "15", "18", "None of these"])).toBe(true);
    expect(optionsCrossReference(["12", "15", "18", "24"])).toBe(false);
  });
});

describe("buildOptionOrder", () => {
  const options = ["Paris", "London", "Berlin", "Madrid"];

  it("returns a valid permutation of 0..n-1 for eligible options", () => {
    for (let n = 2; n <= 8; n++) {
      const opts = Array.from({ length: n }, (_, i) => `Option text number ${i * 7 + 11}`);
      // "Option text number 11" etc. are plain prose — never flagged.
      const order = buildOptionOrder(opts);
      expect(order).not.toBeNull();
      expect(order).toHaveLength(n);
      expect([...(order as number[])].sort((a, b) => a - b)).toEqual(opts.map((_, i) => i));
    }
  });

  it("is random per call (not always the authored order) and follows the injected rng", () => {
    let nonIdentity = 0;
    for (let i = 0; i < 200; i++) {
      const o = buildOptionOrder(options) as number[];
      if (o.join() !== "0,1,2,3") nonIdentity++;
    }
    expect(nonIdentity).toBeGreaterThan(150); // 23/24 of draws are not the identity

    // rng always 0 -> j = 0 each step -> deterministic rotation; same rng, same order.
    const a = buildOptionOrder(options, () => 0);
    const b = buildOptionOrder(options, () => 0);
    expect(a).toEqual(b);
    // rng just below 1 -> j = i every step -> the identity (nothing moves).
    expect(buildOptionOrder(options, () => 0.999999)).toEqual([0, 1, 2, 3]);
  });

  it("covers every permutation of 4 options (uniform enough to be unguessable)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 4000; i++) seen.add((buildOptionOrder(options) as number[]).join(","));
    expect(seen.size).toBe(24);
  });

  it("shuffles Greek maths symbols and accented Latin text, but leaves other scripts alone (detector reads English only)", () => {
    expect(buildOptionOrder(["π", "2π", "π/2", "π/4"])).not.toBeNull();
    expect(buildOptionOrder(["Zürich", "Genève", "Bern", "Basel"])).not.toBeNull();
    expect(buildOptionOrder(["पेरिस", "लंदन", "बर्लिन", "उपरोक्त सभी"])).toBeNull();
    expect(buildOptionOrder(["Paris", "London", "Berlin", "以上都是"])).toBeNull();
  });

  it("is linear on pathological whitespace (no regex blow-up on an option from the question bank)", () => {
    const t0 = Date.now();
    buildOptionOrder(["Paris", "London", "Berlin", `option${" ".repeat(100_000)}z`]);
    buildOptionOrder(["Paris", "London", "Berlin", `${" ".repeat(100_000)}A.`]);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it.each([
    ["not an array", "Paris"],
    ["null", null],
    ["undefined", undefined],
    ["a single option", ["Only one"]],
    ["more than 8 options", Array.from({ length: 9 }, (_, i) => `Choice text ${i}${i}${i}`)],
    ["non-string options", ["Paris", 2, "Berlin", "Madrid"]],
    ["a blank option", ["Paris", "  ", "Berlin", "Madrid"]],
    ["options that refer to each other", ["Paris", "London", "Berlin", "All of the above"]],
  ])("returns null (authored order) for %s", (_label, input) => {
    expect(buildOptionOrder(input)).toBeNull();
  });
});

describe("usableOrder", () => {
  it("accepts a valid permutation", () => {
    expect(usableOrder([2, 0, 1, 3])).toEqual([2, 0, 1, 3]);
    expect(usableOrder([1, 0])).toEqual([1, 0]);
  });

  it.each([
    ["null", null],
    ["not an array", "2013"],
    ["empty", []],
    ["length 1", [0]],
    ["duplicate", [0, 0, 1]],
    ["out of range", [0, 1, 3]],
    ["negative", [0, -1, 1]],
    ["non-integer", [0, 1.5, 2]],
    ["non-number", [0, "1", 2]],
  ])("rejects %s", (_label, input) => {
    expect(usableOrder(input)).toBeNull();
  });
});

describe("answer translation", () => {
  it("maps the displayed index to the original index and back, for every permutation of 4", () => {
    const options = ["Paris", "London", "Berlin", "Madrid"];
    for (const order of permutations(4)) {
      for (let d = 0; d < 4; d++) {
        const stored = answerToOriginal({ selected: d }, order) as { selected: number };
        // what the candidate clicked (option text at display position d) is exactly the
        // original option the server stores
        expect(stored.selected).toBe(order[d]);
        expect(options[stored.selected]).toBe(order.map((i) => options[i])[d]);
        expect(answerToDisplayed(stored, order)).toEqual({ selected: d });
      }
    }
  });

  it("keeps any extra keys and normalises a bare integer to the canonical object", () => {
    const order = [2, 0, 1, 3];
    expect(answerToOriginal({ selected: 1, note: "x" }, order)).toEqual({ selected: 0, note: "x" });
    expect(answerToOriginal(1, order)).toEqual({ selected: 0 });
    expect(answerToDisplayed(1, order)).toEqual({ selected: 2 });
  });

  it.each([
    ["out of range high", { selected: 4 }],
    ["out of range low", { selected: -1 }],
    ["non-integer", { selected: 1.5 }],
    ["string index", { selected: "1" }],
    ["null selection", { selected: null }],
    ["missing selection", {}],
    ["bare string", "1"],
    ["bare out-of-range integer", 7],
    ["null", null],
    ["array", [1]],
  ])("passes %s through unchanged in both directions (never turned into a valid answer)", (_label, answer) => {
    const order = [2, 0, 1, 3];
    expect(answerToOriginal(answer, order)).toBe(answer);
    expect(answerToDisplayed(answer, order)).toBe(answer);
  });
});

describe("candidate view translation", () => {
  const q = (id: string, type: string, content: unknown): FrozenQuestion => ({
    question_id: id,
    position: 1,
    question_version: 1,
    type,
    topic: "t",
    points: 1,
    answer_guidance: "g",
    content,
  });
  const ans = (id: string, answer: unknown): AttemptAnswer => ({
    attempt_id: "a",
    question_id: id,
    answer,
    flagged: false,
    time_spent_seconds: 0,
    edits_count: 0,
    client_revision: 0,
    saved_at: null,
  });

  it("rearranges only the shuffled MCQ options, never mutates the input and never exposes the order", () => {
    const mcq = q("q1", "mcq", { question: "Capital?", options: ["Paris", "London", "Berlin", "Madrid"] });
    const legacy = q("q2", "mcq", { question: "Capital?", options: ["Paris", "London", "Berlin", "Madrid"] });
    const sub = q("q3", "subjective", { question: "Explain" });
    const out = displayQuestions([mcq, legacy, sub], new Map([["q1", [3, 1, 0, 2]]]));

    expect((out[0]?.content as { options: string[] }).options).toEqual(["Madrid", "London", "Paris", "Berlin"]);
    expect(out[1]).toBe(legacy);
    expect(out[2]).toBe(sub);
    expect((mcq.content as { options: string[] }).options).toEqual(["Paris", "London", "Berlin", "Madrid"]);
    expect(JSON.stringify(out)).not.toMatch(/option_order|optionOrder/);
  });

  it("maps saved selections back to the displayed position", () => {
    const orders = new Map([["q1", [3, 1, 0, 2]]]);
    const out = displayAnswers([ans("q1", { selected: 0 }), ans("q2", { selected: 0 }), ans("q1b", null)], orders);
    expect(out[0]?.answer).toEqual({ selected: 2 }); // original 0 sits at display position 2
    expect(out[1]?.answer).toEqual({ selected: 0 }); // no order -> unchanged
    expect(out[2]?.answer).toBeNull();
  });

  it("an unusable stored order degrades to the authored order on the read seam too", () => {
    const mcq = q("q1", "mcq", { question: "?", options: ["a1", "b2", "c3", "d4"] });
    expect(displayQuestions([mcq], new Map([["q1", [0, 0, 1, 2]]]))[0]).toBe(mcq);
    const a = ans("q1", { selected: 1 });
    expect(displayAnswers([a], new Map([["q1", [0, 0, 1, 2]]]))[0]).toBe(a);
  });

  it("fails loudly (never silently mis-scores) when an order does not match its frozen options", () => {
    const mcq = q("q1", "mcq", { question: "?", options: ["a1", "b2", "c3"] });
    expect(() => displayQuestions([mcq], new Map([["q1", [2, 0, 1, 3]]]))).toThrow(/does not match/);
  });
});
