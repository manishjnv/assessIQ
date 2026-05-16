/**
 * Pure unit tests for sanitizeContentForCandidate.
 * No database, no testcontainer — the sanitizer is a pure function.
 */

import { describe, it, expect } from "vitest";
import { sanitizeContentForCandidate } from "../repository.js";

describe("sanitizeContentForCandidate", () => {
  // 1. mcq — strips correct + rationale, keeps question + options
  it("mcq: keeps question and options, strips correct and rationale", () => {
    const input = { question: "What is 2+2?", options: ["1", "2", "4"], correct: 2, rationale: "x" };
    const output = sanitizeContentForCandidate("mcq", input) as Record<string, unknown>;
    expect(output).toEqual({ question: "What is 2+2?", options: ["1", "2", "4"] });
    expect(output).not.toHaveProperty("correct");
    expect(output).not.toHaveProperty("rationale");
  });

  // 2. log_analysis — strips expected_findings + sample_solution, keeps the four allowed keys
  it("log_analysis: keeps question/log_format/log_excerpt/hint, strips expected_findings and sample_solution", () => {
    const input = {
      question: "Analyze this log",
      log_format: "syslog",
      log_excerpt: "May 16 ...",
      hint: "Look at timestamps",
      expected_findings: ["finding1"],
      sample_solution: "do X",
    };
    const output = sanitizeContentForCandidate("log_analysis", input) as Record<string, unknown>;
    expect(output).toEqual({
      question: "Analyze this log",
      log_format: "syslog",
      log_excerpt: "May 16 ...",
      hint: "Look at timestamps",
    });
    expect(output).not.toHaveProperty("expected_findings");
    expect(output).not.toHaveProperty("sample_solution");
  });

  // 3. kql — strips expected_keywords + sample_solution, keeps question + tables
  it("kql: keeps question and tables, strips expected_keywords and sample_solution", () => {
    const input = {
      question: "Write a KQL query",
      tables: ["SecurityEvent"],
      expected_keywords: ["where", "count"],
      sample_solution: "SecurityEvent | count",
    };
    const output = sanitizeContentForCandidate("kql", input) as Record<string, unknown>;
    expect(output).toEqual({ question: "Write a KQL query", tables: ["SecurityEvent"] });
    expect(output).not.toHaveProperty("expected_keywords");
    expect(output).not.toHaveProperty("sample_solution");
  });

  // 4. scenario — steps have expected stripped, title/intro/step_dependency kept
  it("scenario: strips expected from each step, keeps prompt; keeps title/intro/step_dependency", () => {
    const input = {
      title: "Incident Response",
      intro: "You are a SOC analyst",
      step_dependency: true,
      steps: [
        { prompt: "p1", expected: "e1" },
        { prompt: "p2", expected: "e2" },
      ],
    };
    const output = sanitizeContentForCandidate("scenario", input) as Record<string, unknown>;
    expect(output).toEqual({
      title: "Incident Response",
      intro: "You are a SOC analyst",
      step_dependency: true,
      steps: [{ prompt: "p1" }, { prompt: "p2" }],
    });
    const steps = output["steps"] as Array<Record<string, unknown>>;
    expect(steps[0]).not.toHaveProperty("expected");
    expect(steps[1]).not.toHaveProperty("expected");
  });

  // 5. subjective — only question survives
  it("subjective: keeps only question, strips everything else", () => {
    const input = { question: "Explain XSS", foo: "bar" };
    const output = sanitizeContentForCandidate("subjective", input) as Record<string, unknown>;
    expect(output).toEqual({ question: "Explain XSS" });
    expect(output).not.toHaveProperty("foo");
  });

  // 6. unknown type — fail-closed, keeps question only
  it("unknown type 'phishing': keeps only question, strips correct and secret", () => {
    const input = { question: "What is phishing?", correct: 1, secret: "x" };
    const output = sanitizeContentForCandidate("phishing", input) as Record<string, unknown>;
    expect(output).toEqual({ question: "What is phishing?" });
    expect(output).not.toHaveProperty("correct");
    expect(output).not.toHaveProperty("secret");
  });

  // 7. malformed input — null and string pass through unchanged, no throw
  it("malformed: null returns null without throwing", () => {
    expect(() => sanitizeContentForCandidate("mcq", null)).not.toThrow();
    expect(sanitizeContentForCandidate("mcq", null)).toBeNull();
  });

  it("malformed: string returns string without throwing", () => {
    expect(() => sanitizeContentForCandidate("mcq", "str")).not.toThrow();
    expect(sanitizeContentForCandidate("mcq", "str")).toBe("str");
  });

  // 8. immutability — original input object is not mutated
  it("immutability: original input object is unchanged after call", () => {
    const original = {
      question: "What?",
      options: ["a", "b"],
      correct: 0,
      rationale: "because",
    };
    const clone = JSON.parse(JSON.stringify(original));
    sanitizeContentForCandidate("mcq", original);
    // original must be deeply equal to its pre-call state
    expect(original).toEqual(clone);
    // output must be a fresh object (not the same reference)
    const output = sanitizeContentForCandidate("mcq", original);
    expect(output).not.toBe(original);
  });

  // 9. missing-key safety — mcq with no options key → does not fabricate options
  it("missing-key safety: mcq with only question does not fabricate options", () => {
    const input = { question: "Solo question" };
    const output = sanitizeContentForCandidate("mcq", input) as Record<string, unknown>;
    expect(output).toEqual({ question: "Solo question" });
    expect(output).not.toHaveProperty("options");
  });
});
