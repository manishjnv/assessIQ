/**
 * Unit tests for ../runtimes/claude-code-vps.ts
 *
 * Mocks:
 *   - node:child_process spawn → EventEmitter-based fake subprocess
 *   - ../skill-sha.js → canned { short, label, model, sha256 } per skill
 *
 * Stage dispatch is detected by inspecting the `args` array passed to spawn:
 * the prompt argument (args[1]) embeds "Use the <skill> skill", which lets
 * us return the right canned events per stage.
 *
 * All tests use a minimal GradingInput with a valid rubric and 2 anchors.
 *
 * vi.mock hoisting note: Vitest hoists vi.mock() calls above all imports and
 * module-level variable declarations. Factory functions must therefore be
 * SELF-CONTAINED — they must not reference const/let variables declared in
 * the same file. We retrieve the mocked functions after imports via
 * vi.mocked(importedFn).
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

// ---------------------------------------------------------------------------
// Declare mocks — factories are self-contained (no external refs).
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

vi.mock("../skill-sha.js", () => ({
  skillSha: vi.fn(() =>
    Promise.resolve({
      short: "abc12345",
      label: "v1",
      model: "claude-haiku-4-5",
      sha256: "abc12345" + "0".repeat(56),
    }),
  ),
}));

// ---------------------------------------------------------------------------
// Imports — after vi.mock declarations so they receive the mocked modules
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { gradeSubjective } from "../runtimes/claude-code-vps.js";
import { AI_GRADING_ERROR_CODES } from "../types.js";
import type { GradingInput } from "../types.js";
import { AppError } from "@assessiq/core";

// ---------------------------------------------------------------------------
// Convenience alias — vi.mocked gives us type-safe access to the mock fn
// ---------------------------------------------------------------------------

const mockSpawn = vi.mocked(spawn);

// Canned SHA values (match the self-contained factory above)
const CANNED_SHORT = "abc12345";

// ---------------------------------------------------------------------------
// Test fixture — minimal valid GradingInput
// ---------------------------------------------------------------------------

const BASE_INPUT: GradingInput = {
  attempt_id: "00000000-0000-4000-8000-000000000001",
  question_id: "00000000-0000-4000-8000-000000000002",
  question_content: { text: "What is lateral movement?" },
  rubric: {
    anchors: [
      { id: "a1", weight: 12 },
      { id: "a2", weight: 12 },
    ],
    anchor_weight_total: 24,
    reasoning_weight_total: 36,
  },
  answer: {
    text: "Lateral movement is when an attacker moves from one host to another after initial compromise.",
  },
};

// ---------------------------------------------------------------------------
// Subprocess mock factory
//
// Creates a fake proc that emits stream-json events on stdout then closes
// with exitCode. setImmediate delays emission so the Promise constructor has
// time to attach listeners before events fire.
// ---------------------------------------------------------------------------

// Vitest's strict typing requires the spawn mock to return ChildProcess.
// Our fake is "duck-shaped" — only stdout/stderr/emit are touched by the
// runtime — so we widen via unknown cast at the boundary. Internal use of
// FakeProc keeps test code typed against the surface we actually exercise.
import type { ChildProcess } from "node:child_process";
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

/** Build a standard assistant tool-use event for stream-json. */
function toolUseEvent(toolName: string, input: object): object {
  return {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name: toolName, input }],
    },
  };
}

/** Canned Stage-1 anchors payload: one hit (a1), one miss (a2). */
const STAGE1_ANCHORS_PAYLOAD = {
  findings: [
    { anchor_id: "a1", hit: true, evidence_quote: "moves from one host", confidence: 0.9 },
    { anchor_id: "a2", hit: false, confidence: 0.4 },
  ],
};

/** Build a Stage-2 / Stage-3 band payload. */
function bandPayload(
  band: number,
  needsEscalation = false,
  errorClass: string | null = null,
): object {
  return {
    reasoning_band: band,
    ai_justification: `Band ${band} rationale.`,
    error_class: errorClass,
    needs_escalation: needsEscalation,
  };
}

// ---------------------------------------------------------------------------
// Stage dispatch helper
//
// The runtime calls spawn("claude", ["-p", "<prompt>", ...]) where the prompt
// starts with "Use the <skill> skill with these inputs:". We read args[1].
// ---------------------------------------------------------------------------

function skillFromArgs(args: readonly string[]): string {
  const prompt = args[1] ?? "";
  if (prompt.includes("grade-anchors")) return "grade-anchors";
  if (prompt.includes("grade-escalate")) return "grade-escalate";
  if (prompt.includes("grade-band")) return "grade-band";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Reset mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockSpawn.mockReset();
});

// ---------------------------------------------------------------------------
// (a) Happy path Stage 1 + 2 (no escalation)
// ---------------------------------------------------------------------------

describe("gradeSubjective — happy path Stage 1+2", () => {
  it("returns a valid GradingProposal with correct shape and scores", async () => {
    mockSpawn.mockImplementation((_cmd: string, args: readonly string[]) => {
      const skill = skillFromArgs(args);
      if (skill === "grade-anchors") {
        return makeFakeProc([toolUseEvent("submit_anchors", STAGE1_ANCHORS_PAYLOAD)]);
      }
      if (skill === "grade-band") {
        return makeFakeProc([toolUseEvent("submit_band", bandPayload(3, false))]);
      }
      throw new Error(`Unexpected skill spawn: ${skill}`);
    });

    const proposal = await gradeSubjective(BASE_INPUT);

    // Shape
    expect(proposal.attempt_id).toBe(BASE_INPUT.attempt_id);
    expect(proposal.question_id).toBe(BASE_INPUT.question_id);
    expect(proposal.anchors).toHaveLength(2);
    expect(proposal.band.reasoning_band).toBe(3);
    expect(proposal.escalation_chosen_stage).toBe("2");

    // D4 SHA pinning — escalate slot is "-" (no Stage 3)
    expect(proposal.prompt_version_sha).toBe(
      `anchors:${CANNED_SHORT};band:${CANNED_SHORT};escalate:-`,
    );
    expect(proposal.prompt_version_label).toBe("v1;v1;-");
    expect(proposal.model).toBe("claude-haiku-4-5;claude-haiku-4-5;-");

    // Score: anchor_score = 12 (a1 hit only), reasoning = (3/4)*36 = 27
    expect(proposal.score_earned).toBe(39); // 12 + 27
    expect(proposal.score_max).toBe(60);    // 24 + 36

    // generated_at is a valid ISO-8601 string
    expect(new Date(proposal.generated_at).toISOString()).toBe(proposal.generated_at);
  });
});

// ---------------------------------------------------------------------------
// (b) Stage 3 auto-escalation — needs_escalation=true, close agreement (|diff|<2)
// ---------------------------------------------------------------------------

describe("gradeSubjective — Stage 3 auto-escalation close agreement", () => {
  it("Stage 3 wins when |stage2Band - stage3Band| < 2; escalation_chosen_stage='3'", async () => {
    mockSpawn.mockImplementation((_cmd: string, args: readonly string[]) => {
      const skill = skillFromArgs(args);
      if (skill === "grade-anchors") {
        return makeFakeProc([toolUseEvent("submit_anchors", STAGE1_ANCHORS_PAYLOAD)]);
      }
      if (skill === "grade-band") {
        // Stage 2: band=2, needs escalation
        return makeFakeProc([toolUseEvent("submit_band", bandPayload(2, true))]);
      }
      if (skill === "grade-escalate") {
        // Stage 3: band=3 — |2-3|=1 < 2, Stage 3 wins
        return makeFakeProc([toolUseEvent("submit_band", bandPayload(3, false))]);
      }
      throw new Error(`Unexpected skill: ${skill}`);
    });

    const proposal = await gradeSubjective(BASE_INPUT);

    expect(proposal.band.reasoning_band).toBe(3); // Stage 3 verdict adopted
    expect(proposal.escalation_chosen_stage).toBe("3");
    // Escalate SHA slot populated
    expect(proposal.prompt_version_sha).toBe(
      `anchors:${CANNED_SHORT};band:${CANNED_SHORT};escalate:${CANNED_SHORT}`,
    );
    expect(proposal.prompt_version_label).toBe("v1;v1;v1");
    expect(proposal.model).toBe("claude-haiku-4-5;claude-haiku-4-5;claude-haiku-4-5");
  });
});

// ---------------------------------------------------------------------------
// (c) Stage 3 ≥2-band disagreement → manual
// ---------------------------------------------------------------------------

describe("gradeSubjective — Stage 3 ≥2-band disagreement → manual", () => {
  it("escalation_chosen_stage='manual'; Stage 2 band is primary; proposal still ships", async () => {
    mockSpawn.mockImplementation((_cmd: string, args: readonly string[]) => {
      const skill = skillFromArgs(args);
      if (skill === "grade-anchors") {
        return makeFakeProc([toolUseEvent("submit_anchors", STAGE1_ANCHORS_PAYLOAD)]);
      }
      if (skill === "grade-band") {
        // Stage 2: band=4, needs escalation
        return makeFakeProc([toolUseEvent("submit_band", bandPayload(4, true))]);
      }
      if (skill === "grade-escalate") {
        // Stage 3: band=1 — |4-1|=3 ≥ 2 → manual
        return makeFakeProc([toolUseEvent("submit_band", bandPayload(1, false))]);
      }
      throw new Error(`Unexpected skill: ${skill}`);
    });

    const proposal = await gradeSubjective(BASE_INPUT);

    // Stage 2 band stays as primary (admin chooses)
    expect(proposal.band.reasoning_band).toBe(4);
    expect(proposal.escalation_chosen_stage).toBe("manual");
    // Proposal still ships with a valid score
    expect(proposal.score_max).toBe(60);
    // Escalate SHA populated (Stage 3 did run successfully before disagreement)
    expect(proposal.prompt_version_sha).toBe(
      `anchors:${CANNED_SHORT};band:${CANNED_SHORT};escalate:${CANNED_SHORT}`,
    );
  });
});

// ---------------------------------------------------------------------------
// (d) force_escalate=true forces Stage 3 regardless of needs_escalation
// ---------------------------------------------------------------------------

describe("gradeSubjective — force_escalate=true", () => {
  it("runs Stage 3 when force_escalate=true even though Stage 2 needs_escalation=false", async () => {
    let escalateCalled = false;

    mockSpawn.mockImplementation((_cmd: string, args: readonly string[]) => {
      const skill = skillFromArgs(args);
      if (skill === "grade-anchors") {
        return makeFakeProc([toolUseEvent("submit_anchors", STAGE1_ANCHORS_PAYLOAD)]);
      }
      if (skill === "grade-band") {
        // Stage 2: band=2, needs_escalation=false — but caller forces Stage 3
        return makeFakeProc([toolUseEvent("submit_band", bandPayload(2, false))]);
      }
      if (skill === "grade-escalate") {
        escalateCalled = true;
        // Stage 3: band=3 — |2-3|=1 < 2, Stage 3 wins
        return makeFakeProc([toolUseEvent("submit_band", bandPayload(3, false))]);
      }
      throw new Error(`Unexpected skill: ${skill}`);
    });

    const proposal = await gradeSubjective({ ...BASE_INPUT, force_escalate: true });

    expect(escalateCalled).toBe(true);
    expect(proposal.band.reasoning_band).toBe(3);
    expect(proposal.escalation_chosen_stage).toBe("3");
  });

  it("force_escalate=true with ≥2 band gap → manual reconciliation", async () => {
    mockSpawn.mockImplementation((_cmd: string, args: readonly string[]) => {
      const skill = skillFromArgs(args);
      if (skill === "grade-anchors") {
        return makeFakeProc([toolUseEvent("submit_anchors", STAGE1_ANCHORS_PAYLOAD)]);
      }
      if (skill === "grade-band") {
        return makeFakeProc([toolUseEvent("submit_band", bandPayload(4, false))]);
      }
      if (skill === "grade-escalate") {
        // |4-1|=3 ≥ 2
        return makeFakeProc([toolUseEvent("submit_band", bandPayload(1, false))]);
      }
      throw new Error(`Unexpected skill: ${skill}`);
    });

    const proposal = await gradeSubjective({ ...BASE_INPUT, force_escalate: true });

    expect(proposal.escalation_chosen_stage).toBe("manual");
    expect(proposal.band.reasoning_band).toBe(4); // Stage 2 stays primary
  });
});

// ---------------------------------------------------------------------------
// (e) Stage 1 missing tool_use → SCHEMA_VIOLATION
// ---------------------------------------------------------------------------

describe("gradeSubjective — Stage 1 missing tool_use", () => {
  it("throws SCHEMA_VIOLATION when no submit_anchors tool_use in Stage 1 output", async () => {
    mockSpawn.mockImplementation((_cmd: string, args: readonly string[]) => {
      const skill = skillFromArgs(args);
      if (skill === "grade-anchors") {
        return makeFakeProc([
          { type: "assistant", message: { content: [{ type: "text", text: "thinking..." }] } },
        ]);
      }
      throw new Error(`Unexpected skill: ${skill}`);
    });

    let caught: unknown;
    try {
      await gradeSubjective(BASE_INPUT);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe(AI_GRADING_ERROR_CODES.SCHEMA_VIOLATION);
  });
});

// ---------------------------------------------------------------------------
// (f) Stage 1 schema violation — findings is not an array
// ---------------------------------------------------------------------------

describe("gradeSubjective — Stage 1 schema violation", () => {
  it("throws SCHEMA_VIOLATION when submit_anchors input has findings as a non-array", async () => {
    mockSpawn.mockImplementation((_cmd: string, args: readonly string[]) => {
      const skill = skillFromArgs(args);
      if (skill === "grade-anchors") {
        return makeFakeProc([
          toolUseEvent("submit_anchors", { findings: "not an array" }),
        ]);
      }
      throw new Error(`Unexpected skill: ${skill}`);
    });

    let caught: unknown;
    try {
      await gradeSubjective(BASE_INPUT);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe(AI_GRADING_ERROR_CODES.SCHEMA_VIOLATION);
  });
});

// ---------------------------------------------------------------------------
// (g) Subprocess non-zero exit → RUNTIME_FAILURE
// ---------------------------------------------------------------------------

describe("gradeSubjective — subprocess non-zero exit", () => {
  it("throws RUNTIME_FAILURE when claude exits with code 1", async () => {
    mockSpawn.mockImplementation(() => makeFakeProc([], 1));

    let caught: unknown;
    try {
      await gradeSubjective(BASE_INPUT);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe(AI_GRADING_ERROR_CODES.RUNTIME_FAILURE);
  });

  it("throws RUNTIME_FAILURE on exit code 127 (command not found)", async () => {
    mockSpawn.mockImplementation(() => makeFakeProc([], 127));

    let caught: unknown;
    try {
      await gradeSubjective(BASE_INPUT);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe(AI_GRADING_ERROR_CODES.RUNTIME_FAILURE);
  });
});

// ---------------------------------------------------------------------------
// (h) Subprocess 'error' event (ENOENT — binary not found) → RUNTIME_FAILURE
// ---------------------------------------------------------------------------

describe("gradeSubjective — subprocess error event (ENOENT)", () => {
  it("throws RUNTIME_FAILURE when spawn emits 'error'", async () => {
    mockSpawn.mockImplementation(() => {
      const stdout = new Readable({ read() {} });
      const stderr = new Readable({ read() {} });
      const proc = new EventEmitter() as FakeProc;
      proc.stdout = stdout;
      proc.stderr = stderr;
      proc.kill = vi.fn();

      setImmediate(() => {
        const enoent = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
        stdout.push(null);
        stderr.push(null);
        proc.emit("error", enoent);
      });

      return proc as unknown as ChildProcess;
    });

    let caught: unknown;
    try {
      await gradeSubjective(BASE_INPUT);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe(AI_GRADING_ERROR_CODES.RUNTIME_FAILURE);
    expect((caught as AppError).message).toContain("ENOENT");
  });
});

// ---------------------------------------------------------------------------
// (i) Rubric malformed → SCHEMA_VIOLATION at entry guard (no spawn)
// ---------------------------------------------------------------------------

describe("gradeSubjective — rubric guard (entry-level SCHEMA_VIOLATION)", () => {
  it("throws SCHEMA_VIOLATION immediately when rubric is undefined", async () => {
    const input: GradingInput = { ...BASE_INPUT, rubric: undefined };

    let caught: unknown;
    try {
      await gradeSubjective(input);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe(AI_GRADING_ERROR_CODES.SCHEMA_VIOLATION);
    // Entry guard fires before any spawn
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("throws SCHEMA_VIOLATION when rubric.anchors is not an array", async () => {
    const input: GradingInput = {
      ...BASE_INPUT,
      rubric: { anchors: "bad", anchor_weight_total: 24, reasoning_weight_total: 36 },
    };

    let caught: unknown;
    try {
      await gradeSubjective(input);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe(AI_GRADING_ERROR_CODES.SCHEMA_VIOLATION);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("throws SCHEMA_VIOLATION when rubric is null", async () => {
    const input: GradingInput = { ...BASE_INPUT, rubric: null };

    let caught: unknown;
    try {
      await gradeSubjective(input);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe(AI_GRADING_ERROR_CODES.SCHEMA_VIOLATION);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Stage 2 schema violations
// ---------------------------------------------------------------------------

describe("gradeSubjective — Stage 2 schema violations", () => {
  it("throws SCHEMA_VIOLATION when submit_band reasoning_band is out of range", async () => {
    mockSpawn.mockImplementation((_cmd: string, args: readonly string[]) => {
      const skill = skillFromArgs(args);
      if (skill === "grade-anchors") {
        return makeFakeProc([toolUseEvent("submit_anchors", STAGE1_ANCHORS_PAYLOAD)]);
      }
      if (skill === "grade-band") {
        // reasoning_band=9 is out of range 0-4
        return makeFakeProc([
          toolUseEvent("submit_band", {
            reasoning_band: 9,
            ai_justification: "bad band",
            error_class: null,
          }),
        ]);
      }
      throw new Error(`Unexpected skill: ${skill}`);
    });

    let caught: unknown;
    try {
      await gradeSubjective(BASE_INPUT);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe(AI_GRADING_ERROR_CODES.SCHEMA_VIOLATION);
  });

  it("throws SCHEMA_VIOLATION when Stage 2 emits no submit_band tool_use", async () => {
    mockSpawn.mockImplementation((_cmd: string, args: readonly string[]) => {
      const skill = skillFromArgs(args);
      if (skill === "grade-anchors") {
        return makeFakeProc([toolUseEvent("submit_anchors", STAGE1_ANCHORS_PAYLOAD)]);
      }
      if (skill === "grade-band") {
        return makeFakeProc([
          { type: "assistant", message: { content: [{ type: "text", text: "hmm..." }] } },
        ]);
      }
      throw new Error(`Unexpected skill: ${skill}`);
    });

    let caught: unknown;
    try {
      await gradeSubjective(BASE_INPUT);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe(AI_GRADING_ERROR_CODES.SCHEMA_VIOLATION);
  });
});

// ---------------------------------------------------------------------------
// Stage 3 failure is non-fatal — proposal still ships with Stage 2 band
// ---------------------------------------------------------------------------

describe("gradeSubjective — Stage 3 escalation failure is non-fatal", () => {
  it("proposal ships with Stage 2 band and error_class='escalation_failure' when Stage 3 errors", async () => {
    mockSpawn.mockImplementation((_cmd: string, args: readonly string[]) => {
      const skill = skillFromArgs(args);
      if (skill === "grade-anchors") {
        return makeFakeProc([toolUseEvent("submit_anchors", STAGE1_ANCHORS_PAYLOAD)]);
      }
      if (skill === "grade-band") {
        // needs_escalation=true — triggers Stage 3
        return makeFakeProc([toolUseEvent("submit_band", bandPayload(3, true))]);
      }
      if (skill === "grade-escalate") {
        // Stage 3 subprocess fails (exit code 1)
        return makeFakeProc([], 1);
      }
      throw new Error(`Unexpected skill: ${skill}`);
    });

    // Must NOT throw — runtime catches Stage 3 failures
    const proposal = await gradeSubjective(BASE_INPUT);

    // Stage 2 band remains primary
    expect(proposal.band.reasoning_band).toBe(3);
    // escalation_chosen_stage reverts to "2" on escalation failure
    expect(proposal.escalation_chosen_stage).toBe("2");
    // error_class is stamped with 'escalation_failure'
    expect(proposal.band.error_class).toBe("escalation_failure");
  });
});
