import { describe, expect, it } from "vitest";
import { QUESTION_TYPES, coerceContentFor } from "@assessiq/question-types";
import { coerceQuestion } from "../../../../tools/assessiq-mcp/src/tools/coerce-questions.js";
import { rubricRequiredFor } from "../types.js";
import { GENERATED_TYPES, validateStructuralDifficulty } from "../difficulty-spec.js";

describe("RW-68 stage 2A rewrites", () => {
  it("rubricRequiredFor pins subjective and scenario only", () => {
    expect(QUESTION_TYPES.filter(rubricRequiredFor)).toEqual(["subjective", "scenario"]);
  });

  it("GENERATED_TYPES is the five generator-skill types", () => {
    expect([...GENERATED_TYPES].sort()).toEqual(["kql", "log_analysis", "mcq", "scenario", "subjective"]);
  });

  it("hand-authored types have no structural difficulty gate", () => {
    for (const t of ["numeric", "multi_select", "ordering", "structured_case"] as const) {
      expect(validateStructuralDifficulty(t, "L1", {}, null)).toEqual({ ok: true });
    }
  });

  it("MCP standalone coerce stays in parity with the registry", () => {
    const raw: Record<string, Record<string, unknown>> = {
      mcq: { stem: "Q?", options: ["a", "b", "c", "d"], answer: "b", explanation: "r" },
      subjective: { stem: "Explain", extra: 1 },
      kql: { task: "Find", table: "T", keywords: ["x"], query: "T | take 1" },
      scenario: { title: "t", intro: "i", steps: [{ prompt: "p", expected: "e" }] },
      log_analysis: { question: "q", log_format: "syslog", log_lines: "l", expected_findings: ["f"] },
    };
    for (const [type, content] of Object.entries(raw)) {
      const viaMcp = (coerceQuestion({ type, topic: "t", points: 1, content }) as { content: unknown }).content;
      expect(viaMcp, type).toEqual(coerceContentFor(type, content));
    }
  });
});
