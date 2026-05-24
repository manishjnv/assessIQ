/**
 * Unit tests for ../tools/submit-questions.ts
 *
 * The MCP tool now applies tolerant coercion (../tools/coerce-questions.ts)
 * BEFORE strict Zod validation. So this suite covers three behaviours:
 *   1. Happy path — canonical shapes pass untouched.
 *   2. Coercion — the model's well-known non-canonical variants (stem,
 *      object-options, log_lines, prose log_format, steps_dependency, …) are
 *      normalised onto the canonical shape and ACCEPTED, with the canonical
 *      output verified.
 *   3. Genuine rejection — questions missing a required field with no synonym,
 *      or with structurally invalid values (wrong option count, out-of-range
 *      index), still fail with isError:true and a human-readable message.
 *
 * Run: node --import tsx/esm --test src/__tests__/submit-questions.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
// Helpers
// ---------------------------------------------------------------------------
type MaybeError = { isError?: boolean; content: Array<{ type: string; text: string }> };

function assertRejected(result: MaybeError, label: string): string {
  assert.equal(result.isError, true, `${label}: expected isError:true`);
  const text = result.content[0]?.text ?? "";
  assert.ok(text.length > 0, `${label}: expected non-empty error text`);
  return text;
}

/** Assert accepted, return the canonical questions echoed back by the tool. */
function acceptedQuestions(result: MaybeError, label: string): any[] {
  assert.equal(result.isError, undefined, `${label}: unexpected isError — ${result.content?.[0]?.text?.slice(0, 300)}`);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.accepted, true, `${label}: expected accepted:true`);
  return payload.questions;
}

// ---------------------------------------------------------------------------
// Happy-path tests — canonical shapes must pass without isError
// ---------------------------------------------------------------------------

describe("happy paths — canonical shapes accepted", () => {
  it("canonical mcq → accepted", async () => {
    const q = acceptedQuestions(await handleSubmitQuestions({ questions: [VALID_MCQ] }) as MaybeError, "mcq");
    assert.deepEqual(q[0].content.options, VALID_MCQ.content.options);
    assert.equal(q[0].content.correct, 1);
  });
  it("canonical log_analysis → accepted", async () => {
    acceptedQuestions(await handleSubmitQuestions({ questions: [VALID_LOG_ANALYSIS] }) as MaybeError, "log_analysis");
  });
  it("canonical scenario → accepted", async () => {
    acceptedQuestions(await handleSubmitQuestions({ questions: [VALID_SCENARIO] }) as MaybeError, "scenario");
  });
  it("canonical kql → accepted", async () => {
    acceptedQuestions(await handleSubmitQuestions({ questions: [VALID_KQL] }) as MaybeError, "kql");
  });
  it("canonical subjective → accepted", async () => {
    acceptedQuestions(await handleSubmitQuestions({ questions: [VALID_SUBJECTIVE] }) as MaybeError, "subjective");
  });
});

// ---------------------------------------------------------------------------
// Coercion — non-canonical model output is normalised and accepted
// ---------------------------------------------------------------------------

describe("coercion — mcq variants normalised", () => {
  it("'stem' → 'question'", async () => {
    const q = { ...VALID_MCQ, content: { stem: "Stem text?", options: VALID_MCQ.content.options, correct: 1, rationale: "r" } };
    const out = acceptedQuestions(await handleSubmitQuestions({ questions: [q] }) as MaybeError, "stem");
    assert.equal(out[0].content.question, "Stem text?");
  });

  it("object options + correct flag → string options + integer index", async () => {
    const q = {
      ...VALID_MCQ,
      content: {
        question: "Which is correct?",
        options: [
          { label: "A", text: "Option A", correct: false },
          { label: "B", text: "Option B", correct: true },
          { label: "C", text: "Option C", correct: false },
          { label: "D", text: "Option D", correct: false },
        ],
        rationale: "B is correct.",
      },
    };
    const out = acceptedQuestions(await handleSubmitQuestions({ questions: [q] }) as MaybeError, "object-options");
    assert.deepEqual(out[0].content.options, ["Option A", "Option B", "Option C", "Option D"]);
    assert.equal(out[0].content.correct, 1);
  });

  it("letter 'B' → index 1; 'explanation' → 'rationale'", async () => {
    const q = { ...VALID_MCQ, content: { question: "Q?", options: VALID_MCQ.content.options, correct: "B", explanation: "because B" } };
    const out = acceptedQuestions(await handleSubmitQuestions({ questions: [q] }) as MaybeError, "letter+explanation");
    assert.equal(out[0].content.correct, 1);
    assert.equal(out[0].content.rationale, "because B");
  });
});

describe("answer-key safety — fail closed (codex 2026-05-24)", () => {
  const mcqWith = (extra: Record<string, unknown>, options: unknown[] = VALID_MCQ.content.options) =>
    ({ questions: [{ ...VALID_MCQ, content: { question: "Q?", options, rationale: "r", ...extra } }] });

  it("correct as unique option TEXT → resolved to that index", async () => {
    const out = acceptedQuestions(await handleSubmitQuestions(mcqWith({ correct_answer: "Role-Based Access Control" })) as MaybeError, "text-match");
    assert.equal(out[0].content.correct, 2);
  });

  it("empty-string correct (no other signal) → rejected, NOT coerced to 0", async () => {
    assertRejected(await handleSubmitQuestions(mcqWith({ correct: "" })) as MaybeError, "empty correct");
  });

  it("quoted number '1' (0- vs 1-based ambiguous) → rejected", async () => {
    assertRejected(await handleSubmitQuestions(mcqWith({ correct: "1" })) as MaybeError, "quoted number");
  });

  it("multiple option flags set correct → rejected", async () => {
    const opts = [
      { text: "Mandatory Access Control", correct: true },
      { text: "Discretionary Access Control", correct: true },
      { text: "Role-Based Access Control", correct: false },
      { text: "Attribute-Based Access Control", correct: false },
    ];
    assertRejected(await handleSubmitQuestions(mcqWith({}, opts)) as MaybeError, "multi-flag");
  });

  it("explicit correct conflicts with option flag → rejected", async () => {
    const opts = [
      { text: "Mandatory Access Control", correct: false },
      { text: "Discretionary Access Control", correct: false },
      { text: "Role-Based Access Control", correct: true },
      { text: "Attribute-Based Access Control", correct: false },
    ];
    // correct:"A" → index 0, but the embedded flag → index 2 ⇒ conflict ⇒ fail closed.
    assertRejected(await handleSubmitQuestions(mcqWith({ correct: "A" }, opts)) as MaybeError, "conflict");
  });

  it("duplicate option-text match → rejected (ambiguous)", async () => {
    const opts = ["Same answer", "Same answer", "Other", "Else"];
    assertRejected(await handleSubmitQuestions(mcqWith({ correct_answer: "Same answer" }, opts)) as MaybeError, "dup-text");
  });

  it("present-but-unresolvable signal + a resolving flag → rejected (no silent flag-wins)", async () => {
    const opts = [
      { text: "Mandatory Access Control", correct: false },
      { text: "Discretionary Access Control", correct: true },
      { text: "Role-Based Access Control", correct: false },
      { text: "Attribute-Based Access Control", correct: false },
    ];
    // correct_answer "1" is ambiguous; a flag resolves to index 1. Must fail
    // closed because "1" might mean the first option (index 0). codex round 2.
    assertRejected(await handleSubmitQuestions(mcqWith({ correct_answer: "1" }, opts)) as MaybeError, "ambiguous+flag");
  });
});

describe("coercion — log_analysis variants normalised", () => {
  it("'log_snippet' → 'log_excerpt'", async () => {
    const { log_excerpt: _x, ...rest } = VALID_LOG_ANALYSIS.content;
    const q = { ...VALID_LOG_ANALYSIS, content: { ...rest, log_snippet: "raw log line" } };
    const out = acceptedQuestions(await handleSubmitQuestions({ questions: [q] }) as MaybeError, "log_snippet");
    assert.equal(out[0].content.log_excerpt, "raw log line");
  });

  it("'log_lines' array → joined log_excerpt string", async () => {
    const { log_excerpt: _x, ...rest } = VALID_LOG_ANALYSIS.content;
    const q = { ...VALID_LOG_ANALYSIS, content: { ...rest, log_lines: ["line1", "line2"] } };
    const out = acceptedQuestions(await handleSubmitQuestions({ questions: [q] }) as MaybeError, "log_lines");
    assert.equal(out[0].content.log_excerpt, "line1\nline2");
  });

  it("prose log_format → 'windows_event' enum", async () => {
    const q = { ...VALID_LOG_ANALYSIS, content: { ...VALID_LOG_ANALYSIS.content, log_format: "Windows Security Event Log — Event ID 4625" } };
    const out = acceptedQuestions(await handleSubmitQuestions({ questions: [q] }) as MaybeError, "prose-log_format");
    assert.equal(out[0].content.log_format, "windows_event");
  });
});

describe("coercion — scenario / kql / subjective variants normalised", () => {
  it("scenario 'steps_dependency' typo → 'step_dependency'; step 'answer' → 'expected'", async () => {
    const { step_dependency: _d, ...rest } = VALID_SCENARIO.content;
    const q = {
      ...VALID_SCENARIO,
      content: {
        ...rest,
        steps_dependency: "linear",
        steps: [{ prompt: "First action?", answer: "Isolate the host." }],
      },
    };
    const out = acceptedQuestions(await handleSubmitQuestions({ questions: [q] }) as MaybeError, "scenario-variants");
    assert.equal(out[0].content.step_dependency, "linear");
    assert.equal(out[0].content.steps[0].expected, "Isolate the host.");
  });

  it("kql 'task' → 'question'; string 'tables' → array", async () => {
    const { question: _q, tables: _t, ...rest } = VALID_KQL.content;
    const q = { ...VALID_KQL, content: { ...rest, task: "Write a query.", tables: "SecurityEvent" } };
    const out = acceptedQuestions(await handleSubmitQuestions({ questions: [q] }) as MaybeError, "kql-variants");
    assert.equal(out[0].content.question, "Write a query.");
    assert.deepEqual(out[0].content.tables, ["SecurityEvent"]);
  });

  it("subjective 'prompt' → 'question'", async () => {
    const q = { ...VALID_SUBJECTIVE, content: { prompt: "Explain STRIDE." } };
    const out = acceptedQuestions(await handleSubmitQuestions({ questions: [q] }) as MaybeError, "subjective-prompt");
    assert.equal(out[0].content.question, "Explain STRIDE.");
  });

  it("stray wrapper-level key 'difficulty' is dropped (not rejected)", async () => {
    const q = { ...VALID_MCQ, difficulty: "hard", skill_level: "L2" };
    const out = acceptedQuestions(await handleSubmitQuestions({ questions: [q] }) as MaybeError, "wrapper-extra");
    assert.equal(out[0].difficulty, undefined);
    assert.equal(out[0].skill_level, undefined);
  });
});

// ---------------------------------------------------------------------------
// Rejection — genuinely incomplete / structurally invalid (no synonym to map)
// ---------------------------------------------------------------------------

describe("rejection — structural violations not fixable by coercion", () => {
  it("mcq with 3 options → isError", async () => {
    const q = { ...VALID_MCQ, content: { ...VALID_MCQ.content, options: ["A", "B", "C"] } };
    assertRejected(await handleSubmitQuestions({ questions: [q] }) as MaybeError, "mcq 3 options");
  });

  it("mcq correct=4 (out of range) → isError", async () => {
    const q = { ...VALID_MCQ, content: { ...VALID_MCQ.content, correct: 4 } };
    assertRejected(await handleSubmitQuestions({ questions: [q] }) as MaybeError, "mcq correct OOR");
  });

  it("mcq missing question AND options (only a topic-less stem fragment) → isError", async () => {
    const q = { ...VALID_MCQ, content: { rationale: "only rationale present" } };
    assertRejected(await handleSubmitQuestions({ questions: [q] }) as MaybeError, "mcq missing fields");
  });

  it("log_analysis missing log_format (no synonym) → isError", async () => {
    const { log_format: _f, ...rest } = VALID_LOG_ANALYSIS.content;
    assertRejected(await handleSubmitQuestions({ questions: [{ ...VALID_LOG_ANALYSIS, content: rest }] }) as MaybeError, "missing log_format");
  });

  it("log_analysis expected_findings with 1 item (min 2) → isError", async () => {
    const q = { ...VALID_LOG_ANALYSIS, content: { ...VALID_LOG_ANALYSIS.content, expected_findings: ["only one"] } };
    assertRejected(await handleSubmitQuestions({ questions: [q] }) as MaybeError, "1 finding");
  });

  it("kql missing sample_solution (no synonym) → isError", async () => {
    const { sample_solution: _s, ...rest } = VALID_KQL.content;
    assertRejected(await handleSubmitQuestions({ questions: [{ ...VALID_KQL, content: rest }] }) as MaybeError, "missing sample_solution");
  });
});

describe("rejection — top-level array violations", () => {
  it("empty questions array → isError", async () => {
    assertRejected(await handleSubmitQuestions({ questions: [] }) as MaybeError, "empty array");
  });
  it("missing questions key → isError", async () => {
    assertRejected(await handleSubmitQuestions({}) as MaybeError, "missing key");
  });
  it("non-array questions value → isError", async () => {
    assertRejected(await handleSubmitQuestions({ questions: "not-an-array" }) as MaybeError, "not array");
  });
});

// ---------------------------------------------------------------------------
// Rejection logger — JSONL file output (uncoercible payload still rejects+logs)
// ---------------------------------------------------------------------------

describe("rejection logger — JSONL file output", () => {
  let tmpLog: string;

  before(() => {
    tmpLog = path.join(os.tmpdir(), `mcp-rejections-test-${Date.now()}.log`);
    process.env.MCP_REJECTION_LOG = tmpLog;
  });

  after(() => {
    delete process.env.MCP_REJECTION_LOG;
    try { fs.unlinkSync(tmpLog); } catch { /* ignore */ }
  });

  const flush = () => new Promise<void>((r) => setTimeout(r, 50));
  // content with only a stem → question coerced, but options/correct/rationale
  // remain missing → still rejected → a log line is written.
  const badPayload = () => ({ questions: [{ ...VALID_MCQ, content: { stem: "bad" } }] });

  it("rejection writes a JSONL line to the configured log path", async () => {
    assertRejected(await handleSubmitQuestions(badPayload()) as MaybeError, "logger basic write");
    await flush();
    const raw = fs.readFileSync(tmpLog, "utf8").trim();
    assert.ok(raw.length > 0, "log file must not be empty after rejection");
    const line = JSON.parse(raw.split("\n").at(-1)!);
    assert.ok(typeof line.timestamp === "string", "entry must have timestamp");
    assert.ok(typeof line.pid === "number", "entry must have pid");
    assert.ok(typeof line.type === "string", "entry must have type");
    assert.ok(typeof line.issues === "string", "entry must have issues");
    assert.ok(typeof line.payload_excerpt === "string", "entry must have payload_excerpt");
  });

  it("payload_excerpt is truncated to ≤2048 chars", async () => {
    const big = "x".repeat(5000);
    await handleSubmitQuestions({ questions: [{ ...VALID_MCQ, content: { stem: big } }] });
    await flush();
    const line = JSON.parse(fs.readFileSync(tmpLog, "utf8").trim().split("\n").at(-1)!);
    assert.ok(line.payload_excerpt.length <= 2048, `payload_excerpt must be ≤2048, got ${line.payload_excerpt.length}`);
  });

  it("concurrent rejections don't interleave JSON lines", async () => {
    await Promise.all(Array.from({ length: 10 }, () => handleSubmitQuestions(badPayload())));
    await flush();
    const lines = fs.readFileSync(tmpLog, "utf8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), `Line is not valid JSON: ${line.slice(0, 80)}`);
    }
  });

  it("rejection logger — JSONL log does not include the inline example", async () => {
    await handleSubmitQuestions(badPayload());
    await flush();
    const line = JSON.parse(fs.readFileSync(tmpLog, "utf8").trim().split("\n").filter(Boolean).at(-1)!);
    assert.ok(!line.issues.includes("CORRECT SHAPE EXAMPLE"), "JSONL log must NOT include inline example");
  });

  it("write failure → rejection response still returned, only stderr gets the error", async () => {
    process.env.MCP_REJECTION_LOG = "/no-such-dir/mcp-rejections.log";
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr) as typeof process.stderr.write;
    process.stderr.write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    };
    try {
      assertRejected(await handleSubmitQuestions(badPayload()) as MaybeError, "write failure — response");
      await flush();
      assert.ok(stderrChunks.join("").includes("rejection-log write failed"), "expected write-failure on stderr");
    } finally {
      process.stderr.write = origWrite;
      process.env.MCP_REJECTION_LOG = tmpLog;
    }
  });
});

// ---------------------------------------------------------------------------
// Inline canonical example in model-facing rejection messages (D2)
// Uses genuinely-uncoercible payloads so a rejection (with example) still fires.
// ---------------------------------------------------------------------------

describe("rejection — inline canonical example in error message", () => {
  it("mcq example block present when required fields missing", async () => {
    const q = { ...VALID_MCQ, content: { stem: "bad field name" } };
    const text = assertRejected(await handleSubmitQuestions({ questions: [q] }) as MaybeError, "mcq example");
    assert.ok(text.includes("CORRECT SHAPE EXAMPLE for type 'mcq'"), `got: ${text.slice(0, 400)}`);
  });

  it("log_analysis example block present when log_format missing", async () => {
    const { log_format: _f, ...rest } = VALID_LOG_ANALYSIS.content;
    const text = assertRejected(await handleSubmitQuestions({ questions: [{ ...VALID_LOG_ANALYSIS, content: rest }] }) as MaybeError, "log_analysis example");
    assert.ok(text.includes("CORRECT SHAPE EXAMPLE for type 'log_analysis'"), `got: ${text.slice(0, 400)}`);
  });

  it("scenario example block present when steps missing", async () => {
    const { steps: _s, ...rest } = VALID_SCENARIO.content;
    const text = assertRejected(await handleSubmitQuestions({ questions: [{ ...VALID_SCENARIO, content: rest }] }) as MaybeError, "scenario example");
    assert.ok(text.includes("CORRECT SHAPE EXAMPLE for type 'scenario'"), `got: ${text.slice(0, 400)}`);
  });

  it("kql example block present when sample_solution + tables missing", async () => {
    const text = assertRejected(await handleSubmitQuestions({ questions: [{ ...VALID_KQL, content: { question: "Q only" } }] }) as MaybeError, "kql example");
    assert.ok(text.includes("CORRECT SHAPE EXAMPLE for type 'kql'"), `got: ${text.slice(0, 400)}`);
  });

  it("subjective example block present when content is empty", async () => {
    const text = assertRejected(await handleSubmitQuestions({ questions: [{ ...VALID_SUBJECTIVE, content: {} }] }) as MaybeError, "subjective example");
    assert.ok(text.includes("CORRECT SHAPE EXAMPLE for type 'subjective'"), `got: ${text.slice(0, 400)}`);
  });
});
