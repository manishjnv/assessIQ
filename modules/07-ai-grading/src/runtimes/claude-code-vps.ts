// AssessIQ — Phase 1 runtime: Claude Code CLI on the VPS.
//
// Spawns `claude -p` with a tightly-scoped allowed-tools list per stage.
// Reads the stream-json output line-by-line, finds the structured tool-use
// payload (submit_anchors / submit_band) emitted by the assessiq-mcp server,
// validates with the Zod schemas from ../types, and assembles a
// GradingProposal that the admin reviews before it materialises into a
// gradings row.
//
// Compliance frame (D8): runs only on a fresh admin click, single-flight
// (handler enforces), accept-before-commit (handler does not write — this
// function returns a proposal). Audit logging is the admin's PostToolUse
// hook on the VPS (deployed via infra/admin-claude-settings.example.json).
//
// IMPORTANT (D2): This is one of the TWO files allowed to spawn `claude`.
// The other is modules/07-ai-grading/src/handlers/admin-grade.ts (which
// only calls into here through the runtime selector — it does not spawn
// directly). The lint at modules/07-ai-grading/ci/lint-no-ambient-claude.ts
// enforces the allow-list.
//
// IMPORTANT (D2 RCA 2026-05-03): Comments in this file MUST NOT quote the
// literal `from "@anthropic-ai/<...>"` import path or the literal string
// `spawn("claude", ...)` — the lint regex matches anywhere in the file's
// text including comments. Reference descriptively only.

import { spawn } from "node:child_process";

import { AppError, streamLogger } from "@assessiq/core";

import { AI_GRADING_ERROR_CODES } from "../types.js";
import {
  AnchorFindingSchema,
  BandFindingSchema,
} from "../types.js";
import type {
  AnchorFinding,
  BandFinding,
  GradingInput,
  GradingProposal,
} from "../types.js";
import { finalScore } from "@assessiq/rubric-engine";
import type { Rubric } from "@assessiq/rubric-engine";
import { skillSha } from "../skill-sha.js";
import {
  parseStreamLines,
  parseToolInput,
  type StreamJsonEvent,
} from "../stream-json-parser.js";

import { z } from "zod";

const log = streamLogger("grading");

// ---------------------------------------------------------------------------
// Tool / skill constants
// ---------------------------------------------------------------------------

const SKILL_ANCHORS = "grade-anchors";
const SKILL_BAND = "grade-band";
const SKILL_ESCALATE = "grade-escalate";

const TOOL_SUBMIT_ANCHORS = "submit_anchors";
const TOOL_SUBMIT_BAND = "submit_band";

// MCP-namespaced versions for the --allowed-tools flag. The runtime matches
// stream-json events with `endsWith` so namespace prefixes are tolerated.
const MCP_SUBMIT_ANCHORS = "mcp__assessiq__submit_anchors";
const MCP_SUBMIT_BAND = "mcp__assessiq__submit_band";

const DISALLOWED_TOOLS = "Bash,Write,Edit,Read,Glob,Grep";

const STAGE_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Stage 1 input wrapper schema (matches assessiq-mcp's submit_anchors shape)
// ---------------------------------------------------------------------------

const SubmitAnchorsInputSchema = z.object({
  findings: z.array(AnchorFindingSchema),
});

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function gradeSubjective(
  input: GradingInput,
): Promise<GradingProposal> {
  const rubric = input.rubric as Rubric;
  if (!rubric || !Array.isArray(rubric.anchors)) {
    throw new AppError(
      "rubric missing or malformed for grading",
      AI_GRADING_ERROR_CODES.SCHEMA_VIOLATION,
      503,
      {
        details: {
          attemptId: input.attempt_id,
          questionId: input.question_id,
        },
      },
    );
  }

  // ----- Stage 1 — anchors -------------------------------------------------
  const anchorsEvents = await runSkill({
    skill: SKILL_ANCHORS,
    promptVars: {
      question_text: serializeQuestion(input.question_content),
      anchors: rubric.anchors,
      candidate_answer: serializeAnswer(input.answer),
    },
    allowedTools: [MCP_SUBMIT_ANCHORS],
    attemptId: input.attempt_id,
    questionId: input.question_id,
  });

  const anchorsRaw = parseToolInput(anchorsEvents, TOOL_SUBMIT_ANCHORS);
  if (anchorsRaw === null) {
    throw new AppError(
      `expected ${TOOL_SUBMIT_ANCHORS} tool use in stream-json output`,
      AI_GRADING_ERROR_CODES.SCHEMA_VIOLATION,
      503,
      { details: { stage: 1, attemptId: input.attempt_id } },
    );
  }
  const anchorsParsed = SubmitAnchorsInputSchema.safeParse(anchorsRaw);
  if (!anchorsParsed.success) {
    throw new AppError(
      "submit_anchors payload failed schema validation",
      AI_GRADING_ERROR_CODES.SCHEMA_VIOLATION,
      503,
      { details: { stage: 1, issues: anchorsParsed.error.issues } },
    );
  }
  const anchors: AnchorFinding[] = anchorsParsed.data.findings;

  // ----- Stage 2 — band ----------------------------------------------------
  const bandEvents = await runSkill({
    skill: SKILL_BAND,
    promptVars: {
      question_text: serializeQuestion(input.question_content),
      rubric,
      anchors_found: anchors,
      candidate_answer: serializeAnswer(input.answer),
    },
    allowedTools: [MCP_SUBMIT_BAND],
    attemptId: input.attempt_id,
    questionId: input.question_id,
  });

  const bandRaw = parseToolInput(bandEvents, TOOL_SUBMIT_BAND);
  if (bandRaw === null) {
    throw new AppError(
      `expected ${TOOL_SUBMIT_BAND} tool use in stream-json output`,
      AI_GRADING_ERROR_CODES.SCHEMA_VIOLATION,
      503,
      { details: { stage: 2, attemptId: input.attempt_id } },
    );
  }
  const bandParsed = BandFindingSchema.safeParse(bandRaw);
  if (!bandParsed.success) {
    throw new AppError(
      "submit_band payload failed schema validation",
      AI_GRADING_ERROR_CODES.SCHEMA_VIOLATION,
      503,
      { details: { stage: 2, issues: bandParsed.error.issues } },
    );
  }
  let band: BandFinding = bandParsed.data;
  let escalationStage: "2" | "3" | "manual" | null = "2";

  // ----- Stage 3 — escalation -----------------------------------------
  // Triggered automatically when Stage 2 sets `needs_escalation: true`,
  // OR explicitly when the caller passes `force_escalate: true` (the
  // admin's "Re-run with Opus" affordance via handleAdminRerun).
  let escalateSha: { short: string; label: string; model: string } | null = null;
  const shouldEscalate =
    band.needs_escalation === true || input.force_escalate === true;
  if (shouldEscalate) {
    try {
      const escEvents = await runSkill({
        skill: SKILL_ESCALATE,
        promptVars: {
          question_text: serializeQuestion(input.question_content),
          rubric,
          anchors_found: anchors,
          candidate_answer: serializeAnswer(input.answer),
        },
        allowedTools: [MCP_SUBMIT_BAND],
        attemptId: input.attempt_id,
        questionId: input.question_id,
      });
      const escRaw = parseToolInput(escEvents, TOOL_SUBMIT_BAND);
      if (escRaw === null) {
        throw new AppError(
          `Stage 3: expected ${TOOL_SUBMIT_BAND} tool use in stream-json output`,
          AI_GRADING_ERROR_CODES.ESCALATION_FAILURE,
          503,
          { details: { attemptId: input.attempt_id } },
        );
      }
      const escParsed = BandFindingSchema.safeParse(escRaw);
      if (!escParsed.success) {
        throw new AppError(
          "Stage 3 submit_band payload failed schema validation",
          AI_GRADING_ERROR_CODES.ESCALATION_FAILURE,
          503,
          { details: { issues: escParsed.error.issues } },
        );
      }
      const escBand = escParsed.data;
      const stage2Band = band.reasoning_band;
      const stage3Band = escBand.reasoning_band;
      const sha = await skillSha(SKILL_ESCALATE);
      escalateSha = { short: sha.short, label: sha.label, model: sha.model };

      if (Math.abs(stage2Band - stage3Band) >= 2) {
        // ≥2-band disagreement: surface to admin, don't auto-pick.
        // The admin sees both verdicts; escalation_chosen_stage='manual'.
        escalationStage = "manual";
        // Keep Stage 2 band as the proposal's primary band; admin chooses.
      } else {
        // Stage 3 wins (second opinion is more thorough).
        band = escBand;
        escalationStage = "3";
      }
    } catch (err) {
      // Escalation failed — log but don't block the proposal. The Stage 2
      // band stands; admin sees error_class='escalation_failure' to know
      // they may want to re-run.
      log.warn(
        {
          attemptId: input.attempt_id,
          questionId: input.question_id,
          err: (err as Error).message,
        },
        "grading.escalation.failed",
      );
      band = {
        ...band,
        error_class: band.error_class ?? "escalation_failure",
      };
      escalationStage = "2";
    }
  }

  // ----- Score computation -------------------------------------------------
  const { earned, max } = finalScore(rubric, anchors, band.reasoning_band);

  // ----- D4 SHA pinning ---------------------------------------------------
  const anchorsSha = await skillSha(SKILL_ANCHORS);
  const bandSha = await skillSha(SKILL_BAND);
  if (shouldEscalate && escalateSha === null) {
    // Stage 3 ran but threw before setting escalateSha; capture for the row.
    try {
      const sha = await skillSha(SKILL_ESCALATE);
      escalateSha = { short: sha.short, label: sha.label, model: sha.model };
    } catch {
      // Skill file missing — leave as null; escalate slot becomes "-".
    }
  }

  const promptVersionSha =
    `anchors:${anchorsSha.short};` +
    `band:${bandSha.short};` +
    `escalate:${escalateSha?.short ?? "-"}`;
  const promptVersionLabel =
    `${anchorsSha.label};${bandSha.label};${escalateSha?.label ?? "-"}`;
  const model =
    `${anchorsSha.model};${bandSha.model};${escalateSha?.model ?? "-"}`;

  log.info(
    {
      attemptId: input.attempt_id,
      questionId: input.question_id,
      promptVersionSha,
      escalationStage,
      // Never log answer / justification / evidence text.
    },
    "grading.proposal",
  );

  return {
    attempt_id: input.attempt_id,
    question_id: input.question_id,
    anchors,
    band,
    score_earned: earned,
    score_max: max,
    prompt_version_sha: promptVersionSha,
    prompt_version_label: promptVersionLabel,
    model,
    escalation_chosen_stage: escalationStage,
    generated_at: new Date().toISOString(),
  };
}

/** Public alias — D2 lint allow-list contract names this symbol. */
export const runClaudeCodeGrading = gradeSubjective;

// ---------------------------------------------------------------------------
// runSkill — single `claude -p` subprocess, returns parsed stream-json events
// ---------------------------------------------------------------------------

interface RunSkillOpts {
  skill: string;
  promptVars: object;
  allowedTools: string[];
  attemptId: string;
  questionId: string;
}

function runSkill(opts: RunSkillOpts): Promise<StreamJsonEvent[]> {
  const prompt =
    `Use the ${opts.skill} skill with these inputs:\n\n` +
    JSON.stringify(opts.promptVars, null, 2);

  return new Promise<StreamJsonEvent[]>((resolve, reject) => {
    const args = [
      "-p",
      prompt,
      "--allowed-tools",
      opts.allowedTools.join(","),
      "--disallowed-tools",
      DISALLOWED_TOOLS,
      "--output-format",
      "stream-json",
      "--max-turns",
      "4",
      "--permission-mode",
      "auto",
    ];

    const startedAt = Date.now();
    const proc = spawn("claude", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let stderrTail = "";
    const events: StreamJsonEvent[] = [];

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(
        new AppError(
          `claude subprocess timed out after ${STAGE_TIMEOUT_MS}ms (skill=${opts.skill})`,
          AI_GRADING_ERROR_CODES.RUNTIME_FAILURE,
          503,
          { details: { skill: opts.skill, attemptId: opts.attemptId } },
        ),
      );
    }, STAGE_TIMEOUT_MS);

    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      const { events: parsed, remainder } = parseStreamLines(stdoutBuf);
      events.push(...parsed);
      stdoutBuf = remainder;
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      // Keep last 512 bytes for diagnostic logging — redacted, never raw
      // candidate-answer leakage. Anthropic content-policy refusals
      // sometimes echo prompt content into stderr per
      // docs/11-observability.md § 10.
      const text = chunk.toString("utf8");
      stderrTail = (stderrTail + text).slice(-512);
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new AppError(
          `claude subprocess failed to start: ${err.message}`,
          AI_GRADING_ERROR_CODES.RUNTIME_FAILURE,
          503,
          {
            details: { skill: opts.skill, attemptId: opts.attemptId },
            cause: err,
          },
        ),
      );
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      // Flush any partial last line.
      if (stdoutBuf.trim()) {
        const { events: parsed } = parseStreamLines(stdoutBuf + "\n");
        events.push(...parsed);
      }
      const durationMs = Date.now() - startedAt;
      log.info(
        {
          skill: opts.skill,
          attemptId: opts.attemptId,
          questionId: opts.questionId,
          exitCode: code,
          durationMs,
          // stderrTail is intentionally NOT logged — even truncated, it
          // can leak candidate text. The audit JSONL hook on the VPS
          // captures Claude Code's own structured trace.
        },
        "grading.run",
      );
      if (code === 0) {
        resolve(events);
      } else {
        reject(
          new AppError(
            `claude subprocess exited with code ${code} (skill=${opts.skill})`,
            AI_GRADING_ERROR_CODES.RUNTIME_FAILURE,
            503,
            {
              details: {
                skill: opts.skill,
                exitCode: code,
                attemptId: opts.attemptId,
              },
            },
          ),
        );
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Question / answer serialisation for prompt embedding
// ---------------------------------------------------------------------------

function serializeQuestion(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c["text"] === "string") return c["text"];
    if (typeof c["title"] === "string" && typeof c["body"] === "string") {
      return `${c["title"]}\n\n${c["body"]}`;
    }
  }
  return JSON.stringify(content);
}

function serializeAnswer(answer: unknown): string {
  if (typeof answer === "string") return answer;
  if (answer === null || answer === undefined) return "";
  if (typeof answer === "object") {
    const a = answer as Record<string, unknown>;
    if (typeof a["text"] === "string") return a["text"];
  }
  return JSON.stringify(answer);
}
