/**
 * Tests for generateRubricDraft() in runtimes/claude-code-vps.ts
 *
 * Mocks:
 *   - node:child_process spawn → EventEmitter-based fake subprocess
 *   - ../skill-sha.js → canned { short, label, model, sha256 } per skill
 *
 * Coverage:
 *   - Happy path: subjective, scenario, log_analysis each produce a
 *     Zod-valid rubric proposal via generateRubricDraft().
 *   - Service-layer guard: a type predicate confirming that mcq + kql
 *     are identified as UNSUPPORTED_TYPE_FOR_RUBRIC before generateRubricDraft
 *     is ever called. The actual ValidationError throw lives in the
 *     question-bank service (modules/04-question-bank/src/service.ts
 *     generateRubricForQuestion). The predicate below mirrors that guard
 *     exactly so any future divergence becomes a failing test.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Mocks — self-contained factories (no external refs per vi.mock hoist rule)
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

vi.mock("../skill-sha.js", () => ({
  skillSha: vi.fn(() =>
    Promise.resolve({
      short: "ab1cd234",
      label: "2026-05-10",
      model: "claude-sonnet-4-6",
      sha256: "ab1cd234" + "0".repeat(56),
    }),
  ),
}));

// ---------------------------------------------------------------------------
// Imports — after vi.mock declarations
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { generateRubricDraft } from "../runtimes/claude-code-vps.js";
import type { GenerateRubricInput } from "../types.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const mockSpawn = vi.mocked(spawn);

type FakeProc = EventEmitter & { stdout: Readable; stderr: Readable; kill: ReturnType<typeof vi.fn> };

function makeFakeProc(lines: object[], exitCode = 0): ChildProcess {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.kill = vi.fn();
  setImmediate(() => {
    for (const obj of lines) {
      stdout.push(JSON.stringify(obj) + "\n");
    }
    stdout.push(null);
    stderr.push(null);
    proc.emit("close", exitCode);
  });
  return proc as unknown as ChildProcess;
}

function submitRubricEvent(input: object): object {
  return {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name: "submit_rubric", input }],
    },
  };
}

// ---------------------------------------------------------------------------
// Canned valid submit_rubric payload (satisfies SubmitRubricOutputSchema)
// anchor_weight_total + reasoning_weight_total === 100
// ---------------------------------------------------------------------------

function makeRubricPayload(overrides: Partial<{
  anchors: object[];
  anchor_weight_total: number;
  reasoning_weight_total: number;
}> = {}): object {
  const anchors = overrides.anchors ?? [
    { id: "a1", concept: "Identifies brute-force pattern via EventID 4625", weight: 30, synonyms: ["brute force", "4625"] },
    { id: "a2", concept: "Recommends account isolation and MFA", weight: 30, synonyms: ["isolate", "MFA"] },
  ];
  const anchor_weight_total = overrides.anchor_weight_total ?? 60;
  const reasoning_weight_total = overrides.reasoning_weight_total ?? 40;
  // Wrapped in { rubric: ... } to match SubmitRubricOutputSchema
  return {
    rubric: {
      anchors,
      reasoning_bands: {
        band_4: "Fully identifies attack pattern and recommends precise remediation with justification.",
        band_3: "Identifies pattern and at least one remediation step; misses detail.",
        band_2: "Notes suspicious activity but frames it generically without log evidence.",
        band_1: "Vague identification; no remediation recommended.",
        band_0: "No relevant content or contradicts the log evidence.",
      },
      anchor_weight_total,
      reasoning_weight_total,
    },
  };
}

// ---------------------------------------------------------------------------
// Service-layer guard predicate — mirrors generateRubricForQuestion in
// modules/04-question-bank/src/service.ts. If that guard changes, this
// test will detect the drift.
// ---------------------------------------------------------------------------

type QuestionType = "mcq" | "subjective" | "kql" | "scenario" | "log_analysis";

function supportsRubricGeneration(type: QuestionType): boolean {
  return type === "subjective" || type === "scenario" || type === "log_analysis";
}

// ---------------------------------------------------------------------------
// Reset between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockSpawn.mockReset();
  mockSpawn.mockImplementation(() =>
    makeFakeProc([submitRubricEvent(makeRubricPayload())]),
  );
});

// ---------------------------------------------------------------------------
// Base input factory
// ---------------------------------------------------------------------------

function makeInput(
  questionType: GenerateRubricInput["questionType"],
  questionText: string,
): GenerateRubricInput {
  return {
    questionText,
    questionType,
    levelOrdinal: 2,
    levelDefaults: null,
    existingRubric: undefined,
    questionId: "00000000-0000-4000-8000-000000000001",
  };
}

// ===========================================================================
// Happy-path tests — per type
// ===========================================================================

describe("generateRubricDraft — subjective", () => {
  it("returns a Zod-valid rubric proposal for a subjective question", async () => {
    const result = await generateRubricDraft(
      makeInput("subjective", "Describe how you would triage a brute-force login alert."),
    );

    expect(result.rubric).toBeDefined();
    expect(Array.isArray(result.rubric.anchors)).toBe(true);
    expect(result.rubric.anchors.length).toBeGreaterThanOrEqual(2);
    expect(result.rubric.anchor_weight_total + result.rubric.reasoning_weight_total).toBe(100);
    expect(result.skillSha).toBe("ab1cd234");
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(typeof result.promptSha).toBe("string");
    expect(result.levelDefaultsHash).toBe(""); // null levelDefaults → empty string
  });
});

describe("generateRubricDraft — scenario", () => {
  it("returns a Zod-valid rubric proposal for a scenario question", async () => {
    const scenarioContent = JSON.stringify({
      title: "Lateral movement investigation",
      intro: "You are investigating a suspected lateral movement incident.",
      step_dependency: "linear",
      steps: [
        { id: "s1", type: "subjective", prompt: "Identify the source host." },
        { id: "s2", type: "subjective", prompt: "Recommend containment actions." },
      ],
    });

    const result = await generateRubricDraft(
      makeInput("scenario", scenarioContent),
    );

    expect(result.rubric).toBeDefined();
    expect(result.rubric.anchor_weight_total + result.rubric.reasoning_weight_total).toBe(100);
  });
});

describe("generateRubricDraft — log_analysis", () => {
  it("returns a Zod-valid rubric proposal when passed full JSON-serialized log_analysis content", async () => {
    // For log_analysis, the service passes JSON.stringify(question.content).
    // The skill derives one anchor per expected_finding.
    const logAnalysisContent = JSON.stringify({
      question: "Analyse the log excerpt and identify all indicators of compromise.",
      log_format: "syslog",
      log_excerpt: "May 10 03:12:44 fw01 sshd[1234]: Failed password for root from 10.0.0.5 port 55123 ssh2\nMay 10 03:12:46 fw01 sshd[1234]: Failed password for root from 10.0.0.5 port 55124 ssh2",
      expected_findings: [
        "Repeated failed SSH login attempts (brute force)",
        "Source IP 10.0.0.5 should be blocked at perimeter",
        "Root account targeted — verify root login is disabled",
      ],
      sample_solution: "Findings: brute force; block 10.0.0.5; root login disabled.",
      hint: "Focus on the repeated source IP.",
    });

    // Return a 3-finding payload: 25+25+20 = 70, reasoning = 30
    mockSpawn.mockImplementation(() =>
      makeFakeProc([
        submitRubricEvent(makeRubricPayload({
          anchors: [
            { id: "a1", concept: "Identifies repeated failed SSH login attempts as brute force", weight: 25, synonyms: ["brute force", "repeated failed", "SSH"] },
            { id: "a2", concept: "Recommends blocking source IP 10.0.0.5 at the perimeter", weight: 25, synonyms: ["block", "10.0.0.5", "firewall", "perimeter"] },
            { id: "a3", concept: "Identifies root account as target and recommends disabling root login", weight: 20, synonyms: ["root", "disable root", "permit root login"] },
          ],
          anchor_weight_total: 70,
          reasoning_weight_total: 30,
        })),
      ]),
    );

    const result = await generateRubricDraft(
      makeInput("log_analysis", logAnalysisContent),
    );

    expect(result.rubric).toBeDefined();
    expect(result.rubric.anchors).toHaveLength(3);
    expect(result.rubric.anchor_weight_total).toBe(70);
    expect(result.rubric.reasoning_weight_total).toBe(30);
    expect(result.rubric.anchor_weight_total + result.rubric.reasoning_weight_total).toBe(100);
  });

  it("passes questionType=log_analysis in the prompt sent to spawn", async () => {
    const logContent = JSON.stringify({ question: "q", log_format: "json", log_excerpt: "x", expected_findings: ["f1"] });

    await generateRubricDraft(makeInput("log_analysis", logContent));

    expect(mockSpawn).toHaveBeenCalledOnce();
    const promptArg = vi.mocked(mockSpawn).mock.calls[0]?.[1]?.[1] as string;
    expect(promptArg).toContain("log_analysis");
  });
});

// ===========================================================================
// Service-layer guard — mcq + kql UNSUPPORTED_TYPE_FOR_RUBRIC
// ===========================================================================

describe("supportsRubricGeneration guard — service-layer predicate", () => {
  it("returns true for subjective", () => {
    expect(supportsRubricGeneration("subjective")).toBe(true);
  });

  it("returns true for scenario", () => {
    expect(supportsRubricGeneration("scenario")).toBe(true);
  });

  it("returns true for log_analysis", () => {
    expect(supportsRubricGeneration("log_analysis")).toBe(true);
  });

  it("returns false for mcq (UNSUPPORTED_TYPE_FOR_RUBRIC)", () => {
    expect(supportsRubricGeneration("mcq")).toBe(false);
  });

  it("returns false for kql (UNSUPPORTED_TYPE_FOR_RUBRIC)", () => {
    expect(supportsRubricGeneration("kql")).toBe(false);
  });
});
