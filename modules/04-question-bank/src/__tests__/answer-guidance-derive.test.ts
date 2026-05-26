/**
 * Unit tests for deriveQuestionTextForGuidance (feature #4, Phase B).
 *
 * The safety-critical property: the string handed to the answer-guidance
 * generator must NEVER contain the answer key. Pure logic — no DB.
 */
import { describe, it, expect } from "vitest";
import { deriveQuestionTextForGuidance } from "../answer-guidance-derive.js";

describe("deriveQuestionTextForGuidance — answer-key-free", () => {
  it("mcq: keeps the stem, omits options/correct/rationale", () => {
    const out = deriveQuestionTextForGuidance({
      type: "mcq",
      content: {
        question: "Which access-control model is owner-driven?",
        options: ["MAC", "DAC", "RBAC", "ABAC"],
        correct: 1,
        rationale: "DAC lets the owner decide.",
      },
    });
    expect(out).toBe("Which access-control model is owner-driven?");
    expect(out).not.toContain("DAC");
    expect(out).not.toContain("owner decide");
    expect(out).not.toMatch(/rationale|correct/i);
  });

  it("log_analysis: keeps question + log_format, omits expected_findings/sample_solution/log_excerpt", () => {
    const out = deriveQuestionTextForGuidance({
      type: "log_analysis",
      content: {
        question: "Identify the suspicious activity.",
        log_format: "syslog",
        log_excerpt: "Jan 1 00:00:00 host sshd[1]: Failed password for root",
        expected_findings: ["brute-force on root", "EventID 4625 spike"],
        sample_solution: "The attacker brute-forced the root account.",
        hint: "look at failed logins",
      },
    });
    expect(out).toContain("Identify the suspicious activity.");
    expect(out).toContain("syslog");
    expect(out).not.toContain("brute-force");
    expect(out).not.toContain("4625");
    expect(out).not.toContain("Failed password");
    expect(out).not.toContain("attacker brute-forced");
  });

  it("scenario: keeps title/intro/step prompts, omits steps[].expected", () => {
    const out = deriveQuestionTextForGuidance({
      type: "scenario",
      content: {
        title: "Phishing triage",
        intro: "A user reports a suspicious email.",
        step_dependency: "linear",
        steps: [
          { prompt: "What is your first action?", expected: "Isolate the mailbox and pull headers." },
          { prompt: "How do you confirm compromise?", expected: "Check sign-in logs for the user." },
        ],
      },
    });
    expect(out).toContain("Phishing triage");
    expect(out).toContain("What is your first action?");
    expect(out).toContain("How do you confirm compromise?");
    expect(out).not.toContain("Isolate the mailbox");
    expect(out).not.toContain("sign-in logs");
  });

  it("subjective/kql: stem only", () => {
    expect(
      deriveQuestionTextForGuidance({ type: "subjective", content: { question: "Explain defense in depth." } }),
    ).toBe("Explain defense in depth.");
    expect(
      deriveQuestionTextForGuidance({ type: "kql", content: { question: "Find failed sign-ins.", tables: ["SigninLogs"] } }),
    ).toBe("Find failed sign-ins.");
  });

  it("never throws on malformed/empty content", () => {
    expect(deriveQuestionTextForGuidance({ type: "mcq", content: null })).toBe("");
    expect(deriveQuestionTextForGuidance({ type: "scenario", content: {} })).toBe("");
    expect(deriveQuestionTextForGuidance({ type: "weird", content: { question: "x" } })).toBe("x");
  });
});
