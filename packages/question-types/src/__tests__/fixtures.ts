import type { QuestionType } from "../registry.js";

/** Three sample contents per type: two valid, one sparse/odd (extra keys, missing keys). */
export const CONTENTS: Record<QuestionType, unknown[]> = {
  mcq: [
    { question: "Which port is HTTPS?", options: ["80", "443", "22", "25"], correct: 1, rationale: "TLS on 443" },
    { question: "Pick one", options: ["a", "b"], correct: 0, rationale: "r", extra: "x" },
    { question: "No key", options: ["a", "b", "c", "d"] },
  ],
  subjective: [
    { question: "Explain least privilege." },
    { question: "Explain RLS.", rubric_hint: "secret" },
    {},
  ],
  kql: [
    { question: "Failed logons", tables: ["SigninLogs"], hint: "h", expected_keywords: ["where", "summarize"], sample_solution: "SigninLogs | where x" },
    { question: "q", tables: ["A", "B"], expected_keywords: ["join"] },
    { question: "q" },
  ],
  scenario: [
    {
      title: "Phish", intro: "A user clicked.", step_dependency: "linear",
      steps: [
        { id: "s1", type: "mcq", prompt: "First action?", options: ["isolate", "ignore"], correct: 0, trap: true },
        { id: "s2", type: "subjective", prompt: "Write the report", rubric_ref: "r" },
        { id: "s3", type: "kql", prompt: "Hunt", expected_keywords: ["where"] },
      ],
    },
    { title: "Gen", intro: "i", steps: [{ prompt: "p1", expected: "e1" }, { prompt: "p2", expected: "  " }, "plain", null] },
    { title: "No steps", intro: "i", steps: "oops" },
  ],
  log_analysis: [
    { question: "Find the attacker", log_excerpt: "line1\nline2", log_format: "syslog", expected_findings: ["bruteforce", "ip 1.2.3.4"], hint: "h", sample_solution: "s" },
    { question: "q", log_excerpt: "{}", log_format: "json", expected_findings: ["one"] },
    { question: "q" },
  ],
  numeric: [
    { question: "2+2", answer: 4, tolerance: 0.5, unit: "u", rationale: "r" },
    { question: "pi", answer: 3.14 },
    { question: "bad", answer: "x" },
  ],
  multi_select: [
    { question: "Pick two", options: ["a", "b", "c", "d", "e"], correct: [0, 2], scoring: "partial", rationale: "r" },
    { question: "Pick", options: ["a", "b", "c"], correct: [1] },
    { question: "bad", options: ["a", "b"], correct: [] },
  ],
  ordering: [
    { question: "Order", items: ["a", "b", "c", "d"], correct_order: [2, 0, 3, 1], scoring: "partial", explanation: "e" },
    { question: "Order2", items: ["x", "y"], correct_order: [1, 0] },
    { question: "bad", items: ["x", "y"], correct_order: [0, 0] },
  ],
  structured_case: [
    {
      title: "Case", context: "ctx", log_excerpt: "log", scoring: "partial", explanation: "e",
      steps: [
        { id: "a", prompt: "p", select: "one", options: ["x", "y", "z"], correct: [1] },
        { id: "b", prompt: "q", select: "many", options: ["x", "y", "z"], correct: [0, 2] },
      ],
    },
    {
      title: "Case2", context: "ctx", scoring: "all_or_nothing",
      steps: [{ id: "a", prompt: "p", select: "one", options: ["x", "y"], correct: [0] }],
    },
    { title: "Case3", context: "c", steps: [null, { id: "z" }] },
  ],
};

/** Answers per deterministic type: correct, partly right, wrong, malformed. */
export const ANSWERS: Partial<Record<QuestionType, unknown[]>> = {
  mcq: [{ selected: 1 }, 1, { selected: 0 }, null, "1", { selected: 1.5 }, [1], { selected: 99 }],
  numeric: [4, "4", { value: 4.4 }, "4,0", 5, "abc", null, { value: "4" }, 3.14, "1,250"],
  multi_select: [[0, 2], { selected: [2, 0] }, [0], [0, 1], [], [0, 0], "x", null, [1], { selected: [1] }],
  ordering: [{ order: [2, 0, 3, 1] }, { order: [0, 1, 2, 3] }, { order: [2, 0, 1, 3] }, { order: [1, 0] }, [2, 0, 3, 1], null, { order: [0, 0] }],
  structured_case: [
    { steps: { a: [1], b: [0, 2] } },
    { steps: { a: [1], b: [0] } },
    { steps: { a: [0], b: [1] } },
    { steps: { a: [0] } },
    { steps: { nope: [0] } },
    { steps: { a: [1, 0] } },
    {},
    null,
  ],
};

/** Raw generator output per type, for coerceContent. */
export const RAW: Record<QuestionType, Record<string, unknown>[]> = {
  mcq: [
    { stem: "S", choices: [{ text: "a" }, { text: "b", is_correct: true }, "c", "d"], explanation: "why" },
    { question: "Q", options: ["a", "b", "c", "d"], correct_option: "B", rationale: "r" },
    { question: "Q", options: ["a", "b", "c"], correct: "2", answer: 1 },
  ],
  subjective: [{ stem: "S" }, { prompt: "P", junk: 1 }, {}],
  kql: [
    { task: "T", table: "SigninLogs", keywords: [{ keyword: "where" }, "join"], model_answer: "x" },
    { question: "Q", tables: [{ name: "A" }, "B"], expected_keywords: ["k"] },
    { question: "Q", data_tables: "T" },
  ],
  scenario: [
    { name: "N", description: "D", dependency: "sequential", tasks: [{ question: "p", answer: "e" }, "plain"] },
    { title: "T", intro: "I", step_dependency: true, steps: [{ prompt: "p", expected: "e" }] },
    { title: "T", scenario: "S", steps_dependency: "tree", parts: "oops" },
  ],
  log_analysis: [
    { stem: "S", format: "Windows Event ID 4625", logs: ["l1", { a: 1 }], findings: [{ finding: "f" }, "g"], hints: ["a", "b"] },
    { question: "Q", log_type: "rfc 5424", log_excerpt: "l", expected_findings: ["f"], solution: "s" },
    { question: "Q", log_format: 7, log: "x" },
  ],
  numeric: [{ question: "Q", answer: 1, alias: "kept" }, {}, { a: [1] }],
  multi_select: [{ question: "Q", options: ["a", "b"], correct: [0] }, {}, { choices: ["a"] }],
  ordering: [{ question: "Q", items: ["a", "b"], correct_order: [1, 0] }, {}, { steps: [1] }],
  structured_case: [{ title: "T", context: "C", steps: [] }, {}, { prompt: "p" }],
};
