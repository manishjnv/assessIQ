/**
 * Unit tests for difficulty-spec.ts — Phase A1
 *
 * Pure-function tests: no DB, no network, no `claude` invocation.
 * Covers validateStructuralDifficulty, resolveDifficulty, and functionToNice.
 */

import { describe, it, expect } from "vitest";
import {
  validateStructuralDifficulty,
  resolveDifficulty,
  functionToNice,
} from "../difficulty-spec.js";

// ---------------------------------------------------------------------------
// Helper — assert a failure result and optionally check reason substring
// ---------------------------------------------------------------------------

function expectFail(
  result: { ok: true } | { ok: false; reason: string },
  reasonContains?: string,
): void {
  expect(result.ok).toBe(false);
  if (reasonContains !== undefined && result.ok === false) {
    expect(result.reason).toContain(reasonContains);
  }
}

function expectOk(result: { ok: true } | { ok: false; reason: string }): void {
  if (!result.ok) {
    throw new Error(`Expected ok but got failure: ${result.reason}`);
  }
  expect(result.ok).toBe(true);
}

// ---------------------------------------------------------------------------
// mcq
// ---------------------------------------------------------------------------

describe("validateStructuralDifficulty — mcq", () => {
  const mcqContent = (n: number) => ({ options: Array.from({ length: n }, (_, i) => `opt${i}`) });

  it("4 options → ok", () => {
    expectOk(validateStructuralDifficulty("mcq", "L1", mcqContent(4), null));
  });

  it("3 options → fail", () => {
    expectFail(validateStructuralDifficulty("mcq", "L1", mcqContent(3), null), "3");
  });

  it("5 options → fail", () => {
    expectFail(validateStructuralDifficulty("mcq", "L2", mcqContent(5), null), "5");
  });

  it("missing options array → fail", () => {
    expectFail(validateStructuralDifficulty("mcq", "L1", { question: "Q?" }, null));
  });

  it("null content → fail", () => {
    expectFail(validateStructuralDifficulty("mcq", "L1", null, null));
  });

  it("4 options valid across all levels", () => {
    for (const level of ["L1", "L2", "L3"] as const) {
      expectOk(validateStructuralDifficulty("mcq", level, mcqContent(4), null));
    }
  });
});

// ---------------------------------------------------------------------------
// kql
// ---------------------------------------------------------------------------

describe("validateStructuralDifficulty — kql", () => {
  const kqlContent = (n: number) => ({ tables: Array.from({ length: n }, (_, i) => `table${i}`) });

  it("L1 tables=1 → ok", () => {
    expectOk(validateStructuralDifficulty("kql", "L1", kqlContent(1), null));
  });

  it("L1 tables=2 → fail (max 1)", () => {
    expectFail(validateStructuralDifficulty("kql", "L1", kqlContent(2), null));
  });

  it("L2 tables=1 → ok", () => {
    expectOk(validateStructuralDifficulty("kql", "L2", kqlContent(1), null));
  });

  it("L2 tables=2 → ok", () => {
    expectOk(validateStructuralDifficulty("kql", "L2", kqlContent(2), null));
  });

  it("L3 tables=2 → ok", () => {
    expectOk(validateStructuralDifficulty("kql", "L3", kqlContent(2), null));
  });

  it("L3 tables=3 → ok", () => {
    expectOk(validateStructuralDifficulty("kql", "L3", kqlContent(3), null));
  });

  it("L3 tables=4 → fail (max 3)", () => {
    expectFail(validateStructuralDifficulty("kql", "L3", kqlContent(4), null), "4");
  });

  it("missing tables → fail", () => {
    expectFail(validateStructuralDifficulty("kql", "L1", { question: "Q?" }, null));
  });

  it("null content → fail", () => {
    expectFail(validateStructuralDifficulty("kql", "L2", null, null));
  });
});

// ---------------------------------------------------------------------------
// scenario
// ---------------------------------------------------------------------------

describe("validateStructuralDifficulty — scenario", () => {
  const scenarioContent = (steps: number, dep?: string) => ({
    steps: Array.from({ length: steps }, (_, i) => ({ id: `s${i}`, type: "mcq" })),
    ...(dep !== undefined ? { step_dependency: dep } : {}),
  });

  it("L1 steps=2 → ok", () => {
    expectOk(validateStructuralDifficulty("scenario", "L1", scenarioContent(2), null));
  });

  it("L1 steps=3 → ok", () => {
    expectOk(validateStructuralDifficulty("scenario", "L1", scenarioContent(3), null));
  });

  it("L1 steps=4 → fail (max 3)", () => {
    expectFail(validateStructuralDifficulty("scenario", "L1", scenarioContent(4), null), "4");
  });

  it("L1 steps=1 → fail (min 2)", () => {
    expectFail(validateStructuralDifficulty("scenario", "L1", scenarioContent(1), null));
  });

  it("L1 step_dependency=parallel → fail (only linear allowed)", () => {
    expectFail(
      validateStructuralDifficulty("scenario", "L1", scenarioContent(2, "parallel"), null),
      "parallel",
    );
  });

  it("L1 step_dependency=linear → ok", () => {
    expectOk(validateStructuralDifficulty("scenario", "L1", scenarioContent(2, "linear"), null));
  });

  it("L3 step_dependency=parallel → ok", () => {
    expectOk(
      validateStructuralDifficulty("scenario", "L3", scenarioContent(4, "parallel"), null),
    );
  });

  it("L3 step_dependency=linear → ok", () => {
    expectOk(
      validateStructuralDifficulty("scenario", "L3", scenarioContent(4, "linear"), null),
    );
  });

  it("L3 steps=5 → ok", () => {
    expectOk(validateStructuralDifficulty("scenario", "L3", scenarioContent(5), null));
  });

  it("L3 steps=6 → fail (max 5)", () => {
    expectFail(validateStructuralDifficulty("scenario", "L3", scenarioContent(6), null));
  });

  it("missing steps array → fail", () => {
    expectFail(validateStructuralDifficulty("scenario", "L1", { title: "T" }, null));
  });

  it("absent step_dependency (not present at all) → ok (do not fail)", () => {
    // step_dependency is optional — absence must NOT fail
    expectOk(validateStructuralDifficulty("scenario", "L1", scenarioContent(2), null));
  });

  it("L2 steps=3 → ok", () => {
    expectOk(validateStructuralDifficulty("scenario", "L2", scenarioContent(3), null));
  });

  it("L2 steps=4 → ok", () => {
    expectOk(validateStructuralDifficulty("scenario", "L2", scenarioContent(4), null));
  });
});

// ---------------------------------------------------------------------------
// subjective (D-3 RULE)
// ---------------------------------------------------------------------------

describe("validateStructuralDifficulty — subjective (D-3 rule)", () => {
  const anchors = (n: number) => ({ anchors: Array.from({ length: n }, (_, i) => `anchor${i}`) });

  it("rubric=null → ok (D-3: rubric generated later)", () => {
    expectOk(validateStructuralDifficulty("subjective", "L1", {}, null));
  });

  it("rubric=undefined → ok (D-3)", () => {
    expectOk(validateStructuralDifficulty("subjective", "L1", {}, undefined));
  });

  it("rubric={} (no anchors property) → ok (defer)", () => {
    expectOk(validateStructuralDifficulty("subjective", "L1", {}, {}));
  });

  it("rubric with anchors=[] (empty array) → fail for L1 (min 2)", () => {
    expectFail(validateStructuralDifficulty("subjective", "L1", {}, anchors(0)));
  });

  it("L1 anchors=2 → ok", () => {
    expectOk(validateStructuralDifficulty("subjective", "L1", {}, anchors(2)));
  });

  it("L1 anchors=3 → ok", () => {
    expectOk(validateStructuralDifficulty("subjective", "L1", {}, anchors(3)));
  });

  it("L1 anchors=5 → fail (max 3)", () => {
    expectFail(validateStructuralDifficulty("subjective", "L1", {}, anchors(5)), "5");
  });

  it("L2 anchors=3 → ok", () => {
    expectOk(validateStructuralDifficulty("subjective", "L2", {}, anchors(3)));
  });

  it("L2 anchors=4 → ok", () => {
    expectOk(validateStructuralDifficulty("subjective", "L2", {}, anchors(4)));
  });

  it("L2 anchors=2 → fail (min 3)", () => {
    expectFail(validateStructuralDifficulty("subjective", "L2", {}, anchors(2)));
  });

  it("L3 anchors=4 → ok", () => {
    expectOk(validateStructuralDifficulty("subjective", "L3", {}, anchors(4)));
  });

  it("L3 anchors=6 → ok", () => {
    expectOk(validateStructuralDifficulty("subjective", "L3", {}, anchors(6)));
  });

  it("L3 anchors=7 → fail (max 6)", () => {
    expectFail(validateStructuralDifficulty("subjective", "L3", {}, anchors(7)), "7");
  });

  it("L3 anchors=3 → fail (min 4)", () => {
    expectFail(validateStructuralDifficulty("subjective", "L3", {}, anchors(3)));
  });
});

// ---------------------------------------------------------------------------
// log_analysis — no hard gate in Phase A
// ---------------------------------------------------------------------------

describe("validateStructuralDifficulty — log_analysis (no hard gate)", () => {
  it("any content → ok", () => {
    expectOk(validateStructuralDifficulty("log_analysis", "L1", null, null));
  });

  it("empty object → ok", () => {
    expectOk(validateStructuralDifficulty("log_analysis", "L2", {}, null));
  });

  it("rich content → ok", () => {
    expectOk(
      validateStructuralDifficulty(
        "log_analysis",
        "L3",
        {
          question: "What happened?",
          log_excerpt: "2024-01-01T00:00:00Z [ERROR] something failed\n".repeat(25),
          log_format: "syslog",
          expected_findings: ["f1", "f2", "f3", "f4"],
        },
        null,
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// resolveDifficulty — spot checks
// ---------------------------------------------------------------------------

describe("resolveDifficulty", () => {
  it("mcq L1 returns optionsExactly=4 and cognitiveLevel includes remember", () => {
    const spec = resolveDifficulty("mcq", "L1");
    expect(spec.optionsExactly).toBe(4);
    expect(spec.cognitiveLevel).toContain("remember");
  });

  it("kql L3 returns tablesCountMin=2 and tablesCountMax=3", () => {
    const spec = resolveDifficulty("kql", "L3");
    expect(spec.tablesCountMin).toBe(2);
    expect(spec.tablesCountMax).toBe(3);
  });

  it("scenario L2 allowedStepDependency contains only linear", () => {
    const spec = resolveDifficulty("scenario", "L2");
    expect(spec.allowedStepDependency).toEqual(["linear"]);
  });

  it("scenario L3 allowedStepDependency contains both linear and parallel", () => {
    const spec = resolveDifficulty("scenario", "L3");
    expect(spec.allowedStepDependency).toContain("linear");
    expect(spec.allowedStepDependency).toContain("parallel");
  });

  it("subjective L3 anchorMin=4 anchorMax=6 profile=expert", () => {
    const spec = resolveDifficulty("subjective", "L3");
    expect(spec.anchorMin).toBe(4);
    expect(spec.anchorMax).toBe(6);
    expect(spec.profile).toBe("expert");
  });

  it("log_analysis L2 has no hard-gate fields", () => {
    const spec = resolveDifficulty("log_analysis", "L2");
    expect(spec.logLinesMin).toBe(10);
    expect(spec.logLinesMax).toBe(20);
    // no structural gates — these are descriptive only
    expect(spec.optionsExactly).toBeUndefined();
    expect(spec.tablesCountMin).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// functionToNice — spot checks
// ---------------------------------------------------------------------------

describe("functionToNice", () => {
  it('forensics → "Cyber Defense Forensics Analyst"', () => {
    expect(functionToNice("forensics")).toBe("Cyber Defense Forensics Analyst");
  });

  it('hunting → "Threat/Warning Analyst"', () => {
    expect(functionToNice("hunting")).toBe("Threat/Warning Analyst");
  });

  it('intelligence → "Threat/Warning Analyst"', () => {
    expect(functionToNice("intelligence")).toBe("Threat/Warning Analyst");
  });

  it('response → "Cyber Defense Incident Responder"', () => {
    expect(functionToNice("response")).toBe("Cyber Defense Incident Responder");
  });

  it('governance → "Cyber Policy and Strategy Planner"', () => {
    expect(functionToNice("governance")).toBe("Cyber Policy and Strategy Planner");
  });

  it('architecture → "Security Architect"', () => {
    expect(functionToNice("architecture")).toBe("Security Architect");
  });

  it('triage → "Cyber Defense Analyst"', () => {
    expect(functionToNice("triage")).toBe("Cyber Defense Analyst");
  });

  it('analysis → "Cyber Defense Analyst"', () => {
    expect(functionToNice("analysis")).toBe("Cyber Defense Analyst");
  });

  it('detection → "Cyber Defense Analyst"', () => {
    expect(functionToNice("detection")).toBe("Cyber Defense Analyst");
  });

  it('unknown input → "Cyber Defense Analyst" (safe default)', () => {
    expect(functionToNice("totally_unknown_function")).toBe("Cyber Defense Analyst");
    expect(functionToNice("")).toBe("Cyber Defense Analyst");
  });
});
