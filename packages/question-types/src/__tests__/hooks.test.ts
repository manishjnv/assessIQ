import { describe, expect, it } from "vitest";
import {
  AI_GRADEABLE_IDS, DETERMINISTIC_IDS, QUESTION_TYPES, QUESTION_TYPE_REGISTRY, RUBRIC_REQUIRED_IDS, RUBRIC_SYNTHESIS_IDS,
  McqAnswerPayloadSchema, candidateViewFor, checkAnswerFor, coerceContentFor, deterministicScoreFor, isDeterministicType, questionTypeIds,
} from "../index.js";
import { CONTENTS, RAW } from "./fixtures.js";

const reg = QUESTION_TYPE_REGISTRY;

describe("flags", () => {
  it.each([
    ["mcq", false, false, "none", "options"],
    ["subjective", true, true, "none", null],
    ["kql", false, false, "none", null],
    ["scenario", true, true, "steps_expected", null],
    ["log_analysis", true, false, "expected_findings", null],
    ["numeric", false, false, "none", null],
    ["multi_select", false, false, "none", "options"],
    ["ordering", false, false, "none", "items"],
    ["structured_case", false, false, "none", null],
  ] as const)("%s", (id, ai, rubric, synth, shuffle) => {
    expect([reg[id].aiGradeable, reg[id].rubricRequired, reg[id].rubricSynthesis, reg[id].shuffleField]).toEqual([ai, rubric, synth, shuffle]);
  });
  it("derived id lists", () => {
    expect([...AI_GRADEABLE_IDS]).toEqual(["subjective", "scenario", "log_analysis"]);
    expect([...RUBRIC_REQUIRED_IDS]).toEqual(["subjective", "scenario"]);
    expect([...RUBRIC_SYNTHESIS_IDS]).toEqual(["scenario", "log_analysis"]);
    expect(questionTypeIds()).toEqual(QUESTION_TYPES);
    expect(isDeterministicType("mcq")).toBe(true);
    expect(isDeterministicType("kql")).toBe(false);
    expect(isDeterministicType("nope")).toBe(false);
  });
  it("deterministicScore present exactly for deterministic types", () => {
    for (const t of QUESTION_TYPES) expect(typeof reg[t].deterministicScore === "function", t).toBe(DETERMINISTIC_IDS.includes(t));
  });
});

describe("candidateView never leaks the answer key", () => {
  const KEYS = ["correct", "correct_order", "answer", "tolerance", "rationale", "explanation", "scoring", "expected_findings", "expected_keywords", "sample_solution", "trap"];
  it.each(QUESTION_TYPES)("%s", (t) => {
    for (const c of CONTENTS[t]) {
      const json = JSON.stringify(reg[t].candidateView(c));
      for (const k of KEYS) expect(json, `${t} leaks ${k}`).not.toContain(`"${k}"`);
    }
  });
  it("non-object content is returned unchanged; unknown type keeps question only", () => {
    expect(reg.mcq.candidateView(null)).toBeNull();
    expect(reg.mcq.candidateView("x")).toBe("x");
    expect(candidateViewFor("nope", { question: "q", correct: 1 })).toEqual({ question: "q" });
    expect(candidateViewFor("nope", { correct: 1 })).toEqual({});
  });
  it("shape per type", () => {
    expect(reg.mcq.candidateView(CONTENTS.mcq[0])).toEqual({ question: "Which port is HTTPS?", options: ["80", "443", "22", "25"] });
    expect(reg.numeric.candidateView(CONTENTS.numeric[0])).toEqual({ question: "2+2", unit: "u" });
    expect(reg.structured_case.candidateView(CONTENTS.structured_case[0])).toEqual({
      title: "Case", context: "ctx", log_excerpt: "log",
      steps: [
        { id: "a", prompt: "p", select: "one", options: ["x", "y", "z"] },
        { id: "b", prompt: "q", select: "many", options: ["x", "y", "z"] },
      ],
    });
  });
});

describe("coerceContent", () => {
  it("mcq resolves letter / flag / fails closed on ambiguity", () => {
    expect(reg.mcq.coerceContent(RAW.mcq[0]!)).toEqual({ question: "S", options: ["a", "b", "c", "d"], correct: 1, rationale: "why" });
    expect(reg.mcq.coerceContent(RAW.mcq[1]!)["correct"]).toBe(1);
    expect(reg.mcq.coerceContent(RAW.mcq[2]!)).not.toHaveProperty("correct");
  });
  it("types without aliasing are identity", () => {
    for (const t of ["numeric", "multi_select", "ordering", "structured_case"] as const) {
      for (const r of RAW[t]) expect(reg[t].coerceContent(r)).toBe(r);
    }
  });
  it("wrapper passes unknown types through", () => {
    const r = { a: 1 };
    expect(coerceContentFor("nope", r)).toBe(r);
    expect(coerceContentFor(undefined, r)).toBe(r);
  });
});

describe("guidanceText / rubricText / synthConcepts", () => {
  it("guidance never carries the answer key", () => {
    expect(reg.scenario.guidanceText(CONTENTS.scenario[1])).toBe("Gen\ni\np1\np2");
    expect(reg.log_analysis.guidanceText(CONTENTS.log_analysis[0])).toBe("Find the attacker\nsyslog");
    expect(reg.mcq.guidanceText(CONTENTS.mcq[0])).toBe("Which port is HTTPS?");
    expect(reg.mcq.guidanceText(null)).toBe("");
  });
  it("rubric text", () => {
    expect(reg.log_analysis.rubricText(CONTENTS.log_analysis[0])).toBe(JSON.stringify(CONTENTS.log_analysis[0]));
    expect(reg.subjective.rubricText({ question: "q" })).toBe("q");
    expect(reg.scenario.rubricText(CONTENTS.scenario[0])).toBe(JSON.stringify(CONTENTS.scenario[0]));
  });
  it("synth concepts", () => {
    expect(reg.log_analysis.synthConcepts!(CONTENTS.log_analysis[0])).toEqual(["bruteforce", "ip 1.2.3.4"]);
    expect(reg.scenario.synthConcepts!(CONTENTS.scenario[1])).toEqual(["e1"]);
    expect(reg.scenario.synthConcepts!(null)).toEqual([]);
    for (const t of QUESTION_TYPES) expect(typeof reg[t].synthConcepts === "function", t).toBe(reg[t].rubricSynthesis !== "none");
  });
});

describe("deterministicScore", () => {
  it("known values", () => {
    expect(reg.mcq.deterministicScore!(CONTENTS.mcq[0], { selected: 1 })).toBe(1);
    expect(reg.mcq.deterministicScore!(CONTENTS.mcq[0], 0)).toBe(0);
    expect(reg.numeric.deterministicScore!(CONTENTS.numeric[0], " 4 ")).toBe(1);
    expect(reg.multi_select.deterministicScore!(CONTENTS.multi_select[0], [0])).toBe(0.5);
    expect(reg.ordering.deterministicScore!(CONTENTS.ordering[0], { order: [2, 0, 1, 3] })).toBe(0.5);
    expect(reg.structured_case.deterministicScore!(CONTENTS.structured_case[0], { steps: { a: [1], b: [0] } })).toBe(0.75);
    expect(deterministicScoreFor("kql", {}, {})).toBe(0);
  });
  it("never throws on junk", () => {
    const junk = [null, undefined, 5, "x", [], {}];
    for (const t of ["mcq", "numeric", "multi_select", "ordering", "structured_case"] as const) {
      for (const c of junk) for (const a of junk) expect(() => reg[t].deterministicScore!(c, a)).not.toThrow();
    }
  });
});

describe("evalStructuralCheck", () => {
  it("mcq needs 4 options", () => {
    expect(reg.mcq.evalStructuralCheck(CONTENTS.mcq[0])).toEqual({ ok: true });
    expect(reg.mcq.evalStructuralCheck({ question: "q", options: ["a", "b"], correct: 0, rationale: "r" })).toEqual({ ok: false, reason: "mcq: options.length !== 4" });
  });
  it("log_analysis needs 2 findings, scenario 1 step, kql 1 keyword, subjective non-empty", () => {
    expect(reg.log_analysis.evalStructuralCheck(CONTENTS.log_analysis[0]).ok).toBe(true);
    expect(reg.log_analysis.evalStructuralCheck(CONTENTS.log_analysis[1])).toEqual({ ok: false, reason: "log_analysis: expected_findings.length < 2" });
    expect(reg.scenario.evalStructuralCheck(CONTENTS.scenario[0]).ok).toBe(true);
    expect(reg.kql.evalStructuralCheck(CONTENTS.kql[0]).ok).toBe(true);
    expect(reg.subjective.evalStructuralCheck({ question: "  " }).ok).toBe(false);
    expect(reg.subjective.evalStructuralCheck(CONTENTS.subjective[0]).ok).toBe(true);
  });
  it("schema failure is reported, other types pass when valid", () => {
    expect(reg.kql.evalStructuralCheck(CONTENTS.kql[2]).reason).toMatch(/^schemaValid:/);
    for (const t of ["numeric", "multi_select", "ordering", "structured_case"] as const) {
      expect(reg[t].evalStructuralCheck(CONTENTS[t][0]).ok, t).toBe(true);
    }
  });
});

describe("checkAnswer", () => {
  const sc = CONTENTS.structured_case[0];
  it("structured_case", () => {
    const f = reg.structured_case.checkAnswer!;
    expect(f(null, sc)).toEqual({ ok: true, answer: null });
    expect(f({ steps: { a: [1], b: [0, 2] } }, sc)).toEqual({ ok: true, answer: { steps: { a: [1], b: [0, 2] } } });
    expect(f({ steps: { a: [1, 0] } }, sc).ok).toBe(false); // select-one, two picks
    expect(f({ steps: { a: [5] } }, sc).ok).toBe(false); // out of range
    expect(f({ steps: { nope: [0] } }, sc).ok).toBe(false); // unknown step
    expect(f({ steps: { b: [0, 0] } }, sc).ok).toBe(false); // duplicate
    expect(f({ nope: 1 }, sc).ok).toBe(false);
    expect(f({ steps: {} }, undefined).ok).toBe(false); // no frozen content
  });
  it("scenario strips unknown keys; other types pass", () => {
    const f = reg.scenario.checkAnswer!;
    expect(f({ steps: [{ stepIndex: 0, response: "r", x: 1 }], y: 2 })).toEqual({ ok: true, answer: { steps: [{ stepIndex: 0, response: "r" }] } });
    expect(f({ steps: "x" }).ok).toBe(false);
    expect(f(null)).toEqual({ ok: true, answer: null });
    for (const t of QUESTION_TYPES) {
      if (t !== "scenario" && t !== "structured_case") {
        expect(reg[t].checkAnswer, t).toBeUndefined();
        expect(checkAnswerFor(t, { anything: 1 })).toEqual({ ok: true, answer: { anything: 1 } });
      }
    }
    expect(checkAnswerFor(null, 5)).toEqual({ ok: true, answer: 5 });
  });
});

describe("mcq answer payload", () => {
  it("accepts 0-7 (options allow 2-8), rejects 8", () => {
    expect(McqAnswerPayloadSchema.safeParse({ selected: 7 }).success).toBe(true);
    expect(McqAnswerPayloadSchema.safeParse({ selected: 8 }).success).toBe(false);
  });
});
