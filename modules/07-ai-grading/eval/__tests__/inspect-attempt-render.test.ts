/**
 * Pure rendering tests for the inspect-attempt subcommand.
 *
 * No Docker, no DATABASE_URL, no real DB — these tests exercise
 * renderAttemptReport() directly with synthetic AttemptDiagnostic fixtures.
 *
 * Test cases:
 *   1. Happy path partial attempt: "Chunks: planned=5 failed=2" in output.
 *   2. Default (--show-stderr false): stderrTail NOT in output.
 *   3. --show-stderr true: stderrTail block IS in output.
 *   4. --show-questions true: question contentKeys printed.
 *   5. Per-type summary groups by type; missing types show "— (chunk failed)".
 */

import { describe, it, expect } from "vitest";
import { renderAttemptReport } from "../cli-typed.js";
import type { AttemptDiagnostic } from "../runner.js";

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

function makeAttempt(overrides: Partial<AttemptDiagnostic> = {}): AttemptDiagnostic {
  return {
    id: "019e0deb-4dcf-70b1-83fe-8c88e20b7b62",
    packId: "019df000-0000-0000-0000-000000000001",
    levelId: "019df008-0000-0000-0000-000000000001",
    status: "partial",
    countRequested: 15,
    countInserted: 8,
    chunksPlanned: 5,
    chunksFailed: 2,
    dedupeDropped: 0,
    citationDropped: 0,
    errorCode: "PARTIAL_SUCCESS",
    errorMessage: "2 chunks failed to produce questions",
    stderrTail: "[claude.subprocess.summary] exit=1 duration=7320ms skill=log_analysis",
    skillSha: "25c28a16abcd,d90a077f1234,eb268094efgh",
    model: "claude-sonnet-4-6",
    durationMs: 816000, // 13m 36s
    startedAt: "2026-05-09T18:05:51.000Z",
    finishedAt: "2026-05-09T18:20:07.000Z",
    insertedQuestions: [
      {
        id: "qid-001",
        type: "mcq",
        topic: "PowerShell obfuscation",
        points: 5,
        contentKeys: ["question", "options", "correct", "rationale"],
        knowledgeBaseSourceIds: ["src-001", "src-002"],
        createdAt: "2026-05-09T18:06:00.000Z",
      },
      {
        id: "qid-002",
        type: "mcq",
        topic: "Pass-the-hash logon",
        points: 5,
        contentKeys: ["question", "options", "correct", "rationale"],
        knowledgeBaseSourceIds: ["src-003"],
        createdAt: "2026-05-09T18:06:10.000Z",
      },
      {
        id: "qid-003",
        type: "mcq",
        topic: "NTLM relay attack",
        points: 5,
        contentKeys: ["question", "options", "correct", "rationale"],
        knowledgeBaseSourceIds: ["src-001"],
        createdAt: "2026-05-09T18:06:20.000Z",
      },
      {
        id: "qid-004",
        type: "mcq",
        topic: "Kerberoasting detection",
        points: 5,
        contentKeys: ["question", "options", "correct", "rationale"],
        knowledgeBaseSourceIds: ["src-004"],
        createdAt: "2026-05-09T18:06:30.000Z",
      },
      {
        id: "qid-005",
        type: "mcq",
        topic: "DCSync privilege escalation",
        points: 5,
        contentKeys: ["question", "options", "correct", "rationale"],
        knowledgeBaseSourceIds: ["src-002"],
        createdAt: "2026-05-09T18:06:40.000Z",
      },
      {
        id: "qid-006",
        type: "kql",
        topic: "Beacon jitter detection",
        points: 10,
        contentKeys: ["question", "tables", "expected_keywords", "sample_solution"],
        knowledgeBaseSourceIds: ["src-005"],
        createdAt: "2026-05-09T18:10:00.000Z",
      },
      {
        id: "qid-007",
        type: "kql",
        topic: "Lateral movement via WMI",
        points: 10,
        contentKeys: ["question", "tables", "expected_keywords", "sample_solution"],
        knowledgeBaseSourceIds: ["src-006"],
        createdAt: "2026-05-09T18:10:10.000Z",
      },
      {
        id: "qid-008",
        type: "subjective",
        topic: "Compare DCSync vs DCShadow",
        points: 15,
        contentKeys: ["question"],
        knowledgeBaseSourceIds: ["src-007"],
        createdAt: "2026-05-09T18:15:00.000Z",
      },
      // log_analysis and scenario have 0 inserted — chunk failure
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("renderAttemptReport", () => {
  it("happy path partial: report includes Chunks planned=5 failed=2", () => {
    const d = makeAttempt();
    const report = renderAttemptReport(d, { showStderr: false, showQuestions: false });

    expect(report).toContain("Chunks: planned=5 failed=2");
    expect(report).toContain("Status: partial");
    expect(report).toContain("Counts: requested=15 inserted=8");
    expect(report).toContain("019e0deb-4dcf-70b1-83fe-8c88e20b7b62");
  });

  it("default (showStderr=false): stderrTail NOT in output", () => {
    const d = makeAttempt();
    const report = renderAttemptReport(d, { showStderr: false, showQuestions: false });

    expect(report).not.toContain("--- stderr_tail ---");
    expect(report).not.toContain("claude.subprocess.summary");
  });

  it("showStderr=true: stderrTail block IS in output with delimiter banners", () => {
    const d = makeAttempt();
    const report = renderAttemptReport(d, { showStderr: true, showQuestions: false });

    expect(report).toContain("--- stderr_tail ---");
    expect(report).toContain("--- end stderr_tail ---");
    expect(report).toContain("claude.subprocess.summary");
  });

  it("showStderr=true with null stderrTail: prints (none)", () => {
    const d = makeAttempt({ stderrTail: null });
    const report = renderAttemptReport(d, { showStderr: true, showQuestions: false });

    expect(report).toContain("--- stderr_tail ---");
    expect(report).toContain("(none)");
  });

  it("showQuestions=true: prints question contentKeys", () => {
    const d = makeAttempt();
    const report = renderAttemptReport(d, { showStderr: false, showQuestions: true });

    expect(report).toContain("contentKeys");
    expect(report).toContain("question, options, correct, rationale");
    // subjective question should show its single key
    expect(report).toContain("question");
    expect(report).toContain("knowledgeBaseSources");
  });

  it("per-type summary: groups by type, missing types show chunk-failed label", () => {
    const d = makeAttempt();
    const report = renderAttemptReport(d, { showStderr: false, showQuestions: false });

    // mcq: 5 inserted
    expect(report).toMatch(/mcq\s+5/);
    // kql: 2 inserted
    expect(report).toMatch(/kql\s+2/);
    // subjective: 1 inserted
    expect(report).toMatch(/subjective\s+1/);
    // log_analysis and scenario: 0 inserted + chunks_failed > 0 → chunk failed
    expect(report).toContain("— (chunk failed)");
    // Both missing types should appear in the table
    expect(report).toContain("log_analysis");
    expect(report).toContain("scenario");
  });

  it("per-type summary: no chunk failures → missing types show plain dash", () => {
    const d = makeAttempt({ chunksPlanned: 0, chunksFailed: 0 });
    const report = renderAttemptReport(d, { showStderr: false, showQuestions: false });

    expect(report).not.toContain("— (chunk failed)");
    // Should still list all types
    expect(report).toContain("log_analysis");
    expect(report).toContain("scenario");
  });

  it("duration formats correctly: 13m 36s for 816000ms", () => {
    const d = makeAttempt({ durationMs: 816000 });
    const report = renderAttemptReport(d, { showStderr: false, showQuestions: false });
    expect(report).toContain("13m 36s");
  });

  it("skill SHAs are truncated to 8 chars and comma-separated", () => {
    const d = makeAttempt();
    const report = renderAttemptReport(d, { showStderr: false, showQuestions: false });
    expect(report).toContain("25c28a16");
    expect(report).toContain("d90a077f");
    expect(report).toContain("eb268094");
  });

  it("error line present when errorCode and errorMessage are set", () => {
    const d = makeAttempt();
    const report = renderAttemptReport(d, { showStderr: false, showQuestions: false });
    expect(report).toContain("Error: PARTIAL_SUCCESS: 2 chunks failed");
  });

  it("no error line when errorCode and errorMessage are null", () => {
    const d = makeAttempt({ errorCode: null, errorMessage: null });
    const report = renderAttemptReport(d, { showStderr: false, showQuestions: false });
    expect(report).not.toContain("Error:");
  });
});
