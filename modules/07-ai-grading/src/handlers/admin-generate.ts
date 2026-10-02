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
import { withTenant, findTenantSettings } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import { AI_GRADING_ERROR_CODES } from "../types.js";
import { generateQuestions, generateQuestionsByType } from "../runtime-selector.js";
import { singleFlight } from "../single-flight.js";
import { allocateByWeight, applyOverride } from "../auto-weight.js";
import { withConcurrencyLimit } from "../concurrency.js";
import type { GenerateQuestionsInput, GenerateQuestionsOutput, GenerateByTypeInput, GeneratedQuestionDraft, QuestionType } from "../types.js";
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
  /**
   * Optional domain tag. Set only after explicit cross-tenant validation in the
   * service layer (see generateQuestions in 04-question-bank/src/service.ts).
   * Postgres FK validation bypasses RLS — the service guard is the primary
   * security control, not the FK constraint.
   */
  domainId?: string | undefined;
  /**
   * Optional category tag. Set only after explicit cross-tenant validation.
   * Both domainId and categoryId must be provided together or both omitted.
   */
  categoryId?: string | undefined;
  /**
   * Optional client-minted batch UUID shared by every per-category call of one
   * "Generate question set" wizard action, so the read-only history UI can
   * collapse them into a single expandable row. Validated as a UUID at the route
   * layer; persisted verbatim onto generation_attempts.batch_id. NULL when the
   * caller did not supply one (legacy / single-call) — those rows render
   * standalone, exactly as before. NOT a tenant boundary; never used for
   * isolation (RLS on tenant_id is authoritative).
   */
  batchId?: string | undefined;
  /**
   * Difficulty injection (Phase A3). Built by the caller (04 service.ts) which
   * owns difficulty-spec.ts; passed as in-process data + bound closures to
   * preserve the ai-grading → question-bank no-import boundary (04 depends on
   * 07, never the reverse — see service.ts dynamic import). Optional for
   * back-compat: when absent, the structural difficulty gate and difficulty
   * tagging are no-ops.
   */
  difficulty?: {
    /** Per-type target vector for THIS level; serializable, fed to the skill input + stamped as difficulty_params. */
    byType: Record<string, unknown>;
    /** Structural gate bound to this level (authoritative — lives in difficulty-spec.ts). */
    validate: (
      type: QuestionType,
      content: unknown,
      rubric: unknown,
    ) => { ok: true } | { ok: false; reason: string };
    /** KbSource.function → NICE work-role. */
    niceForFunction: (fn: string) => string;
  };
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
// Citation enforcement helper
// ---------------------------------------------------------------------------

/**
 * Drop any question whose knowledge_base_source_ids contains a value not
 * present in validSourceIds.  Also drops questions with an empty id list —
 * the canonical contract requires at least one source per question.
 *
 * This is the mechanical enforcement of the citation HARD RULE.  The same
 * rule exists as wording in the generate-* SKILL.md files, but the model
 * repeatedly ignores it (mitre.t1003 / T1558.003 leaking through despite
 * three SKILL.md revisions).  Enforcement here is authoritative; SKILL.md
 * wording is now advisory documentation only.
 *
 * Called from all three generation paths (sharded, omnibus single-call,
 * omnibus chunked) so the filter is uniform regardless of mode.
 */
function filterByCitation<T extends { knowledge_base_source_ids?: string[] }>(
  questions: T[],
  validSourceIds: Set<string>,
  onDrop: (q: T, invalidIds: string[]) => void,
): T[] {
  const kept: T[] = [];
  for (const q of questions) {
    const ids = q.knowledge_base_source_ids ?? [];
    const invalidIds = ids.filter((id) => !validSourceIds.has(id));
    if (ids.length === 0 || invalidIds.length > 0) {
      onDrop(q, invalidIds);
    } else {
      kept.push(q);
    }
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Structural difficulty gate helper (Phase A3)
// ---------------------------------------------------------------------------

/**
 * Drop any question that fails the structural difficulty gate for its
 * (type, level) — e.g. an L1 MCQ without exactly 4 options, an L3 scenario
 * with too many steps. The gate logic is authoritative in difficulty-spec.ts
 * (04-question-bank) and injected here as `validate` to avoid a cross-module
 * import (04 depends on 07, never the reverse). No-op when `validate` is
 * absent (back-compat). Runs AFTER filterByCitation in every generation path
 * so the two post-generation quality filters compose uniformly.
 */
function filterByDifficulty(
  questions: GeneratedQuestionDraft[],
  validate:
    | ((
        type: QuestionType,
        content: unknown,
        rubric: unknown,
      ) => { ok: true } | { ok: false; reason: string })
    | undefined,
  onDrop: (q: GeneratedQuestionDraft, reason: string) => void,
): GeneratedQuestionDraft[] {
  if (!validate) return questions;
  const kept: GeneratedQuestionDraft[] = [];
  for (const q of questions) {
    const verdict = validate(q.type, q.content, q.rubric);
    if (verdict.ok) {
      kept.push(q);
    } else {
      onDrop(q, verdict.reason);
    }
  }
  return kept;
}

// ---------------------------------------------------------------------------
// DB helpers — insertDrafts
// ---------------------------------------------------------------------------

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
      // domain_id / category_id: nullable UUID columns added in migration 0018.
      // They are set only when the service layer has already cross-tenant
      // validated the FK pair (FK validation bypasses RLS — see service.ts guard).
      //
      // Difficulty tags (Phase A3, migration 0086): stamped deterministically
      // from the injected per-(type,level) target. cognitive_level = the target's
      // primary Bloom level; difficulty_params = the full target vector;
      // nice_task_id = NICE work-role mapped from the primary cited source's
      // function. attack_technique is left NULL (Phase B). All NULL when the
      // caller did not inject difficulty (back-compat).
      const diffTarget =
        input.difficulty !== undefined
          ? (input.difficulty.byType[q.type] as
              | { cognitiveLevel?: string[] }
              | undefined)
          : undefined;
      const cognitiveLevel = diffTarget?.cognitiveLevel?.[0] ?? null;
      const difficultyParams =
        diffTarget !== undefined ? JSON.stringify(diffTarget) : null;
      const niceTaskId =
        input.difficulty !== undefined
          ? input.difficulty.niceForFunction(
              q.knowledgeBaseSources[0]?.function ?? "",
            )
          : null;
      await client.query(
        `INSERT INTO questions
           (id, pack_id, level_id, type, topic, points, status, content, rubric,
            knowledge_base_sources, created_by, domain_id, category_id,
            cognitive_level, nice_task_id, difficulty_params)
         VALUES ($1, $2, $3, $4, $5, $6, 'ai_draft', $7::jsonb, $8::jsonb, $9::jsonb, $10,
                 $11::uuid, $12::uuid, $13, $14, $15::jsonb)`,
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
          input.domainId ?? null,
          input.categoryId ?? null,
          cognitiveLevel,
          niceTaskId,
          difficultyParams,
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
  /** Questions dropped because knowledge_base_source_ids contained IDs not in input.sources. */
  citationDropped?: number | null;
  /** Questions dropped by the structural difficulty gate (Phase A3). */
  difficultyDropped?: number | null;
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
             citation_dropped = $12,
             duration_ms     = $13,
             difficulty_dropped = $14,
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
          fields.citationDropped ?? null,
          fields.durationMs ?? null,
          fields.difficultyDropped ?? null,
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
// Shared generation plan (RV64)
// ---------------------------------------------------------------------------

/** Maximum concurrent runtime calls inside one generation plan. */
const PLAN_CONCURRENCY = 2;

/** One runtime call in a generation plan (one type shard or one omnibus chunk). */
interface GenerationChunk {
  /** Used in the aggregated stderr header ("--- chunk: <label> ---"). */
  label: string;
  /** Extra fields for the per-chunk log lines (e.g. { type } or { chunk }). */
  logFields: Record<string, unknown>;
  /** Runs the runtime call; `focus` carries the optional topicFocus (RV62). */
  run: (focus: { topicFocus?: string }) => Promise<GenerateQuestionsOutput>;
}

/** Counters the finally block of handleAdminGenerate reads to finalize the attempt row. */
interface GenerationStats {
  chunksFailed?: number;
  citationDropped?: number;
  dedupeDropped?: number;
  difficultyDropped?: number;
  /** Aggregated per-chunk stderr; null when no chunk failed. */
  stderrTail: string | null;
}

/**
 * Runs every chunk (concurrency 2, allSettled semantics), then citation filter,
 * topic de-dup (vs existing + already-merged), difficulty gate, insert and one
 * audit row. Single code path for sharded / single-call / chunked omnibus.
 * Throws the first chunk error when every chunk failed (the caller's finally
 * block finalizes the generation_attempts row — never finalize here).
 */
async function runGenerationPlan(
  client: PoolClient,
  input: HandleAdminGenerateInput,
  attemptId: string,
  mode: "omnibus" | "sharded",
  logPrefix: "sharded" | "omnibus" | "chunked",
  chunks: GenerationChunk[],
  chunkEvents: { ok: string; fail: string } | null,
  stats: GenerationStats,
): Promise<HandleAdminGenerateOutput & { _model?: string }> {
  const focus: { topicFocus?: string } = {};
  const settled = await withConcurrencyLimit(chunks, PLAN_CONCURRENCY, (c) => {
    const start = Date.now();
    return c.run(focus).then((output) => {
      if (chunkEvents !== null) {
        log.info(
          {
            attemptId,
            ...c.logFields,
            generated: output.questions.length,
            durationMs: Date.now() - start,
            ...(logPrefix === "sharded" ? { wrongTypeDropped: output.wrongTypeDropped ?? 0 } : {}),
          },
          chunkEvents.ok,
        );
      }
      return output;
    });
  });

  const fulfilled: GenerateQuestionsOutput[] = [];
  let firstError: unknown = null;
  let failed = 0;
  let totalWrongTypeDropped = 0;
  const stderrParts: string[] = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i]!;
    if (r.status === "fulfilled") {
      const out = r.value as GenerateQuestionsOutput;
      fulfilled.push(out);
      totalWrongTypeDropped += out.wrongTypeDropped ?? 0;
    } else {
      failed++;
      if (firstError === null) firstError = r.reason;
      const details = (r.reason as { details?: { stderrTail?: unknown } } | undefined)?.details;
      const stderrEntry = typeof details?.stderrTail === "string" ? details.stderrTail : "(none)";
      stderrParts.push(`--- chunk: ${chunks[i]?.label ?? "unknown"} ---\n${stderrEntry}\n`);
      if (chunkEvents !== null) {
        log.warn({ attemptId, err: (r.reason as Error).message }, chunkEvents.fail);
      }
    }
  }
  stats.chunksFailed = failed;
  stats.stderrTail = stderrParts.length === 0 ? null : stderrParts.join("").slice(-1024);
  if (fulfilled.length === 0) throw firstError;

  // Citation enforcement (mechanical; see filterByCitation).
  const validSourceIds = new Set(input.sources.map((s) => s.id));
  let citationDropped = 0;
  const cited = fulfilled.map((chunk) =>
    filterByCitation(chunk.questions, validSourceIds, (q, invalidIds) => {
      citationDropped++;
      log.warn(
        {
          attemptId,
          type: (q as GeneratedQuestionDraft).type,
          topic: (q as GeneratedQuestionDraft).topic,
          invalidIds: invalidIds.slice(0, 5),
          sample_valid_id: validSourceIds.values().next().value,
        },
        `generation.${logPrefix}.citation.dropped`,
      );
    }),
  );
  stats.citationDropped = citationDropped;
  log.info(
    { attemptId, citationDropped, totalDroppedForCitation: citationDropped },
    `generation.${logPrefix}.citation.summary`,
  );

  // Merge + topic de-dup (case-insensitive) vs existingTopics AND already-merged questions.
  const seenTopics = new Set(input.existingTopics.map((t) => t.trim().toLowerCase()));
  const merged: GeneratedQuestionDraft[] = [];
  let dedupeDropped = 0;
  for (const qs of cited) {
    for (const q of qs) {
      const normalised = q.topic.trim().toLowerCase();
      if (seenTopics.has(normalised)) {
        dedupeDropped++;
      } else {
        seenTopics.add(normalised);
        merged.push(q);
      }
    }
  }
  stats.dedupeDropped = dedupeDropped + totalWrongTypeDropped;
  log.info(
    {
      attemptId,
      totalGenerated: merged.length,
      dedupeDropped,
      wrongTypeDropped: totalWrongTypeDropped,
      chunksFailed: failed,
    },
    `generation.${logPrefix}.complete`,
  );

  // Structural difficulty gate (Phase A3) — after citation + dedupe.
  let difficultyDropped = 0;
  const gated = filterByDifficulty(merged, input.difficulty?.validate, (q, reason) => {
    difficultyDropped++;
    log.warn(
      { attemptId, type: q.type, topic: q.topic, reason },
      `generation.${logPrefix}.difficulty.dropped`,
    );
  });
  stats.difficultyDropped = difficultyDropped;

  // Skill sha(s) + model come from the runtime output, never hardcoded.
  const skillSha = fulfilled.map((o) => o.skillSha).join(",").slice(0, 200);
  const model = fulfilled[0]!.model;
  const mergedOutput: GenerateQuestionsOutput = {
    questions: gated,
    skillSha,
    ...(model !== undefined ? { model } : {}),
  };

  const ids = await insertDrafts(client, input, mergedOutput, attemptId);

  await auditInTx(client, {
    action: "question.ai_generated",
    actorKind: "user",
    actorUserId: input.userId,
    tenantId: input.tenantId,
    entityType: "question",
    after: {
      generation_attempt_id: attemptId,
      pack_id: input.packId,
      level_id: input.levelId,
      count_requested: input.count,
      count_inserted: ids.length,
      skill_sha: skillSha,
      model,
      mode,
      question_ids: ids.slice(0, 50),
    },
  });

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

  return { questionIds: ids, generated: ids.length, skillSha, _model: model } as HandleAdminGenerateOutput & { _model?: string };
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
           (id, tenant_id, pack_id, level_id, user_id, count_requested, status, batch_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'running', $7::uuid)`,
        [
          attemptId,
          input.tenantId,
          input.packId,
          input.levelId,
          input.userId,
          input.count,
          input.batchId ?? null,
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
  let capturedOutput: HandleAdminGenerateOutput | undefined;
  let capturedErr: unknown;
  // Counters + aggregated per-chunk stderr, written by runGenerationPlan
  // inside withTenant and read in the finally block.
  const stats: GenerationStats = { stderrTail: null };

  try {
    capturedOutput = await withTenant(input.tenantId, async (client) => {
      // ── Per-tenant mode resolution ────────────────────────────────────────
      // Stage 3.0: tenant_settings.ai_generate_mode takes precedence over the
      // global AI_GENERATE_MODE env var. NULL means "use global default".
      // findTenantSettings uses the client already inside this withTenant
      // transaction — no additional DB round-trip or withTenant nesting.
      const tenantSettings = await findTenantSettings(client);
      const generateMode: "omnibus" | "sharded" =
        tenantSettings?.ai_generate_mode ?? config.AI_GENERATE_MODE;

      // ── Mode branch ───────────────────────────────────────────────────────
      // generateMode='omnibus' (default) → existing chunked/single path.
      // generateMode='sharded' → per-type fan-out path (Stage 1).
      if (generateMode === "sharded") {
        // ── Sharded path: one runtime call per non-zero question type ─────
        const baseAllocation = allocateByWeight(input.socLevel, input.count);

        // Apply per-type admin overrides when provided; otherwise use the
        // pure weight-based allocation unchanged.
        const shardedAllocation = input.typeCounts
          ? applyOverride(baseAllocation, input.typeCounts)
          : baseAllocation;

        // Build one GenerateByTypeInput per non-zero type
        const typeEntries = (
          ["mcq", "log_analysis", "scenario", "kql", "subjective"] as const
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
          difficulty: input.difficulty?.byType[type] ?? null,
        }));

        return runGenerationPlan(
          client,
          input,
          attemptId,
          "sharded",
          "sharded",
          typeInputs.map((ti) => ({
            label: ti.type,
            logFields: { type: ti.type },
            run: (focus) => generateQuestionsByType({ ...ti, ...focus }),
          })),
          { ok: "generation.sharded.type.complete", fail: "generation.sharded.type.failed" },
          stats,
        );
      }

      // type_counts is intentionally ignored by the omnibus skill — the
      // skill does its own mixing. Log at debug for traceability.
      if (input.typeCounts !== undefined) {
        log.debug(
          { attemptId, typeCounts: input.typeCounts },
          "generation.omnibus.type_counts.ignored",
        );
      }

      // Omnibus: one call (count 1-10) or up to MAX_PARALLEL chunks (11-30).
      const single = input.count <= CHUNK_SIZE;
      const counts: number[] = [];
      if (single) {
        counts.push(input.count);
      } else {
        const totalChunks = Math.min(Math.ceil(input.count / CHUNK_SIZE), MAX_PARALLEL);
        for (let i = 0; i < totalChunks; i++) {
          counts.push(Math.min(CHUNK_SIZE, input.count - i * CHUNK_SIZE));
        }
        log.info(
          { attemptId, count: input.count, chunks: totalChunks, plan: counts },
          "generation.chunked.start",
        );
      }
      chunksPlanned = counts.length;

      const chunkInputs: GenerateQuestionsInput[] = counts.map((chunkCount) => ({
        level: input.socLevel,
        count: chunkCount,
        existingTopics: input.existingTopics,
        sources: input.sources,
        packId: input.packId,
        levelId: input.levelId,
        difficulty: input.difficulty?.byType ?? null,
      }));

      return runGenerationPlan(
        client,
        input,
        attemptId,
        "omnibus",
        single ? "omnibus" : "chunked",
        chunkInputs.map((ci, i) => ({
          label: single ? "omnibus" : String(i),
          logFields: { chunk: i },
          run: (focus) => generateQuestions({ ...ci, ...focus }),
        })),
        single ? null : { ok: "generation.chunked.chunk", fail: "generation.chunked.chunk.failed" },
        stats,
      );
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
        // Prefer the multi-chunk aggregated value (sharded path) over the
        // single-error stderrTail from the thrown error (which covers only
        // the first failed chunk).  Falls back to the error's stderrTail for
        // non-sharded failures (omnibus single-call / omnibus chunked).
        const stderrTail =
          stats.stderrTail !== null
            ? stats.stderrTail
            : typeof ae.details?.["stderrTail"] === "string"
              ? (ae.details["stderrTail"] as string)
              : null;
        await tryFinalizeAttempt(input.tenantId, attemptId, {
          status: "failed",
          errorCode: ae.code ?? null,
          errorMessage: ae.message?.slice(0, 1024) ?? null,
          stderrTail,
          chunksPlanned: chunksPlanned ?? null,
          chunksFailed: stats.chunksFailed ?? null,
          durationMs,
        });
      } else if (capturedOutput !== undefined) {
        const out = capturedOutput as HandleAdminGenerateOutput & { _model?: string };
        const status = (stats.chunksFailed ?? 0) > 0 ? "partial" : "success";
        await tryFinalizeAttempt(input.tenantId, attemptId, {
          status,
          countInserted: out.generated,
          skillSha: out.skillSha,
          model: out._model ?? null,
          chunksPlanned: chunksPlanned ?? null,
          chunksFailed: stats.chunksFailed ?? null,
          dedupeDropped: stats.dedupeDropped ?? null,
          citationDropped: stats.citationDropped ?? null,
          difficultyDropped: stats.difficultyDropped ?? null,
          durationMs,
          stderrTail: stats.stderrTail,
        });
      }
    }
  }

  // E6: record this category on the server-side batch plan (best-effort — must
  // never fail or mask the generation response, same as the attempts row).
  if (capturedErr === undefined && input.batchId && input.categoryId) {
    try {
      await withTenant(input.tenantId, async (client) => {
        await client.query(
          `UPDATE generation_batches
              SET completed_category_ids = (
                    SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb)
                      FROM jsonb_array_elements_text(completed_category_ids || to_jsonb($3::text)) v),
                  updated_at = now()
            WHERE id = $1::uuid AND tenant_id = $2`,
          [input.batchId, input.tenantId, input.categoryId],
        );
      });
    } catch (batchErr) {
      log.warn({ attemptId, err: (batchErr as Error).message }, "generation.batch.progress.failed");
    }
  }

  if (capturedErr !== undefined) throw capturedErr as Error;
  // Strip internal _model field before returning to callers.
  const { _model: _unused, ...output } = capturedOutput as HandleAdminGenerateOutput & { _model?: string };
  void _unused;
  return output;
}

