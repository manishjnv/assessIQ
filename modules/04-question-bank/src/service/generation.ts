/**
 * Domain pack resolver, AI generation and rubric generator (E9 split of service.ts).
 */

import {
  NotFoundError,
  ValidationError,
  uuidv7,
} from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import { deriveQuestionTextForGuidance } from "../answer-guidance-derive.js";
import { QB_ERROR_CODES } from "../types.js";
import * as repo from "../repository.js";
import {
  log,
  isUniqueViolation,
} from "./_shared.js";

// ===========================================================================
// DOMAIN-BASED PACK RESOLVER (Slice 2.1c — C1)
// ===========================================================================

/**
 * Find or create an auto-managed pack for a given (tenant, domain) pair.
 *
 * Design: 1 pack per (tenant, domain), identified by the reserved slug
 * `dom-<domainSlug>`. Three levels L1/L2/L3 are healed into it (positions
 * 1/2/3; 60min / 10q / 60%). The pack is INTERNAL — the admin never sees it.
 *
 * Security:
 *  - Cross-tenant guard FIRST (same hardened pattern as 2.1b). Fail-closed.
 *  - tenant_id explicit on INSERT (satisfies WITH CHECK RLS on question_packs).
 *  - Levels derive tenancy via FK chain — no tenant_id on level INSERT (matches
 *    the repository comment: "levels has no tenant_id column").
 *
 * Idempotency:
 *  - pack UNIQUE(tenant_id, slug, version) → catch 23505 → re-query → continue.
 *  - levels: query existing labels, insert only the missing ones (never delete).
 *  - Returns exactly 3 level IDs — never <3 (heal loop prevents it).
 */
export async function findOrCreatePackForDomain(
  tenantId: string,
  domainId: string,
  createdByUserId: string,
): Promise<{ packId: string; levelIds: { L1: string; L2: string; L3: string } }> {
  log.info({ tenantId, domainId }, "findOrCreatePackForDomain");

  return withTenant(tenantId, async (client) => {
    // ── 1. Cross-tenant guard FIRST (fail-closed) ──────────────────────────
    // Postgres FK validation bypasses RLS. This explicit query is the primary
    // security control preventing a pack from being created for a domain that
    // belongs to another tenant.
    const guardResult = await client.query<{ slug: string; name: string }>(
      `SELECT slug, name FROM domains WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [domainId, tenantId],
    );
    if (guardResult.rows.length === 0) {
      throw new ValidationError(
        "domain_id does not exist or does not belong to this tenant",
        { details: { code: "CROSS_TENANT_FK_REJECTED", param: "domain_id" } },
      );
    }
    const { slug: domainSlug, name: domainName } = guardResult.rows[0]!;

    // ── 2. Reserved slug: dom-<domainSlug> ────────────────────────────────
    const autoSlug = `dom-${domainSlug}`;

    // ── 3. Find existing auto-pack (or insert if absent) ──────────────────
    let packId: string;
    const findResult = await client.query<{ id: string }>(
      `SELECT id FROM question_packs WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
      [tenantId, autoSlug],
    );

    if (findResult.rows.length > 0) {
      packId = findResult.rows[0]!.id;
    } else {
      // Insert the auto-managed pack. Catch 23505 (race: another request
      // inserted first) → re-query and continue. tenant_id explicit to satisfy
      // WITH CHECK RLS policy on question_packs.
      const newPackId = uuidv7();
      const descSentinel =
        `Auto-managed by the Generate-Questions wizard for domain: ${domainName}. Do not rename its slug.`;
      try {
        const insertResult = await client.query<{ id: string }>(
          `INSERT INTO question_packs (id, tenant_id, slug, name, domain, description, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          [newPackId, tenantId, autoSlug, domainName, domainSlug, descSentinel, createdByUserId],
        );
        packId = insertResult.rows[0]!.id;
        log.info({ tenantId, packId, autoSlug }, "findOrCreatePackForDomain: pack inserted");
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          // Race: another concurrent request created the pack. Re-query.
          const retryResult = await client.query<{ id: string }>(
            `SELECT id FROM question_packs WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
            [tenantId, autoSlug],
          );
          if (retryResult.rows.length === 0) {
            throw new Error("findOrCreatePackForDomain: pack missing after 23505 retry — unexpected");
          }
          packId = retryResult.rows[0]!.id;
          log.info({ tenantId, packId, autoSlug }, "findOrCreatePackForDomain: pack found after 23505");
        } else {
          throw err;
        }
      }
    }

    // ── 4. Heal levels: ensure L1, L2, L3 all exist ───────────────────────
    // Query which labels already exist for this pack.
    const existingLevelsResult = await client.query<{ id: string; label: string }>(
      `SELECT id, label FROM levels WHERE pack_id = $1 AND label = ANY($2::text[])`,
      [packId, ["L1", "L2", "L3"]],
    );

    const existingLevelMap = new Map<string, string>();
    for (const row of existingLevelsResult.rows) {
      existingLevelMap.set(row.label, row.id);
    }

    // Level definitions: label → position, duration_minutes, default_question_count, passing_score_pct
    const LEVEL_DEFS = [
      { label: "L1", position: 1, durationMinutes: 60, defaultQuestionCount: 10, passingScorePct: 60 },
      { label: "L2", position: 2, durationMinutes: 60, defaultQuestionCount: 10, passingScorePct: 60 },
      { label: "L3", position: 3, durationMinutes: 60, defaultQuestionCount: 10, passingScorePct: 60 },
    ] as const;

    for (const def of LEVEL_DEFS) {
      if (!existingLevelMap.has(def.label)) {
        // Level is missing — insert it. Levels have no tenant_id column; their
        // RLS derives tenancy via FK chain through question_packs. No tenant_id
        // on INSERT (matches repository.ts comment — do not add one).
        const newLevelId = uuidv7();
        try {
          await client.query(
            `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [newLevelId, packId, def.position, def.label, def.durationMinutes, def.defaultQuestionCount, def.passingScorePct],
          );
          existingLevelMap.set(def.label, newLevelId);
          log.info({ tenantId, packId, label: def.label, levelId: newLevelId }, "findOrCreatePackForDomain: level healed");
        } catch (err: unknown) {
          if (isUniqueViolation(err)) {
            // Race on level insert — re-query this specific label.
            const retryLevelResult = await client.query<{ id: string }>(
              `SELECT id FROM levels WHERE pack_id = $1 AND label = $2 LIMIT 1`,
              [packId, def.label],
            );
            if (retryLevelResult.rows.length === 0) {
              throw new Error(`findOrCreatePackForDomain: level ${def.label} missing after 23505 retry`);
            }
            existingLevelMap.set(def.label, retryLevelResult.rows[0]!.id);
          } else {
            throw err;
          }
        }
      }
    }

    // ── 5. Verify heal completeness — must never return <3 levels ─────────
    const L1 = existingLevelMap.get("L1");
    const L2 = existingLevelMap.get("L2");
    const L3 = existingLevelMap.get("L3");
    if (!L1 || !L2 || !L3) {
      throw new Error(
        `findOrCreatePackForDomain: heal incomplete — missing levels after insert: ` +
        `L1=${L1 ?? "MISSING"}, L2=${L2 ?? "MISSING"}, L3=${L3 ?? "MISSING"}`,
      );
    }

    return { packId, levelIds: { L1, L2, L3 } };
  });
}

// ===========================================================================
// AI QUESTION GENERATION
// ===========================================================================

/**
 * Generate SOC-grounded ai_draft questions for a pack/level.
 *
 * This function:
 *   1. Loads the SOC knowledge base and selects sources matching the level
 *      (inferred from level label) and optional topic_focus filter.
 *   2. Loads existing topics for the pack/level to prevent duplicates.
 *   3. Delegates to handleAdminGenerate (ai-grading handler), which
 *      calls the claude-code-vps runtime → generate-questions SKILL.md →
 *      submit_questions MCP tool → inserts ai_draft rows in DB.
 *
 * D2 compliance note:
 *   This function imports from '@assessiq/ai-grading' (the barrel).
 *   The ai-grading lint's RE_GRADING_RUNTIME_IMPORT pattern matches
 *   `generateQuestions` as a symbol name, and this file is not in a
 *   banned path (not worker / candidate / webhook / cron) — lint passes.
 */
export async function generateQuestions(
  tenantId: string,
  userId: string,
  packId: string,
  levelId: string,
  count: number,
  topicFocus?: string,
  typeCounts?: Partial<Record<string, number>>,
  domainId?: string,
  categoryId?: string,
  batchId?: string,
): Promise<{ questionIds: string[]; generated: number; skillSha: string }> {
  // Dynamic import to break the load-time cycle: at module load time
  // neither package has finished resolving. Dynamic import defers until
  // the first call, at which point both packages are fully resolved.
  const { handleAdminGenerate } = await import("@assessiq/ai-grading");
  const {
    SOC_KB_BY_LEVEL,
    SOC_KB_FUNCTIONS,
  } = await import("../knowledge-base/index.js");
  // difficulty-spec.ts (this module) — single source of truth for per-(type,level)
  // intrinsic-difficulty targets (Phase A3). Intra-module import; no boundary cross.
  const { DIFFICULTY_SPEC, validateStructuralDifficulty, functionToNice } =
    await import("../difficulty-spec.js");

  // Resolve level label to SOC level
  const level = await withTenant(tenantId, async (client) => {
    const result = await client.query<{ label: string }>(
      `SELECT label FROM levels WHERE id = $1 LIMIT 1`,
      [levelId],
    );
    return result.rows[0]?.label ?? null;
  });

  const socLevel = ((): "L1" | "L2" | "L3" => {
    if (level === null) return "L1";
    const upper = level.toUpperCase();
    if (upper.includes("L3") || upper.includes("LEVEL 3") || upper.includes("SENIOR") || upper.includes("THREAT HUNT")) return "L3";
    if (upper.includes("L2") || upper.includes("LEVEL 2") || upper.includes("INTERMEDIATE") || upper.includes("ANALYST")) return "L2";
    return "L1";
  })();

  // ── Difficulty injection (Phase A3) ───────────────────────────────────────
  // Resolve this level's per-type intrinsic-difficulty targets and pass them —
  // plus a level-bound structural validator and the KbSource.function→NICE
  // mapper — into handleAdminGenerate as in-process data + closures. This keeps
  // the ai-grading→question-bank no-import boundary intact (04 depends on 07,
  // never the reverse): 07 receives targets + closures, never imports difficulty-spec.
  const difficultyByType: Record<string, unknown> = {};
  for (const t of ["mcq", "subjective", "kql", "scenario", "log_analysis"] as const) {
    difficultyByType[t] = DIFFICULTY_SPEC[t][socLevel];
  }
  const difficulty = {
    byType: difficultyByType,
    validate: (
      type: Parameters<typeof validateStructuralDifficulty>[0],
      content: unknown,
      rubric: unknown,
    ) => validateStructuralDifficulty(type, socLevel, content, rubric),
    niceForFunction: functionToNice,
  };

  // Select sources from KB filtered by level (and optionally topic_focus)
  let sources = SOC_KB_BY_LEVEL[socLevel];
  if (topicFocus && (SOC_KB_FUNCTIONS as readonly string[]).includes(topicFocus)) {
    const focused = sources.filter((s) => s.function === topicFocus);
    // Only narrow to topic_focus if it has enough entries; otherwise use full level
    sources = focused.length >= 3 ? focused : sources;
  }

  // Load existing topics for duplicate avoidance
  const existingTopics = await withTenant(tenantId, async (client) => {
    const result = await client.query<{ topic: string }>(
      `SELECT topic FROM questions WHERE pack_id = $1 AND level_id = $2`,
      [packId, levelId],
    );
    return result.rows.map((r) => r.topic);
  });

  // ── Cross-tenant FK guard (load-bearing — do NOT remove or short-circuit) ──
  // Postgres FK validation runs as the table owner and bypasses RLS. A question
  // in tenant A could reference a domain/category in tenant B without this check.
  // This explicit query is the primary security control for that boundary.
  // The guard runs BEFORE generation to fail fast without wasting AI budget.
  //
  // SECURITY (Opus, 2026-05-16): domain_id and category_id are an
  // all-or-nothing pair. If exactly ONE is supplied, the composite tenant
  // check below is skipped (its `&&` condition is false) while the lone
  // unvalidated FK still flows to insertDrafts — and Postgres FK validation
  // bypasses RLS, so a tenant-A question would persist a tenant-B domain_id.
  // Enforce both-or-neither BEFORE the existence check; partial tagging is
  // never legitimate (the wizard always sends the pair).
  if ((domainId !== undefined) !== (categoryId !== undefined)) {
    throw new ValidationError(
      "domain_id and category_id must be provided together or both omitted",
      { details: { code: "CROSS_TENANT_FK_REJECTED", param: "domain_id,category_id" } },
    );
  }
  if (domainId !== undefined && categoryId !== undefined) {
    const guardResult = await withTenant(tenantId, async (client) => {
      return client.query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM categories
           WHERE id = $1
             AND domain_id = $2
             AND tenant_id = $3
         ) AS exists`,
        [categoryId, domainId, tenantId],
      );
    });
    if (!guardResult.rows[0]?.exists) {
      throw new ValidationError(
        "domain_id/category_id combination does not exist or does not belong to this tenant",
        { details: { code: "CROSS_TENANT_FK_REJECTED", param: "domain_id,category_id" } },
      );
    }
  }

  return handleAdminGenerate({
    tenantId,
    userId,
    packId,
    levelId,
    count,
    socLevel,
    sources,
    existingTopics,
    difficulty,
    ...(typeCounts !== undefined ? { typeCounts } : {}),
    ...(domainId !== undefined ? { domainId } : {}),
    ...(categoryId !== undefined ? { categoryId } : {}),
    ...(batchId !== undefined ? { batchId } : {}),
    ...(topicFocus !== undefined ? { topicFocus } : {}),
  });
}

// ===========================================================================
// RUBRIC GENERATOR — proposal + save + bulk-fill
// ===========================================================================

/**
 * Derive the questionText to pass to generateRubricDraft().
 *
 * For log_analysis: the full JSON-serialized content object is passed so the
 * skill can read question + log_format + log_excerpt + expected_findings +
 * sample_solution + hint and produce one anchor per expected_finding.
 *
 * For all other types: the `question` string field is used if present (subjective
 * and kql both have a plain-text question field); falls back to full JSON for
 * types that don't have a top-level question field (e.g. scenario).
 *
 * Extracted as a helper to avoid duplication between generateRubricForQuestion
 * and bulkGenerateMissingRubrics.
 */
function deriveQuestionTextForRubric(
  question: { type: string; content: unknown },
): string {
  if (question.type === "log_analysis") {
    return JSON.stringify(question.content);
  }
  const content = question.content as Record<string, unknown>;
  return typeof content?.question === "string"
    ? (content.question as string)
    : JSON.stringify(question.content);
}

/**
 * Generate a rubric proposal for a subjective, scenario, or log_analysis question.
 * Returns a proposal WITHOUT persisting — admin must POST to save-rubric.
 *
 * D2 compliance: uses dynamic import to call generateRubricDraft from
 * @assessiq/ai-grading. This service file is not in a banned path.
 * The D2 lint enforces the call-site restriction at the runtime level,
 * not at the service layer.
 */
export async function generateRubricForQuestion(
  tenantId: string,
  questionId: string,
): Promise<{
  proposal: unknown;
  skillSha: string;
  promptSha: string;
  levelDefaultsHash: string;
  model: string;
}> {
  return withTenant(tenantId, async (client) => {
    const question = await repo.findQuestionById(client, questionId);
    if (!question) {
      throw new NotFoundError("question not found", {
        details: { code: QB_ERROR_CODES.QUESTION_NOT_FOUND, questionId },
      });
    }

    if (
      question.type !== "subjective" &&
      question.type !== "scenario" &&
      question.type !== "log_analysis"
    ) {
      throw new ValidationError(
        `rubric generation not supported for question type '${question.type}': ` +
          "mcq and kql use deterministic grading and have no rubric semantics",
        { details: { code: QB_ERROR_CODES.UNSUPPORTED_TYPE_FOR_RUBRIC, type: question.type } },
      );
    }

    const level = await repo.findLevelById(client, question.level_id);
    if (!level) {
      throw new NotFoundError("level not found", {
        details: { code: QB_ERROR_CODES.LEVEL_NOT_FOUND, levelId: question.level_id },
      });
    }

    // For log_analysis, validate expected_findings exists before calling the
    // skill (the skill requires ≥1 finding to produce ≥2 anchors; without
    // this guard the skill fails with an opaque schema violation).
    if (question.type === "log_analysis") {
      const content = question.content as Record<string, unknown>;
      const findings = content?.expected_findings;
      if (!Array.isArray(findings) || findings.length === 0) {
        throw new ValidationError(
          "log_analysis rubric generation requires at least one expected_finding in question content",
          { details: { code: QB_ERROR_CODES.INVALID_CONTENT } },
        );
      }
    }

    const { generateRubricDraft } = await import("@assessiq/ai-grading");

    const output = await generateRubricDraft({
      questionText: deriveQuestionTextForRubric(question),
      questionType: question.type as "subjective" | "scenario" | "log_analysis",
      levelOrdinal: level.position,
      levelDefaults: level.rubric_defaults ?? null,
      existingRubric: question.rubric ?? undefined,
      questionId,
    });

    return {
      proposal: output.rubric,
      skillSha: output.skillSha,
      promptSha: output.promptSha,
      levelDefaultsHash: output.levelDefaultsHash,
      model: output.model,
    };
  });
}

/**
 * Generate a candidate-facing answer-format hint proposal for a question
 * (feature #4 Phase B). Supports ALL question types. Returns a proposal
 * WITHOUT persisting — the admin reviews it and POSTs the existing
 * answer_guidance PATCH to save (admin-in-the-loop review gate).
 *
 * D2 compliance: uses dynamic import to call generateAnswerGuidanceDraft from
 * @assessiq/ai-grading; this service file is not in a banned path. The
 * generator receives only an answer-key-free stem (deriveQuestionTextForGuidance).
 */
export async function generateAnswerGuidanceForQuestion(
  tenantId: string,
  questionId: string,
): Promise<{ proposal: string; skillSha: string; promptSha: string; model: string }> {
  return withTenant(tenantId, async (client) => {
    const question = await repo.findQuestionById(client, questionId);
    if (!question) {
      throw new NotFoundError("question not found", {
        details: { code: QB_ERROR_CODES.QUESTION_NOT_FOUND, questionId },
      });
    }

    const { generateAnswerGuidanceDraft } = await import("@assessiq/ai-grading");

    const output = await generateAnswerGuidanceDraft({
      questionText: deriveQuestionTextForGuidance(question),
      questionType: question.type as "mcq" | "subjective" | "kql" | "scenario" | "log_analysis",
      topic: question.topic,
      questionId,
    });

    return {
      proposal: output.answerGuidance,
      skillSha: output.skillSha,
      promptSha: output.promptSha,
      model: output.model,
    };
  });
}

/**
 * Validate and persist a rubric to a question.
 * Server-side weight=100 invariant validation runs BEFORE any DB write.
 * Creates a new version snapshot (via updateQuestion) before persisting.
 */
export async function saveRubric(
  tenantId: string,
  questionId: string,
  rubric: unknown,
  userId: string,
): Promise<{ id: string }> {
  const { parseRubric } = await import("@assessiq/rubric-engine");

  const validated = parseRubric(rubric);
  if (!validated.ok) {
    throw new ValidationError(
      "rubric failed schema validation: " +
        validated.errors.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      { details: { code: QB_ERROR_CODES.INVALID_RUBRIC, issues: validated.errors } },
    );
  }

  return withTenant(tenantId, async (client) => {
    const question = await repo.findQuestionById(client, questionId);
    if (!question) {
      throw new NotFoundError("question not found", {
        details: { code: QB_ERROR_CODES.QUESTION_NOT_FOUND, questionId },
      });
    }

    // Snapshot current state before overwriting rubric
    await repo.insertQuestionVersion(client, {
      id: uuidv7(),
      questionId: question.id,
      version: question.version,
      content: question.content,
      rubric: question.rubric,
      savedBy: userId,
    });

    const updated = await repo.updateQuestionRow(client, questionId, {
      rubric: validated.data,
      version: question.version + 1,
    });

    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: userId,
      action: "question.updated",
      entityType: "question",
      entityId: questionId,
      before: { version: question.version },
      after: {
        kind: "save_rubric",
        version: updated.version,
      },
    });

    return { id: questionId };
  });
}

export interface BulkGenerateMissingRubricsResult {
  proposal: unknown;
  skillSha: string;
  promptSha: string;
  levelDefaultsHash: string;
  model: string;
  currentQuestionId: string;
  remainingCount: number;
  nextQuestionId: string | null;
}

/**
 * Find the first question in a pack with rubric IS NULL and type in
 * (subjective, scenario). Return a proposal + cursor.
 * Does NOT auto-save — admin reviews each proposal and POSTs to save-rubric.
 */
export async function bulkGenerateMissingRubrics(
  tenantId: string,
  packId: string,
): Promise<BulkGenerateMissingRubricsResult> {
  return withTenant(tenantId, async (client) => {
    const nullRubricRes = await client.query<{ id: string; count: string }>(
      `SELECT q.id, COUNT(*) OVER() AS count
       FROM questions q
       WHERE q.pack_id = $1
         AND q.rubric IS NULL
         AND q.type IN ('subjective', 'scenario', 'log_analysis')
       ORDER BY q.created_at ASC`,
      [packId],
    );

    if (nullRubricRes.rows.length === 0) {
      throw new NotFoundError(
        "no questions with missing rubrics found in this pack",
        { details: { code: "NO_MISSING_RUBRICS", packId } },
      );
    }

    const firstRow = nullRubricRes.rows[0]!;
    const currentQuestionId = firstRow.id;
    const totalCount = parseInt(firstRow.count, 10);
    const nextQuestionId = nullRubricRes.rows[1]?.id ?? null;
    const remainingCount = totalCount - 1;

    const question = await repo.findQuestionById(client, currentQuestionId);
    if (!question) {
      throw new NotFoundError("question not found", {
        details: { code: QB_ERROR_CODES.QUESTION_NOT_FOUND, questionId: currentQuestionId },
      });
    }
    const level = await repo.findLevelById(client, question.level_id);
    if (!level) {
      throw new NotFoundError("level not found", {
        details: { code: QB_ERROR_CODES.LEVEL_NOT_FOUND, levelId: question.level_id },
      });
    }

    // Validate expected_findings before calling the skill (same guard as
    // generateRubricForQuestion — avoids opaque schema-violation errors).
    if (question.type === "log_analysis") {
      const content = question.content as Record<string, unknown>;
      const findings = content?.expected_findings;
      if (!Array.isArray(findings) || findings.length === 0) {
        throw new ValidationError(
          "log_analysis rubric generation requires at least one expected_finding in question content",
          { details: { code: QB_ERROR_CODES.INVALID_CONTENT } },
        );
      }
    }

    const { generateRubricDraft } = await import("@assessiq/ai-grading");

    const output = await generateRubricDraft({
      questionText: deriveQuestionTextForRubric(question),
      questionType: question.type as "subjective" | "scenario" | "log_analysis",
      levelOrdinal: level.position,
      levelDefaults: level.rubric_defaults ?? null,
      questionId: currentQuestionId,
    });

    return {
      proposal: output.rubric,
      skillSha: output.skillSha,
      promptSha: output.promptSha,
      levelDefaultsHash: output.levelDefaultsHash,
      model: output.model,
      currentQuestionId,
      remainingCount,
      nextQuestionId,
    };
  });
}
