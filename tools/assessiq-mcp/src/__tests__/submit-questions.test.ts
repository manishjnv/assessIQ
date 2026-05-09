/**
 * Unit tests for ../tools/submit-questions.ts
 *
 * Tests the Zod schema enforcement at the MCP tool boundary: canonical shapes
 * pass, forbidden synonym field names (stem, explanation, log_snippet, etc.)
 * are rejected with isError:true and a human-readable error message.
 *
 * Run: node --import tsx/esm --test src/__tests__/submit-questions.test.ts
 * (tsx is already a devDependency; node:test is built-in for Node >=22)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleSubmitQuestions } from "../tools/submit-questions.js";

// ---------------------------------------------------------------------------
// Canonical base fixtures (valid payloads for happy-path tests)
// ---------------------------------------------------------------------------

const VALID_MCQ = {
  type: "mcq",
  topic: "Access Control Fundamentals",
  points: 2,
  knowledge_base_source_ids: ["kb-src-001"],
  content: {
    question: "Which model grants access based on the resource owner's decision?",
    options: [
      "Mandatory Access Control",
      "Discretionary Access Control",
      "Role-Based Access Control",
      "Attribute-Based Access Control",
    ],
    correct: 1,
    rationale: "DAC lets the resource owner grant or revoke access at their discretion.",
  },
};

const VALID_LOG_ANALYSIS = {
  type: "log_analysis",
  topic: "Failed Login Detection",
  points: 3,
  knowledge_base_source_ids: ["kb-src-002"],
  content: {
    question: "What threat does this log excerpt indicate?",
    log_format: "json",
    log_excerpt: '{"ts":"2024-01-01T03:00:00Z","event":"auth_fail","src":"10.0.0.5"}',
    expected_findings: [
      "Repeated authentication failure from a single source IP",
      "Timestamp pattern suggests automated brute-force activity",
    ],
    sample_solution: "The log shows a credential-stuffing or brute-force attack from 10.0.0.5.",
    hint: "Focus on the event type and the source IP repetition.",
  },
};

const VALID_SCENARIO = {
  type: "scenario",
  topic: "Incident Triage",
  points: 4,
  knowledge_base_source_ids: ["kb-src-003"],
  content: {
    title: "Ransomware Initial Triage",
    intro: "You are on-call when an alert fires for unusual file encryption activity.",
    step_dependency: "linear",
    steps: [
      { prompt: "What is your first containment action?", expected: "Isolate the affected host from the network." },
      { prompt: "What evidence should you preserve?", expected: "Memory dump and disk image before any remediation." },
    ],
  },
};

const VALID_KQL = {
  type: "kql",
  topic: "Threat Hunting with KQL",
  points: 2,
  knowledge_base_source_ids: ["kb-src-004"],
  content: {
    question: "Write a KQL query to detect sign-ins from impossible travel locations.",
    tables: ["SigninLogs"],
    expected_keywords: ["SigninLogs", "where", "IPAddress", "project"],
    sample_solution: "SigninLogs | where TimeGenerated > ago(1h) | project IPAddress, UserPrincipalName",
  },
};

const VALID_SUBJECTIVE = {
  type: "subjective",
  topic: "Threat Modelling",
  points: 3,
  knowledge_base_source_ids: ["kb-src-005"],
  content: {
    question: "Explain how STRIDE maps to common cloud misconfigurations.",
  },
};

// ---------------------------------------------------------------------------
// Helper: assert isError response
// ---------------------------------------------------------------------------
type MaybeError = { isError?: boolean; content: Array<{ type: string; text: string }> };

function assertRejected(result: MaybeError, label: string): string {
  assert.equal(result.isError, true, `${label}: expected isError:true`);
  const text = result.content[0]?.text ?? "";
  assert.ok(text.length > 0, `${label}: expected non-empty error text`);
  return text;
}

// ---------------------------------------------------------------------------
// Happy-path tests — canonical shapes must pass without isError
// ---------------------------------------------------------------------------

describe("happy paths — canonical shapes accepted", () => {
  it("canonical mcq → accepted, no isError", async () => {
    const result = (await handleSubmitQuestions({ questions: [VALID_MCQ] })) as MaybeError;
    assert.equal(result.isError, undefined, "mcq: unexpected isError");
    const text = result.content[0].text;
    assert.ok(text.includes('"accepted":true'), `mcq: expected accepted:true, got: ${text}`);
  });

  it("canonical log_analysis → accepted, no isError", async () => {
    const result = (await handleSubmitQuestions({ questions: [VALID_LOG_ANALYSIS] })) as MaybeError;
    assert.equal(result.isError, undefined, "log_analysis: unexpected isError");
    assert.ok(result.content[0].text.includes('"accepted":true'));
  });

  it("canonical scenario → accepted, no isError", async () => {
    const result = (await handleSubmitQuestions({ questions: [VALID_SCENARIO] })) as MaybeError;
    assert.equal(result.isError, undefined, "scenario: unexpected isError");
    assert.ok(result.content[0].text.includes('"accepted":true'));
  });

  it("canonical kql → accepted, no isError", async () => {
    const result = (await handleSubmitQuestions({ questions: [VALID_KQL] })) as MaybeError;
    assert.equal(result.isError, undefined, "kql: unexpected isError");
    assert.ok(result.content[0].text.includes('"accepted":true'));
  });

  it("canonical subjective → accepted, no isError", async () => {
    const result = (await handleSubmitQuestions({ questions: [VALID_SUBJECTIVE] })) as MaybeError;
    assert.equal(result.isError, undefined, "subjective: unexpected isError");
    assert.ok(result.content[0].text.includes('"accepted":true'));
  });
});

// ---------------------------------------------------------------------------
// Rejection tests — forbidden synonym field names and structural violations
// ---------------------------------------------------------------------------

describe("rejection — mcq forbidden synonyms and shape violations", () => {
  it("'stem' instead of 'question' → isError:true, error text mentions 'content'", async () => {
    const q = {
      ...VALID_MCQ,
      content: {
        stem: VALID_MCQ.content.question, // forbidden synonym
        options: VALID_MCQ.content.options,
        correct: VALID_MCQ.content.correct,
        rationale: VALID_MCQ.content.rationale,
      },
    };
    const result = (await handleSubmitQuestions({ questions: [q] })) as MaybeError;
    const text = assertRejected(result, "stem synonym");
    assert.ok(
      text.includes("content"),
      `expected 'content' path in error, got: ${text.slice(0, 300)}`,
    );
  });

  it("'explanation' synonym field → isError:true, 'explanation' named in error", async () => {
    const q = {
      ...VALID_MCQ,
      content: { ...VALID_MCQ.content, explanation: "extra synonym field" },
    };
    const result = (await handleSubmitQuestions({ questions: [q] })) as MaybeError;
    const text = assertRejected(result, "explanation synonym");
    assert.ok(
      text.includes("explanation"),
      `expected 'explanation' named in error, got: ${text.slice(0, 300)}`,
    );
  });

  it("mcq options.length=3 (not 4) → isError:true", async () => {
    const q = {
      ...VALID_MCQ,
      content: {
        ...VALID_MCQ.content,
        options: ["Option A", "Option B", "Option C"], // must be exactly 4
      },
    };
    const result = (await handleSubmitQuestions({ questions: [q] })) as MaybeError;
    assertRejected(result, "mcq 3 options");
  });

  it("mcq correct=4 (out of range 0-3) → isError:true", async () => {
    const q = {
      ...VALID_MCQ,
      content: { ...VALID_MCQ.content, correct: 4 },
    };
    const result = (await handleSubmitQuestions({ questions: [q] })) as MaybeError;
    assertRejected(result, "mcq correct out of range");
  });
});

describe("rejection — log_analysis shape violations", () => {
  it("missing log_format → isError:true", async () => {
    const { log_format: _removed, ...contentWithoutFormat } = VALID_LOG_ANALYSIS.content;
    const q = { ...VALID_LOG_ANALYSIS, content: contentWithoutFormat };
    const result = (await handleSubmitQuestions({ questions: [q] })) as MaybeError;
    assertRejected(result, "log_analysis missing log_format");
  });

  it("'log_snippet' synonym (instead of log_excerpt) → isError:true", async () => {
    const { log_excerpt: _removed, ...rest } = VALID_LOG_ANALYSIS.content;
    const q = {
      ...VALID_LOG_ANALYSIS,
      content: { ...rest, log_snippet: "synonym field" },
    };
    const result = (await handleSubmitQuestions({ questions: [q] })) as MaybeError;
    const text = assertRejected(result, "log_snippet synonym");
    assert.ok(
      text.includes("log_snippet"),
      `expected 'log_snippet' named in error, got: ${text.slice(0, 300)}`,
    );
  });

  it("expected_findings with only 1 item (min 2 required) → isError:true", async () => {
    const q = {
      ...VALID_LOG_ANALYSIS,
      content: {
        ...VALID_LOG_ANALYSIS.content,
        expected_findings: ["Only one finding"],
      },
    };
    const result = (await handleSubmitQuestions({ questions: [q] })) as MaybeError;
    assertRejected(result, "log_analysis 1 finding");
  });
});

describe("rejection — scenario shape violations", () => {
  it("'steps_dependency' typo (should be step_dependency) → isError:true", async () => {
    const { step_dependency: _removed, ...rest } = VALID_SCENARIO.content;
    const q = {
      ...VALID_SCENARIO,
      content: { ...rest, steps_dependency: "linear" }, // typo
    };
    const result = (await handleSubmitQuestions({ questions: [q] })) as MaybeError;
    assertRejected(result, "steps_dependency typo");
  });
});

describe("rejection — kql shape violations", () => {
  it("'task' synonym (instead of question) → isError:true", async () => {
    const { question: _removed, ...rest } = VALID_KQL.content;
    const q = {
      ...VALID_KQL,
      content: { ...rest, task: "synonym for question" },
    };
    const result = (await handleSubmitQuestions({ questions: [q] })) as MaybeError;
    const text = assertRejected(result, "kql task synonym");
    assert.ok(
      text.includes("task"),
      `expected 'task' named in error, got: ${text.slice(0, 300)}`,
    );
  });

  it("missing sample_solution → isError:true", async () => {
    const { sample_solution: _removed, ...rest } = VALID_KQL.content;
    const q = { ...VALID_KQL, content: rest };
    const result = (await handleSubmitQuestions({ questions: [q] })) as MaybeError;
    assertRejected(result, "kql missing sample_solution");
  });
});

describe("rejection — top-level array violations", () => {
  it("empty questions array → isError:true", async () => {
    const result = (await handleSubmitQuestions({ questions: [] })) as MaybeError;
    assertRejected(result, "empty questions array");
  });

  it("missing questions key entirely → isError:true", async () => {
    const result = (await handleSubmitQuestions({})) as MaybeError;
    assertRejected(result, "missing questions key");
  });

  it("non-array questions value → isError:true", async () => {
    const result = (await handleSubmitQuestions({ questions: "not-an-array" })) as MaybeError;
    assertRejected(result, "questions not array");
  });
});
