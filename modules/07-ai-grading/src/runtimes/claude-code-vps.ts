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
import { createHash } from "node:crypto";

import { AppError, streamLogger } from "@assessiq/core";

import { AI_GRADING_ERROR_CODES } from "../types.js";
import {
  AnchorFindingSchema,
  BandFindingSchema,
} from "../types.js";
import type {
  AnchorFinding,
  BandFinding,
  GenerateQuestionsInput,
  GenerateQuestionsOutput,
  GeneratedQuestionDraft,
  GenerateRubricInput,
  GenerateRubricOutput,
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
const GENERATION_BASE_TIMEOUT_MS = 60_000;
const GENERATION_PER_ITEM_TIMEOUT_MS = 120_000;
const RUBRIC_TIMEOUT_MS = 300_000;

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
// generateQuestions — Question generation using the generate-questions skill
// ---------------------------------------------------------------------------

const SKILL_GENERATE = "generate-questions";
const TOOL_SUBMIT_QUESTIONS = "submit_questions";
const MCP_SUBMIT_QUESTIONS = "mcp__assessiq__submit_questions";

/**
 * GeneratedQuestionSchema — validates the submit_questions payload from the
 * skill.  Mirrors the MCP tool's submit-questions.ts schema without importing
 * the tools package (no dep in this package.json).
 */
const GeneratedQuestionDraftSchema = z.object({
  type: z.enum(["mcq", "subjective", "kql", "scenario", "log_analysis"]),
  topic: z.string().min(3).max(200),
  points: z.number().int().min(1).max(10),
  knowledge_base_source_ids: z.array(z.string().min(1)).min(1),
  content: z.unknown(),
  rubric: z.unknown().nullable().optional(),
});

const SubmitQuestionsInputSchema = z.object({
  questions: z.array(GeneratedQuestionDraftSchema).min(1).max(12),
});

/**
 * Generate SOC-grounded ai_draft questions using the generate-questions skill.
 * Called by the runtime-selector; entry point is admin-generate.ts handler.
 *
 * NOTE (D2): This function is in claude-code-vps.ts — the only file allowed
 * to interact with the claude subprocess (via the shared runSkill helper).
 * admin-generate.ts calls through runtime-selector → here.
 */
export async function generateQuestions(
  input: GenerateQuestionsInput,
): Promise<GenerateQuestionsOutput> {
  const genSha = await skillSha(SKILL_GENERATE);

  const promptVars = {
    level: input.level,
    count: input.count,
    topic_focus: input.topicFocus ?? null,
    existing_topics: input.existingTopics,
    sources: input.sources,
  };

  const events = await runSkill({
    skill: SKILL_GENERATE,
    promptVars,
    allowedTools: [MCP_SUBMIT_QUESTIONS],
    attemptId: "generation",
    questionId: `${input.packId}:${input.levelId}`,
    timeoutMs:
      GENERATION_BASE_TIMEOUT_MS +
      input.count * GENERATION_PER_ITEM_TIMEOUT_MS,
    model: "claude-sonnet-4-6",
  });

  const raw = parseToolInput(events, TOOL_SUBMIT_QUESTIONS);
  if (raw === null) {
    // Log raw stream events (truncated 2KB) so the mismatch is diagnosable.
    log.error(
      {
        skill: SKILL_GENERATE,
        packId: input.packId,
        expectedTool: TOOL_SUBMIT_QUESTIONS,
        rawStreamTruncated: JSON.stringify(events).slice(0, 2048),
      },
      "generation.submit_tool.missing",
    );
    throw new AppError(
      `expected ${TOOL_SUBMIT_QUESTIONS} tool use in stream-json output`,
      AI_GRADING_ERROR_CODES.SCHEMA_VIOLATION,
      503,
      { details: { skill: SKILL_GENERATE, packId: input.packId } },
    );
  }

  const parsed = SubmitQuestionsInputSchema.safeParse(raw);
  if (!parsed.success) {
    // Log raw payload (truncated 2KB) + Zod issues so the structural mismatch
    // is diagnosable without reading production DB rows.
    log.error(
      {
        skill: SKILL_GENERATE,
        packId: input.packId,
        expectedTool: TOOL_SUBMIT_QUESTIONS,
        rawPayloadTruncated: JSON.stringify(raw).slice(0, 2048),
        issues: parsed.error.issues,
      },
      "generation.submit_tool.schema_failed",
    );
    throw new AppError(
      "submit_questions payload failed schema validation",
      AI_GRADING_ERROR_CODES.SCHEMA_VIOLATION,
      503,
      { details: { issues: parsed.error.issues } },
    );
  }

  // Build the full source objects for provenance: resolve each
  // knowledge_base_source_id from the input.sources array.
  const sourceById = new Map(input.sources.map((s) => [s.id, s]));

  const questions: GeneratedQuestionDraft[] = parsed.data.questions.map((q) => ({
    type: q.type,
    topic: q.topic,
    points: q.points,
    content: q.content,
    rubric: q.rubric ?? null,
    knowledgeBaseSources: q.knowledge_base_source_ids
      .map((id) => sourceById.get(id))
      .filter((s): s is NonNullable<typeof s> => s !== undefined)
      .map((s) => ({
        id: s.id,
        name: s.name,
        citation: s.citation,
        url: s.url,
        level_fit: s.level_fit,
        function: s.function,
        kb_version: s.kb_version,
      })),
  }));

  log.info(
    {
      packId: input.packId,
      levelId: input.levelId,
      level: input.level,
      generated: questions.length,
      skillSha: genSha.short,
    },
    "generation.skill.complete",
  );

  return {
    questions,
    skillSha: genSha.short,
    model: genSha.model,
  };
}

// ---------------------------------------------------------------------------
// generateRubricDraft — Rubric generation using the generate-rubric skill
// ---------------------------------------------------------------------------

const SKILL_RUBRIC = "generate-rubric";
const TOOL_SUBMIT_RUBRIC = "submit_rubric";
const MCP_SUBMIT_RUBRIC = "mcp__assessiq__submit_rubric";

// Local schema mirror — avoids dep on @assessiq/rubric-engine in this file;
// the refine enforces the weight=100 invariant before we return the proposal.
const SubmitRubricAnchorSchema = z.object({
  id: z.string().min(1),
  concept: z.string().min(1),
  weight: z.number().int().min(0).max(100),
  synonyms: z.array(z.string().min(1)).min(1),
}).strict();

const SubmitRubricOutputSchema = z.object({
  rubric: z.object({
    anchors: z.array(SubmitRubricAnchorSchema).min(1),
    reasoning_bands: z.object({
      band_4: z.string().min(1),
      band_3: z.string().min(1),
      band_2: z.string().min(1),
      band_1: z.string().min(1),
      band_0: z.string().min(1),
    }).strict(),
    anchor_weight_total: z.number().int().min(0).max(100),
    reasoning_weight_total: z.number().int().min(0).max(100),
  }).strict().refine(
    (r) => r.anchor_weight_total + r.reasoning_weight_total === 100,
    { message: "anchor_weight_total + reasoning_weight_total must equal 100" },
  ),
});

function hashString8(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 8);
}

function sortedJsonHash(obj: object | null): string {
  if (obj === null) return "";
  const sorted = Object.fromEntries(
    Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)),
  );
  return hashString8(JSON.stringify(sorted));
}

/**
 * Generate a rubric proposal using the generate-rubric skill.
 * Returns a proposal WITHOUT persisting. The admin reviews and POSTs
 * to /save-rubric to persist. Same single-flight + skill_sha + prompt_sha
 * + level_defaults_hash patterns as generateQuestions.
 *
 * NOTE (D2): This function lives in claude-code-vps.ts — the only file
 * allowed to interact with the claude subprocess (via the shared runSkill
 * helper). The question-bank service calls through runtime-selector → here.
 */
export async function generateRubricDraft(
  input: GenerateRubricInput,
): Promise<GenerateRubricOutput> {
  const rubricSkillSha = await skillSha(SKILL_RUBRIC);

  const promptVars = {
    questionText: input.questionText,
    questionType: input.questionType,
    levelOrdinal: input.levelOrdinal,
    levelDefaults: input.levelDefaults ?? null,
    existingRubric: input.existingRubric ?? null,
  };

  const promptSha = hashString8(JSON.stringify(promptVars));
  const levelDefaultsHash = sortedJsonHash(input.levelDefaults);

  const events = await runSkill({
    skill: SKILL_RUBRIC,
    promptVars,
    allowedTools: [MCP_SUBMIT_RUBRIC],
    attemptId: "rubric-generation",
    questionId: input.questionId,
    timeoutMs: RUBRIC_TIMEOUT_MS,
    model: "claude-sonnet-4-6",
  });

  const raw = parseToolInput(events, TOOL_SUBMIT_RUBRIC);
  if (raw === null) {
    log.error(
      {
        skill: SKILL_RUBRIC,
        questionId: input.questionId,
        expectedTool: TOOL_SUBMIT_RUBRIC,
        rawStreamTruncated: JSON.stringify(events).slice(0, 2048),
      },
      "generation.submit_tool.missing",
    );
    throw new AppError(
      `expected ${TOOL_SUBMIT_RUBRIC} tool use in stream-json output`,
      AI_GRADING_ERROR_CODES.SCHEMA_VIOLATION,
      503,
      { details: { skill: SKILL_RUBRIC, questionId: input.questionId } },
    );
  }

  const parsed = SubmitRubricOutputSchema.safeParse(raw);
  if (!parsed.success) {
    log.error(
      {
        skill: SKILL_RUBRIC,
        questionId: input.questionId,
        expectedTool: TOOL_SUBMIT_RUBRIC,
        rawPayloadTruncated: JSON.stringify(raw).slice(0, 2048),
        issues: parsed.error.issues,
      },
      "generation.submit_tool.schema_failed",
    );
    throw new AppError(
      "submit_rubric payload failed schema validation",
      AI_GRADING_ERROR_CODES.SCHEMA_VIOLATION,
      503,
      { details: { issues: parsed.error.issues, questionId: input.questionId } },
    );
  }

  log.info(
    {
      questionId: input.questionId,
      levelOrdinal: input.levelOrdinal,
      levelDefaultsHash,
      skillSha: rubricSkillSha.short,
      promptSha,
    },
    "rubric-generation.skill.complete",
  );

  return {
    rubric: parsed.data.rubric as Rubric,
    skillSha: rubricSkillSha.short,
    promptSha,
    levelDefaultsHash,
    model: rubricSkillSha.model,
  };
}

// ---------------------------------------------------------------------------
// runSkill — single `claude -p` subprocess, returns parsed stream-json events
// ---------------------------------------------------------------------------

interface RunSkillOpts {
  skill: string;
  promptVars: object;
  allowedTools: string[];
  attemptId: string;
  questionId: string;
  timeoutMs?: number;
  model?: string;
}

function runSkill(opts: RunSkillOpts): Promise<StreamJsonEvent[]> {
  const prompt =
    `Use the ${opts.skill} skill with these inputs:\n\n` +
    JSON.stringify(opts.promptVars, null, 2);

  return new Promise<StreamJsonEvent[]>((resolve, reject) => {
    const args = [
      "-p",
      prompt,
      "--verbose",
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
    if (opts.model) {
      args.push("--model", opts.model);
    }

    const startedAt = Date.now();
    const proc = spawn("claude", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    // Full stderr buffer — see privacy gate comment below before adding any log.
    let stderrFull = "";
    const events: StreamJsonEvent[] = [];

    // Stage-timing counters
    let firstEventAt: number | null = null;
    let lastEventAt: number | null = null;
    const eventCounts = { assistant: 0, tool_use: 0, tool_result: 0, result: 0, rate_limit_event: 0 };

    // Privacy gate: true for generation skills — stderr carries no candidate text.
    // For grading skills the gate stays closed: stderr is captured in memory but
    // NEVER logged or persisted (candidate-answer leakage risk per D8/docs/11-observability.md).
    const isGenerationSkill =
      opts.skill === "generate-questions" || opts.skill === "generate-rubric";

    const timeoutMs = opts.timeoutMs ?? STAGE_TIMEOUT_MS;
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(
        new AppError(
          `claude subprocess timed out after ${timeoutMs}ms (skill=${opts.skill})`,
          AI_GRADING_ERROR_CODES.RUNTIME_FAILURE,
          503,
          { details: { skill: opts.skill, attemptId: opts.attemptId } },
        ),
      );
    }, timeoutMs);

    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      const { events: parsed, remainder } = parseStreamLines(stdoutBuf);
      for (const ev of parsed) {
        events.push(ev);
        const now = Date.now();
        if (firstEventAt === null) firstEventAt = now;
        lastEventAt = now;
        // Count top-level event types for the summary log.
        if (ev.type === "assistant") eventCounts.assistant++;
        if (ev.type === "result") eventCounts.result++;
        if (ev.type === "rate_limit_event") eventCounts.rate_limit_event++;
        // Walk content items for tool_use / tool_result counts.
        // Also promote tool_use to info — keys only, never values
        // (tool inputs may carry question text — verbose but not sensitive;
        // values are still omitted to keep logs concise).
        const content = ev.message?.content;
        if (Array.isArray(content)) {
          for (const item of content) {
            if (item.type === "tool_use") {
              eventCounts.tool_use++;
              const inputKeys =
                item.input && typeof item.input === "object"
                  ? Object.keys(item.input as Record<string, unknown>).slice(0, 8)
                  : [];
              log.info(
                { skill: opts.skill, tool_name: item.name, tool_input_keys: inputKeys },
                "claude.tool_use",
              );
            }
            if (item.type === "tool_result") eventCounts.tool_result++;
          }
        }
      }
      stdoutBuf = remainder;
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      // Accumulate full stderr. The privacy gate (isGenerationSkill) determines
      // whether this buffer is ever emitted — it must never escape for grading
      // skills. Buffer is bounded at process exit by the 1024-byte slice below.
      stderrFull += chunk.toString("utf8");
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
      const msToFirstEvent = firstEventAt !== null ? firstEventAt - startedAt : null;
      const msToLastEvent = lastEventAt !== null ? lastEventAt - startedAt : null;

      // Privacy gate: log stderr tail ONLY for generation skills.
      // Grading skill stderr is captured above but discarded here.
      const stderrTailForLog = isGenerationSkill && stderrFull.length > 0
        ? stderrFull.slice(-1024)
        : null;
      if (stderrTailForLog !== null) {
        log.warn(
          { skill: opts.skill, stderrTail: stderrTailForLog },
          "claude.subprocess.stderr",
        );
      }

      log.info(
        {
          skill: opts.skill,
          model: opts.model ?? "default",
          attemptId: opts.attemptId,
          questionId: opts.questionId,
          exitCode: code,
          durationMs,
          msToFirstEvent,
          msToLastEvent,
          eventCounts,
        },
        "claude.subprocess.summary",
      );

      if (code === 0) {
        resolve(events);
      } else {
        // Privacy gate: include stderrTail in AppError details for generation
        // skills only so the handler can persist it to generation_attempts.
        // For grading skills the field is absent — never persisted.
        const stderrTailForError = isGenerationSkill && stderrFull.length > 0
          ? stderrFull.slice(-1024)
          : undefined;
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
                ...(stderrTailForError !== undefined
                  ? { stderrTail: stderrTailForError }
                  : {}),
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
