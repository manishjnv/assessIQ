/**
 * Handler: POST /admin/packs/:packId/levels/:levelId/generate
 *
 * Generates SOC-grounded ai_draft questions for an existing pack/level by
 * calling the generate-questions skill through the claude-code-vps runtime.
 *
 * D2 compliance: This is the THIRD file on the CLAUDE_SPAWN_ALLOW_LIST in
 *   modules/07-ai-grading/ci/lint-no-ambient-claude.ts.  Adding it to the
 *   allow-list requires adversarial review (codex:rescue) per CLAUDE.md.
 *
 *   This file does NOT import child_process or spawn anything directly.
 *   Generation is delegated through generateQuestions() in the runtime-selector,
 *   which in turn calls through to runtimes/claude-code-vps.ts — the single
 *   file authorised to spawn.
 *
 * D8 compliance: Generated questions land with status='ai_draft'.  They are
 *   NEVER visible to candidates until an admin explicitly promotes them to
 *   'active'.  This handler commits questions to DB before returning so the
 *   admin sees them immediately in the pack UI.  (Contrast: grading proposals
 *   are NOT committed until admin-accept.  Generation is different — the
 *   ai_draft status IS the "review gate".)
 *
 * Single-flight: shares the same singleFlight mutex as grading — only one
 *   AI subprocess (grading or generation) runs per API process at a time.
 *   The D7 budget gate is bypassed for generation (generation is not tied to
 *   an attempt and has its own count gate of 1-10 questions per call).
 *
 * No ambient AI: this handler is called only from the Fastify route registered
 *   by registerQuestionBankRoutes → the admin-only POST endpoint.  It must
 *   never be imported by a cron job, BullMQ worker, or candidate-facing path.
 */

import { AppError, config, streamLogger, uuidv7 } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { AI_GRADING_ERROR_CODES } from "../types.js";
import { generateQuestions } from "../runtime-selector.js";
import { singleFlight } from "../single-flight.js";
import type { GenerateQuestionsInput, GenerateQuestionsOutput } from "../types.js";
import type { PoolClient } from "pg";

const log = streamLogger("generation");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One KB source entry — mirrors KbSource from @assessiq/question-bank KB. */
export interface KbSourceRef {
  id: string;
  name: string;
  citation: string;
  url: string;
  level_fit: "L1" | "L2" | "L3";
  function: string;
  description: string;
  tags: string[];
  kb_version: string;
}

export interface HandleAdminGenerateInput {
  tenantId: string;
  userId: string;
  packId: string;
  levelId: string;
  /** 1-10. Validated by the route layer before this handler is called. */
  count: number;
  /**
   * SOC level for this generation run.
   * Inferred by the caller from the level label (L1/L2/L3).
   */
  socLevel: "L1" | "L2" | "L3";
  /**
   * Curated KB sources selected by the caller from the SOC KB.
   * Passed as plain data to avoid a cross-module dep from ai-grading → question-bank.
   */
  sources: KbSourceRef[];
  /**
   * Existing topic strings in this pack+level — for duplicate avoidance.
   * Loaded by the caller before invoking this handler.
   */
  existingTopics: string[];
}

export interface HandleAdminGenerateOutput {
  /** IDs of the newly-created ai_draft questions. */
  questionIds: string[];
  /** Count actually inserted (may be < requested if KB sources were thin). */
  generated: number;
  /** Short SHA of the generate-questions skill used for this run. */
  skillSha: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Insert ai_draft questions returned by the generator into the questions table.
 * Wrapped in the outer withTenant transaction.
 */
async function insertDrafts(
  client: PoolClient,
  input: HandleAdminGenerateInput,
  output: GenerateQuestionsOutput,
): Promise<string[]> {
  const ids: string[] = [];
  for (const q of output.questions) {
    const id = uuidv7();
    await client.query(
      `INSERT INTO questions
         (id, pack_id, level_id, type, topic, points, status, content, rubric,
          knowledge_base_sources, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'ai_draft', $7::jsonb, $8::jsonb, $9::jsonb, $10)`,
      [
        id,
        input.packId,
        input.levelId,
        q.type,
        q.topic,
        q.points,
        JSON.stringify(q.content),
        q.rubric !== null && q.rubric !== undefined
          ? JSON.stringify(q.rubric)
          : null,
        JSON.stringify(q.knowledgeBaseSources),
        input.userId,
      ],
    );
    ids.push(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleAdminGenerate(
  input: HandleAdminGenerateInput,
): Promise<HandleAdminGenerateOutput> {
  if (config.AI_PIPELINE_MODE !== "claude-code-vps") {
    throw new AppError(
      `AI question generation requires AI_PIPELINE_MODE=claude-code-vps; got '${config.AI_PIPELINE_MODE}'`,
      AI_GRADING_ERROR_CODES.RUNTIME_NOT_IMPLEMENTED,
      501,
    );
  }

  log.info(
    {
      tenantId: input.tenantId,
      packId: input.packId,
      levelId: input.levelId,
      count: input.count,
      socLevel: input.socLevel,
    },
    "generation.start",
  );

  const mutexKey = `generation:${input.packId}:${input.levelId}`;
  const slot = singleFlight.acquire(mutexKey);
  if (slot.kind === "rejected") {
    throw new AppError(
      `AI generation already in flight for this pack/level (reason: ${slot.reason})`,
      AI_GRADING_ERROR_CODES.GRADING_IN_PROGRESS,
      409,
      { details: { packId: input.packId, levelId: input.levelId } },
    );
  }

  try {
    const result = await withTenant(input.tenantId, async (client) => {
      const genInput: GenerateQuestionsInput = {
        level: input.socLevel,
        count: input.count,
        existingTopics: input.existingTopics,
        sources: input.sources,
        packId: input.packId,
        levelId: input.levelId,
      };

      // Delegate to runtime (only claude-code-vps is implemented)
      const output = await generateQuestions(genInput);

      // Insert ai_draft rows inside the same transaction
      const ids = await insertDrafts(client, input, output);

      log.info(
        {
          tenantId: input.tenantId,
          packId: input.packId,
          levelId: input.levelId,
          generated: ids.length,
          skillSha: output.skillSha,
        },
        "generation.complete",
      );

      return {
        questionIds: ids,
        generated: ids.length,
        skillSha: output.skillSha,
      };
    });

    return result;
  } finally {
    slot.release();
  }
}
