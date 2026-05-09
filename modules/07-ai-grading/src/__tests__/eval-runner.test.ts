// AssessIQ — modules/07-ai-grading/src/__tests__/eval-runner.test.ts
//
// Unit tests for eval/runner.ts — scoreQuestion().
// All tests use inline fixture data; no file I/O.

import { describe, it, expect } from "vitest";
import { scoreQuestion } from "../../eval/runner.js";
import type { GoldenQuestion, KbSourceRef } from "../../eval/runner.js";

// ---------------------------------------------------------------------------
// Shared inline fixtures
// ---------------------------------------------------------------------------

const SOURCES: KbSourceRef[] = [
  {
    id: "src_test_001",
    name: "Test Source A",
    citation: "Test Citation A, 2026",
    url: "https://example.com/a",
    level_fit: "L2",
    function: "detection",
    description: "A KB source for unit testing.",
    tags: ["test", "sysmon"],
    kb_version: "2026-05-09",
  },
  {
    id: "src_test_002",
    name: "Test Source B",
    citation: "Test Citation B, 2026",
    url: "https://example.com/b",
    level_fit: "L2",
    function: "hunting",
    description: "Second KB source for unit testing.",
    tags: ["test", "KQL"],
    kb_version: "2026-05-09",
  },
];

// ---------------------------------------------------------------------------
// MCQ — happy path
// ---------------------------------------------------------------------------

describe("scoreQuestion — mcq happy path", () => {
  const q: GoldenQuestion = {
    type: "mcq",
    topic: "PowerShell execution technique",
    points: 5,
    content: {
      question: "Which MITRE technique maps to encoded PowerShell?",
      options: ["A. T1547.001", "B. T1059.001", "C. T1078", "D. T1021.001"],
      correct: 1,
      rationale: "T1059.001 covers PowerShell execution with -EncodedCommand obfuscation.",
    },
    knowledge_base_source_ids: ["src_test_001"],
  };

  it("returns all four checks true", () => {
    const score = scoreQuestion(q, SOURCES, 0);
    expect(score.schemaValid).toBe(true);
    expect(score.citationsResolve).toBe(true);
    expect(score.structuralCompleteness).toBe(true);
    expect(score.topicNonEmpty).toBe(true);
    expect(score.failures).toHaveLength(0);
  });

  it("synthesises id from type and index", () => {
    const score = scoreQuestion(q, SOURCES, 3);
    expect(score.id).toBe("mcq-3");
    expect(score.type).toBe("mcq");
  });
});

// ---------------------------------------------------------------------------
// MCQ — malformed: only 3 options
// ---------------------------------------------------------------------------

describe("scoreQuestion — malformed mcq (3 options)", () => {
  const q: GoldenQuestion = {
    type: "mcq",
    topic: "LOLBin detection field",
    points: 5,
    content: {
      question: "Which Sysmon field detects LOLBin abuse?",
      options: ["A. ProcessId", "B. CommandLine", "C. Hashes"], // only 3 — violates schema
      correct: 1,
      rationale: "CommandLine reveals the abuse pattern.",
    },
    knowledge_base_source_ids: ["src_test_001"],
  };

  it("fails schemaValid (options.length !== 4 violates Zod .length(4))", () => {
    const score = scoreQuestion(q, SOURCES, 0);
    expect(score.schemaValid).toBe(false);
  });

  it("structuralCompleteness is false when schemaValid fails", () => {
    const score = scoreQuestion(q, SOURCES, 0);
    expect(score.structuralCompleteness).toBe(false);
  });

  it("failures array is non-empty", () => {
    const score = scoreQuestion(q, SOURCES, 0);
    expect(score.failures.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Citation miss
// ---------------------------------------------------------------------------

describe("scoreQuestion — citation miss", () => {
  const q: GoldenQuestion = {
    type: "kql",
    topic: "KQL beacon detection",
    points: 5,
    content: {
      question: "Write a KQL query to detect C2 beaconing.",
      tables: ["DeviceNetworkEvents"],
      expected_keywords: ["DeviceNetworkEvents", "RemoteIP"],
      sample_solution: "DeviceNetworkEvents | where RemoteIP == '1.2.3.4'",
    },
    knowledge_base_source_ids: ["src_test_001", "src_unknown_999"], // src_unknown_999 not in fixture
  };

  it("fails citationsResolve when a source ID is absent from fixture", () => {
    const score = scoreQuestion(q, SOURCES, 0);
    expect(score.citationsResolve).toBe(false);
  });

  it("failure message names the missing source ID", () => {
    const score = scoreQuestion(q, SOURCES, 0);
    expect(score.failures.some((f) => f.includes("src_unknown_999"))).toBe(true);
  });

  it("other checks still run independently", () => {
    const score = scoreQuestion(q, SOURCES, 0);
    // schema is valid (kql content is correct)
    expect(score.schemaValid).toBe(true);
    // topic is non-empty
    expect(score.topicNonEmpty).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Empty / whitespace-only topic
// ---------------------------------------------------------------------------

describe("scoreQuestion — empty topic", () => {
  const q: GoldenQuestion = {
    type: "log_analysis",
    topic: "   ", // whitespace-only
    points: 5,
    content: {
      question: "Analyse the following logs.",
      log_format: "windows_event",
      log_excerpt: "EventID=4625 | TargetUserName=admin | IpAddress=1.2.3.4\nEventID=4625 | TargetUserName=root | IpAddress=1.2.3.4\nEventID=4625 | TargetUserName=user | IpAddress=1.2.3.4\nEventID=4625 | TargetUserName=svc | IpAddress=1.2.3.4",
      expected_findings: ["Password spraying", "Single source IP targeting multiple accounts"],
      sample_solution: "Single IP, multiple targets, same SubStatus → password spray.",
      hint: "Look at IpAddress and TargetUserName field distribution.",
    },
    knowledge_base_source_ids: ["src_test_001"],
  };

  it("fails topicNonEmpty", () => {
    const score = scoreQuestion(q, SOURCES, 2);
    expect(score.topicNonEmpty).toBe(false);
  });

  it("failure message references topic", () => {
    const score = scoreQuestion(q, SOURCES, 2);
    expect(score.failures.some((f) => f.includes("topic"))).toBe(true);
  });

  it("schema and citation checks still pass independently", () => {
    const score = scoreQuestion(q, SOURCES, 2);
    expect(score.schemaValid).toBe(true);
    expect(score.citationsResolve).toBe(true);
    expect(score.structuralCompleteness).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// log_analysis — structural completeness: fewer than 2 expected_findings
// ---------------------------------------------------------------------------

describe("scoreQuestion — log_analysis insufficient expected_findings", () => {
  const q: GoldenQuestion = {
    type: "log_analysis",
    topic: "Minimal findings test",
    points: 5,
    content: {
      question: "What do these logs show?",
      log_format: "syslog",
      log_excerpt: "May 9 14:00:01 host sshd[1234]: Failed password for root from 1.2.3.4\nMay 9 14:00:02 host sshd[1235]: Failed password for admin from 1.2.3.4",
      expected_findings: ["SSH brute force"], // only 1 — structuralCompleteness requires >= 2
      sample_solution: "Multiple failed SSH attempts from single IP.",
      hint: "Count the failed attempts.",
    },
    knowledge_base_source_ids: ["src_test_002"],
  };

  it("schemaValid is false (Zod .min(2) on expected_findings)", () => {
    const score = scoreQuestion(q, SOURCES, 0);
    // Zod rejects the array with length < 2, so schemaValid = false
    expect(score.schemaValid).toBe(false);
  });

  it("structuralCompleteness is also false", () => {
    const score = scoreQuestion(q, SOURCES, 0);
    expect(score.structuralCompleteness).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scenario — happy path (3 steps, linear)
// ---------------------------------------------------------------------------

describe("scoreQuestion — scenario happy path", () => {
  const q: GoldenQuestion = {
    type: "scenario",
    topic: "Ransomware containment",
    points: 10,
    content: {
      title: "Active Ransomware on WORKSTATION-01",
      intro: "At 02:14 UTC an EDR alert fires: WORKSTATION-01 is encrypting files on a network share.",
      step_dependency: "linear",
      steps: [
        { prompt: "What is your first action?", expected: "Capture volatile artefacts before isolation." },
        { prompt: "How do you contain the host?", expected: "Use EDR quarantine to network-isolate." },
        { prompt: "Which event IDs scope the file server impact?", expected: "Event 5145 and 4663." },
      ],
    },
    knowledge_base_source_ids: ["src_test_001"],
  };

  it("all four checks pass for a well-formed scenario", () => {
    const score = scoreQuestion(q, SOURCES, 0);
    expect(score.schemaValid).toBe(true);
    expect(score.citationsResolve).toBe(true);
    expect(score.structuralCompleteness).toBe(true);
    expect(score.topicNonEmpty).toBe(true);
    expect(score.failures).toHaveLength(0);
  });
});
