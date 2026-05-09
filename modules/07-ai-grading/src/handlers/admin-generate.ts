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
import { generateQuestions, generateQuestionsByType } from "../runtime-selector.js";
import { singleFlight } from "../single-flight.js";
import { allocateByWeight, applyOverride } from "../auto-weight.js";
import { withConcurrencyLimit } from "../concurrency.js";
import type { GenerateQuestionsInput, GenerateQuestionsOutput, GenerateByTypeInput, QuestionType } from "../types.js";
import type { PoolClient } from "pg";

const log = streamLogger("generation");

// ---------------------------------------------------------------------------
// Parallelism constants
// ---------------------------------------------------------------------------

/** Maximum questions per single generateQuestions() call (skill cap). */
const CHUNK_SIZE = 10;
/** Maximum concurrent generateQuestions() calls for a single request. */
const MAX_PARALLEL = 3;

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
  /** 1-30. Validated by the route layer before this handler is called. */
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
   * Existing topics strings in this pack+level — for duplicate avoidance.
   * Loaded by the caller before invoking this handler.
   */
  existingTopics: string[];
  /**
   * Optional per-type count overrides from the admin UI.
   * When set in sharded mode, applyOverride() adjusts the weight-based
   * allocation so that overridden types hit their exact targets and the
   * remaining types absorb any residual.
   * Silently ignored in omnibus mode (omnibus skill does its own mixing).
   */
  typeCounts?: Partial<Record<QuestionType, number>>;
}

export interface HandleAdminGenerateOutput {
  /** IDs of the newly-created ai_draft questions. */
  questionIds: string[];
  /** Count actually inserted (may be < requested if KB sources were thin). */
  generated: number;
  /** Short SHA of the generate-questions skill used for this run. */
  skillSha: string;
}

/**
 * Insert ai_draft questions returned by the generator into the questions table.
 * Wrapped in the outer withTenant transaction.
 *
 * @param attemptId - propagated to error logs so the failing row is traceable.
 */
async function insertDrafts(
  client: PoolClient,
  input: HandleAdminGenerateInput,
  output: GenerateQuestionsOutput,
  attemptId: string,
): Promise<string[]> {
  const ids: string[] = [];
  for (const q of output.questions) {
    const id = uuidv7();
    try {
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
    } catch (err) {
      // Log the failing question's identity before rethrowing so admins
      // can find the structural mismatch without reading the DB payload.
      log.error(
        {
          attemptId,
          topic: q.topic,
          type: q.type,
          dbError: (err as Error).message,
        },
        "generation.insert.failed",
      );
      throw err;
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Attempt-row helpers
// ---------------------------------------------------------------------------

/** Fields used when finalizing a generation_attempts row. */
interface AttemptFinalizeFields {
  status: "success" | "partial" | "failed";
  countInserted?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  stderrTail?: string | null;
  skillSha?: string | null;
  model?: string | null;
  chunksPlanned?: number | null;
  chunksFailed?: number | null;
  dedupeDropped?: number | null;
  durationMs?: number | null;
}

/**
 * Try to UPDATE a generation_attempts row to its terminal state.
 * Errors are swallowed with a warn log — observability must never block
 * the response path or mask the original generation error.
 */
async function tryFinalizeAttempt(
  tenantId: string,
  attemptId: string,
  fields: AttemptFinalizeFields,
): Promise<void> {
  try {
    await withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE generation_attempts
         SET status          = $2,
             count_inserted  = COALESCE($3, count_inserted),
             error_code      = $4,
             error_message   = $5,
             stderr_tail     = $6,
             skill_sha       = $7,
             model           = $8,
             chunks_planned  = $9,
             chunks_failed   = $10,
             dedupe_dropped  = $11,
             duration_ms     = $12,
             finished_at     = now()
         WHERE id = $1`,
        [
          attemptId,
          fields.status,
          fields.countInserted ?? null,
          fields.errorCode ?? null,
          fields.errorMessage ?? null,
          fields.stderrTail ?? null,
          fields.skillSha ?? null,
          fields.model ?? null,
          fields.chunksPlanned ?? null,
          fields.chunksFailed ?? null,
          fields.dedupeDropped ?? null,
          fields.durationMs ?? null,
        ],
      );
    });
  } catch (err) {
    log.warn(
      { attemptId, err: (err as Error).message },
      "generation.attempt.finalize.failed",
    );
  }
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

  const attemptId = uuidv7();
  const generationStartedAt = Date.now();

  // ── Insert 'running' attempt row ──────────────────────────────────────────
  // Non-critical: failure here MUST NOT abort generation. Log and continue.
  // This is observability infrastructure; it must not become a critical-path dep.
  let attemptInserted = false;
  try {
    await withTenant(input.tenantId, async (client) => {
      await client.query(
        `INSERT INTO generation_attempts
           (id, tenant_id, pack_id, level_id, user_id, count_requested, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'running')`,
        [
          attemptId,
          input.tenantId,
          input.packId,
          input.levelId,
          input.userId,
          input.count,
        ],
      );
    });
    attemptInserted = true;
  } catch (insertErr) {
    log.warn(
      { attemptId, err: (insertErr as Error).message },
      "generation.attempt.insert.failed",
    );
  }

  log.info(
    {
      attemptId,
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
    if (attemptInserted) {
      await tryFinalizeAttempt(input.tenantId, attemptId, {
        status: "failed",
        errorCode: AI_GRADING_ERROR_CODES.GRADING_IN_PROGRESS,
        errorMessage: `AI generation already in flight for this pack/level (reason: ${slot.reason})`.slice(0, 1024),
        durationMs: Date.now() - generationStartedAt,
      });
    }
    throw new AppError(
      `AI generation already in flight for this pack/level (reason: ${slot.reason})`,
      AI_GRADING_ERROR_CODES.GRADING_IN_PROGRESS,
      409,
      { details: { packId: input.packId, levelId: input.levelId } },
    );
  }

  // Mutable tracking variables — written inside the withTenant closure,
  // read in the finally block to finalize the attempt row.
  let chunksPlanned: number | undefined;
  let chunksFailed: number | undefined;
  let dedupeDroppedCount: number | undefined;
  let capturedOutput: HandleAdminGenerateOutput | undefined;
  let capturedErr: unknown;

  try {
    capturedOutput = await withTenant(input.tenantId, async (client) => {
      // ── Mode branch ───────────────────────────────────────────────────────
      // AI_GENERATE_MODE='omnibus' (default) → existing chunked/single path.
      // AI_GENERATE_MODE='sharded' → per-type fan-out path (Stage 1).
      if (config.AI_GENERATE_MODE === "sharded") {
        // ── Sharded path ──────────────────────────────────────────────────
        const baseAllocation = allocateByWeight(input.socLevel, input.count);

        // Apply per-type admin overrides when provided; otherwise use the
        // pure weight-based allocation unchanged.
        const typeAllocation = input.typeCounts
          ? applyOverride(baseAllocation, input.typeCounts)
          : baseAllocation;

        // Stage 1: subjective is NOT type-sharded. If the allocator assigns
        // any count to subjective, fold it into mcq (largest sharded type)
        // as a safe fallback. A future prompt will add generate-subjective.
        const shardedAllocation = { ...typeAllocation };
        if (shardedAllocation.subjective > 0) {
          shardedAllocation.mcq += shardedAllocation.subjective;
          shardedAllocation.subjective = 0;
        }

        // Build one GenerateByTypeInput per non-zero type
        const typeEntries = (
          ["mcq", "log_analysis", "scenario", "kql"] as const
        ).filter((t) => shardedAllocation[t] > 0);

        chunksPlanned = typeEntries.length;

        const plan: Record<string, number> = {};
        for (const t of typeEntries) plan[t] = shardedAllocation[t];

        log.info(
          { attemptId, plan, level: input.socLevel },
          "generation.sharded.start",
        );

        const typeInputs: GenerateByTypeInput[] = typeEntries.map((type) => ({
          level: input.socLevel,
          type,
          count: shardedAllocation[type],
          existingTopics: input.existingTopics,
          sources: input.sources,
          packId: input.packId,
          levelId: input.levelId,
        }));

        // 2-concurrent semaphore fan-out
        const SHARDED_CONCURRENCY = 2;
        const settled = await withConcurrencyLimit(
          typeInputs,
          SHARDED_CONCURRENCY,
          (ti) => {
            const typeStart = Date.now();
            return generateQuestionsByType(ti).then((output) => {
              log.info(
                {
                  attemptId,
                  type: ti.type,
                  generated: output.questions.length,
                  durationMs: Date.now() - typeStart,
                  wrongTypeDropped: output.wrongTypeDropped ?? 0,
                },
                "generation.sharded.type.complete",
              );
              return output;
            });
          },
        );

        const fulfilled: GenerateQuestionsOutput[] = [];
        let firstError: unknown = null;
        let localChunksFailed = 0;
        let totalWrongTypeDropped = 0;
        for (const r of settled) {
          if (r.status === "fulfilled") {
            const out = r.value as GenerateQuestionsOutput;
            fulfilled.push(out);
            totalWrongTypeDropped += out.wrongTypeDropped ?? 0;
          } else {
            localChunksFailed++;
            if (firstError === null) firstError = r.reason;
            log.warn(
              { attemptId, err: (r.reason as Error).message },
              "generation.sharded.type.failed",
            );
          }
        }
        chunksFailed = localChunksFailed;

        if (fulfilled.length === 0) {
          throw firstError;
        }

        // Merge + topic-dedupe (case-insensitive, compare against
        // existingTopics + already-merged questions)
        const seenTopics = new Set(
          input.existingTopics.map((t) => t.trim().toLowerCase()),
        );
        const mergedQuestions: GenerateQuestionsOutput["questions"] = [];
        let dedupeDropped = 0;

        for (const chunkOutput of fulfilled) {
          for (const q of chunkOutput.questions) {
            const normalised = q.topic.trim().toLowerCase();
            if (seenTopics.has(normalised)) {
              dedupeDropped++;
            } else {
              seenTopics.add(normalised);
              mergedQuestions.push(q);
            }
          }
        }
        dedupeDroppedCount = dedupeDropped + totalWrongTypeDropped;

        log.info(
          {
            attemptId,
            totalGenerated: mergedQuestions.length,
            dedupeDropped,
            wrongTypeDropped: totalWrongTypeDropped,
            chunksFailed: localChunksFailed,
          },
          "generation.sharded.complete",
        );

        // Collect per-type skill SHAs (comma-joined, truncated to 200 chars)
        const skillShas = fulfilled.map((o) => o.skillSha).join(",").slice(0, 200);
        const model = "claude-sonnet-4-6";

        const mergedOutput: GenerateQuestionsOutput = {
          questions: mergedQuestions,
          skillSha: skillShas,
          model,
        };

        // Single transaction insert
        const ids = await insertDrafts(client, input, mergedOutput, attemptId);

        log.info(
          {
            attemptId,
            tenantId: input.tenantId,
            packId: input.packId,
            levelId: input.levelId,
            generated: ids.length,
            skillSha: skillShas,
          },
          "generation.complete",
        );

        return {
          questionIds: ids,
          generated: ids.length,
          skillSha: skillShas,
          _model: model,
        } as HandleAdminGenerateOutput & { _model?: string };
      }

      if (input.count <= CHUNK_SIZE) {
        // ── Single-call path (count 1-10, omnibus) ───────────────────────
        // type_counts is intentionally ignored by the omnibus skill — the
        // skill does its own mixing. Log at debug for traceability.
        if (input.typeCounts !== undefined) {
          log.debug(
            { attemptId, typeCounts: input.typeCounts },
            "generation.omnibus.type_counts.ignored",
          );
        }
        chunksPlanned = 1;
        const genInput: GenerateQuestionsInput = {
          level: input.socLevel,
          count: input.count,
          existingTopics: input.existingTopics,
          sources: input.sources,
          packId: input.packId,
          levelId: input.levelId,
        };

        const output = await generateQuestions(genInput);
        const ids = await insertDrafts(client, input, output, attemptId);

        log.info(
          {
            attemptId,
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
          _model: output.model,
        } as HandleAdminGenerateOutput & { _model?: string };
      }

      // ── Parallel fan-out path (count 11-30, omnibus) ─────────────────────
      // type_counts is intentionally ignored by the omnibus skill.
      if (input.typeCounts !== undefined) {
        log.debug(
          { attemptId, typeCounts: input.typeCounts },
          "generation.omnibus.type_counts.ignored",
        );
      }
      const totalChunks = Math.min(Math.ceil(input.count / CHUNK_SIZE), MAX_PARALLEL);
      chunksPlanned = totalChunks;
      const plan: number[] = [];
      for (let i = 0; i < totalChunks; i++) {
        plan.push(Math.min(CHUNK_SIZE, input.count - i * CHUNK_SIZE));
      }

      log.info(
        { attemptId, count: input.count, chunks: totalChunks, plan },
        "generation.chunked.start",
      );

      const chunkInputs: GenerateQuestionsInput[] = plan.map((chunkCount) => ({
        level: input.socLevel,
        count: chunkCount,
        existingTopics: input.existingTopics,
        sources: input.sources,
        packId: input.packId,
        levelId: input.levelId,
      }));

      const settled = await Promise.allSettled(
        chunkInputs.map((ci, i) => {
          const chunkStart = Date.now();
          return generateQuestions(ci).then((output) => {
            log.info(
              { attemptId, chunk: i, generated: output.questions.length, durationMs: Date.now() - chunkStart },
              "generation.chunked.chunk",
            );
            return output;
          });
        }),
      );

      const fulfilled: GenerateQuestionsOutput[] = [];
      let firstError: unknown = null;
      let localChunksFailed = 0;
      for (const r of settled) {
        if (r.status === "fulfilled") {
          fulfilled.push(r.value);
        } else {
          localChunksFailed++;
          if (firstError === null) firstError = r.reason;
          log.warn(
            { attemptId, err: (r.reason as Error).message },
            "generation.chunked.chunk.failed",
          );
        }
      }
      chunksFailed = localChunksFailed;

      if (fulfilled.length === 0) {
        throw firstError;
      }

      const seenTopics = new Set(
        input.existingTopics.map((t) => t.trim().toLowerCase()),
      );
      const mergedQuestions: GenerateQuestionsOutput["questions"] = [];
      let dedupeDropped = 0;

      for (const chunkOutput of fulfilled) {
        for (const q of chunkOutput.questions) {
          const normalised = q.topic.trim().toLowerCase();
          if (seenTopics.has(normalised)) {
            dedupeDropped++;
          } else {
            seenTopics.add(normalised);
            mergedQuestions.push(q);
          }
        }
      }
      dedupeDroppedCount = dedupeDropped;

      log.info(
        { attemptId, totalGenerated: mergedQuestions.length, dedupeDropped },
        "generation.chunked.complete",
      );

      const skillSha = fulfilled[0]!.skillSha;
      const model = fulfilled[0]!.model;

      const mergedOutput: GenerateQuestionsOutput = {
        questions: mergedQuestions,
        skillSha,
        ...(model !== undefined ? { model } : {}),
      };

      const ids = await insertDrafts(client, input, mergedOutput, attemptId);

      log.info(
        {
          attemptId,
          tenantId: input.tenantId,
          packId: input.packId,
          levelId: input.levelId,
          generated: ids.length,
          skillSha,
        },
        "generation.complete",
      );

      return {
        questionIds: ids,
        generated: ids.length,
        skillSha,
        _model: model,
      } as HandleAdminGenerateOutput & { _model?: string };
    });
  } catch (err) {
    capturedErr = err;
  } finally {
    slot.release();
    // Guarantee the attempt row is always finalized, even if this finally
    // block runs due to an uncaught throw above.
    if (attemptInserted) {
      const durationMs = Date.now() - generationStartedAt;
      if (capturedErr !== undefined) {
        const ae = capturedErr as {
          code?: string;
          message?: string;
          details?: Record<string, unknown>;
        };
        const stderrTail =
          typeof ae.details?.["stderrTail"] === "string"
            ? (ae.details["stderrTail"] as string)
            : null;
        await tryFinalizeAttempt(input.tenantId, attemptId, {
          status: "failed",
          errorCode: ae.code ?? null,
          errorMessage: ae.message?.slice(0, 1024) ?? null,
          stderrTail,
          durationMs,
        });
      } else if (capturedOutput !== undefined) {
        const out = capturedOutput as HandleAdminGenerateOutput & { _model?: string };
        const status = (chunksFailed ?? 0) > 0 ? "partial" : "success";
        await tryFinalizeAttempt(input.tenantId, attemptId, {
          status,
          countInserted: out.generated,
          skillSha: out.skillSha,
          model: out._model ?? null,
          chunksPlanned: chunksPlanned ?? null,
          chunksFailed: chunksFailed ?? null,
          dedupeDropped: dedupeDroppedCount ?? null,
          durationMs,
        });
      }
    }
  }

  if (capturedErr !== undefined) throw capturedErr as Error;
  // Strip internal _model field before returning to callers.
  const { _model: _unused, ...output } = capturedOutput as HandleAdminGenerateOutput & { _model?: string };
  void _unused;
  return output;
}

