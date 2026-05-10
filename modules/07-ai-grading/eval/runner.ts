// AssessIQ — modules/07-ai-grading/eval/runner.ts
//
// Stage 1.5 — type-sharded generation eval harness.
// Implements golden-question loading, fixture loading, per-question scoring,
// eval case aggregation, baseline I/O, and regression comparison.
//
// Design reference: docs/design/2026-05-09-type-sharded-generation.md § 6.
//
// HARD CONSTRAINT: this file does NOT spawn claude and does NOT call any
// runtime/* function. It operates on static JSON files only.
// The lint-no-ambient-claude.ts invariant guard does not require update.

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Public type contracts
// ---------------------------------------------------------------------------

export type EvalType = "mcq" | "log_analysis" | "scenario" | "kql" | "subjective";

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

export interface GoldenQuestion {
  type: EvalType;
  topic: string;
  points: number;
  content: unknown;
  knowledge_base_source_ids: string[];
}

/** Per-question check result produced by scoreQuestion(). */
export interface EvalScore {
  /** Synthesised from type + array index. */
  id: string;
  type: EvalType;
  schemaValid: boolean;
  citationsResolve: boolean;
  structuralCompleteness: boolean;
  topicNonEmpty: boolean;
  failures: string[];
}

/** Aggregate result for one (level, type) pair. */
export interface EvalResult {
  level: string;
  type: EvalType;
  total: number;
  /** Questions where all four checks pass. */
  passed: number;
  failed: number;
  scores: EvalScore[];
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const KbSourceRefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  citation: z.string().min(1),
  url: z.string().min(1),
  level_fit: z.enum(["L1", "L2", "L3"]),
  function: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string()),
  kb_version: z.string().min(1),
});

const GoldenBaseSchema = z.object({
  type: z.enum(["mcq", "log_analysis", "scenario", "kql", "subjective"]),
  topic: z.string(),
  points: z.number().int().positive(),
  content: z.unknown(),
  knowledge_base_source_ids: z.array(z.string()).min(1),
});

// Per-type content schemas (mirror the omnibus skill's submit_questions shape)
const McqContentSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).length(4),
  correct: z.number().int().min(0).max(3),
  rationale: z.string().min(1),
});

const LogAnalysisContentSchema = z.object({
  question: z.string().min(1),
  log_format: z.enum(["json", "syslog", "windows_event", "freeform"]),
  log_excerpt: z.string().min(1),
  expected_findings: z.array(z.string()).min(2),
  sample_solution: z.string().min(1),
  hint: z.string().min(1),
});

const ScenarioContentSchema = z.object({
  title: z.string().min(1),
  intro: z.string().min(1),
  step_dependency: z.enum(["linear", "dag"]),
  steps: z
    .array(
      z.object({
        prompt: z.string().min(1),
        expected: z.string().min(1),
      }),
    )
    .min(1),
});

const KqlContentSchema = z.object({
  question: z.string().min(1),
  tables: z.array(z.string()).min(1),
  expected_keywords: z.array(z.string()).min(1),
  sample_solution: z.string().min(1),
});

const SubjectiveContentSchema = z.object({
  question: z.string().min(1),
});

// ---------------------------------------------------------------------------
// loadGolden
// ---------------------------------------------------------------------------

/**
 * Load and base-validate golden questions for the given level and type.
 * Reads eval/golden-questions/{level}/{type}.json.
 * Throws if the file is missing or any entry fails the base schema.
 */
export async function loadGolden(
  level: "L1" | "L2" | "L3",
  type: EvalType,
): Promise<GoldenQuestion[]> {
  const filePath = join(__dirname, "golden-questions", level, `${type}.json`);
  if (!existsSync(filePath)) {
    throw new Error(`Golden file missing: ${filePath}`);
  }
  const raw = await readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Golden file must be a JSON array: ${filePath}`);
  }
  return parsed.map((item, i) => {
    const result = GoldenBaseSchema.safeParse(item);
    if (!result.success) {
      throw new Error(
        `Golden[${i}] in ${filePath} invalid: ${result.error.issues.map((e) => e.message).join("; ")}`,
      );
    }
    return result.data as GoldenQuestion;
  });
}

// ---------------------------------------------------------------------------
// loadFixture
// ---------------------------------------------------------------------------

/**
 * Load KB source fixture for the given level.
 * Reads eval/fixtures/{level}-sources.json.
 * Throws if the file is missing or any entry fails validation.
 */
export async function loadFixture(level: "L1" | "L2" | "L3"): Promise<KbSourceRef[]> {
  const filePath = join(__dirname, "fixtures", `${level}-sources.json`);
  if (!existsSync(filePath)) {
    throw new Error(`Fixture file missing: ${filePath}`);
  }
  const raw = await readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Fixture file must be a JSON array: ${filePath}`);
  }
  return parsed.map((item, i) => {
    const result = KbSourceRefSchema.safeParse(item);
    if (!result.success) {
      throw new Error(
        `Fixture[${i}] in ${filePath} invalid: ${result.error.issues.map((e) => e.message).join("; ")}`,
      );
    }
    return result.data;
  });
}

// ---------------------------------------------------------------------------
// scoreQuestion
// ---------------------------------------------------------------------------

/**
 * Score a single golden question against a KB source fixture.
 * Runs four deterministic checks — no claude invocation.
 */
export function scoreQuestion(
  q: GoldenQuestion,
  fixture: KbSourceRef[],
  index: number,
): EvalScore {
  const id = `${q.type}-${index}`;
  const failures: string[] = [];
  let schemaValid = false;
  let structuralCompleteness = false;

  // --- schemaValid + structuralCompleteness (type-specific) ---
  switch (q.type) {
    case "mcq": {
      const r = McqContentSchema.safeParse(q.content);
      if (r.success) {
        schemaValid = true;
        structuralCompleteness = r.data.options.length === 4;
        if (!structuralCompleteness) failures.push("mcq: options.length !== 4");
      } else {
        failures.push(`schemaValid: ${r.error.issues.map((e) => e.message).join("; ")}`);
      }
      break;
    }
    case "log_analysis": {
      const r = LogAnalysisContentSchema.safeParse(q.content);
      if (r.success) {
        schemaValid = true;
        structuralCompleteness = r.data.expected_findings.length >= 2;
        if (!structuralCompleteness) failures.push("log_analysis: expected_findings.length < 2");
      } else {
        failures.push(`schemaValid: ${r.error.issues.map((e) => e.message).join("; ")}`);
      }
      break;
    }
    case "scenario": {
      const r = ScenarioContentSchema.safeParse(q.content);
      if (r.success) {
        schemaValid = true;
        structuralCompleteness = r.data.steps.length >= 1;
        if (!structuralCompleteness) failures.push("scenario: steps.length < 1");
      } else {
        failures.push(`schemaValid: ${r.error.issues.map((e) => e.message).join("; ")}`);
      }
      break;
    }
    case "kql": {
      const r = KqlContentSchema.safeParse(q.content);
      if (r.success) {
        schemaValid = true;
        structuralCompleteness = r.data.expected_keywords.length >= 1;
        if (!structuralCompleteness) failures.push("kql: expected_keywords.length < 1");
      } else {
        failures.push(`schemaValid: ${r.error.issues.map((e) => e.message).join("; ")}`);
      }
      break;
    }
    case "subjective": {
      const r = SubjectiveContentSchema.safeParse(q.content);
      if (r.success) {
        schemaValid = true;
        structuralCompleteness = r.data.question.trim().length > 0;
        if (!structuralCompleteness) failures.push("subjective: question is empty");
      } else {
        failures.push(`schemaValid: ${r.error.issues.map((e) => e.message).join("; ")}`);
      }
      break;
    }
  }

  // --- citationsResolve ---
  const sourceIds = new Set(fixture.map((s) => s.id));
  const missing = q.knowledge_base_source_ids.filter((sid) => !sourceIds.has(sid));
  const citationsResolve = missing.length === 0;
  if (!citationsResolve) {
    failures.push(`unknown source ids: ${missing.join(", ")}`);
  }

  // --- topicNonEmpty ---
  const topicNonEmpty = q.topic.trim().length > 0;
  if (!topicNonEmpty) failures.push(`topic is empty (id=${id})`);

  return {
    id,
    type: q.type,
    schemaValid,
    citationsResolve,
    structuralCompleteness,
    topicNonEmpty,
    failures,
  };
}

// ---------------------------------------------------------------------------
// runEvalCase
// ---------------------------------------------------------------------------

/**
 * Load goldens + fixture for (level, type) and score every question.
 * Returns an EvalResult summary with per-question EvalScore breakdown.
 */
export async function runEvalCase(
  level: "L1" | "L2" | "L3",
  type: EvalType,
): Promise<EvalResult> {
  const [goldens, fixture] = await Promise.all([loadGolden(level, type), loadFixture(level)]);
  const scores = goldens.map((q, i) => scoreQuestion(q, fixture, i));
  const passed = scores.filter(
    (s) => s.schemaValid && s.citationsResolve && s.structuralCompleteness && s.topicNonEmpty,
  ).length;
  return { level, type, total: scores.length, passed, failed: scores.length - passed, scores };
}

// ---------------------------------------------------------------------------
// loadBaseline
// ---------------------------------------------------------------------------

/**
 * Read eval/baseline.json.
 * Returns {} if the file is missing, empty, or unparseable —
 * expected state before the first ops-session baseline run.
 */
export async function loadBaseline(): Promise<Record<string, EvalResult>> {
  const baselinePath = join(__dirname, "baseline.json");
  if (!existsSync(baselinePath)) return {};
  try {
    const raw = await readFile(baselinePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, EvalResult>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// compareToBaseline
// ---------------------------------------------------------------------------

/**
 * Compare current EvalResults against a baseline snapshot.
 * Regression: current.passed < baseline.passed for any key present in both.
 * Improvement: current.passed > baseline.passed.
 * Keys in current but absent from baseline are skipped (new golden, no reference).
 */
export function compareToBaseline(
  current: Record<string, EvalResult>,
  baseline: Record<string, EvalResult>,
): { regressions: string[]; improvements: string[]; equal: boolean } {
  const regressions: string[] = [];
  const improvements: string[] = [];
  for (const [key, cur] of Object.entries(current)) {
    const base = baseline[key];
    if (base === undefined) continue;
    if (cur.passed < base.passed) {
      regressions.push(`${key}: passed ${cur.passed} < baseline ${base.passed}`);
    } else if (cur.passed > base.passed) {
      improvements.push(`${key}: passed ${cur.passed} > baseline ${base.passed}`);
    }
  }
  const equal = regressions.length === 0 && improvements.length === 0;
  return { regressions, improvements, equal };
}

// ---------------------------------------------------------------------------
// writeBaseline — used by cli-typed.ts write-baseline subcommand
// ---------------------------------------------------------------------------

export async function writeBaseline(
  data: Record<string, EvalResult>,
  outPath: string,
): Promise<void> {
  await writeFile(outPath, JSON.stringify(data, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// AttemptDiagnostic — used by cli-typed.ts inspect-attempt subcommand
// ---------------------------------------------------------------------------

export interface AttemptDiagnostic {
  id: string;
  packId: string;
  levelId: string;
  status: "success" | "partial" | "failed" | "running";
  countRequested: number;
  countInserted: number;
  chunksPlanned: number | null;
  chunksFailed: number | null;
  dedupeDropped: number | null;
  citationDropped: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  stderrTail: string | null;
  skillSha: string | null;       // comma-joined per-chunk SHAs
  model: string | null;
  durationMs: number | null;
  startedAt: string;
  finishedAt: string | null;
  insertedQuestions: Array<{
    id: string;
    type: string;
    topic: string;
    points: number;
    contentKeys: string[];
    knowledgeBaseSourceIds: string[];
    createdAt: string;
  }>;
}

/**
 * Load a generation_attempts row plus its inserted questions for diagnostics.
 *
 * Uses the assessiq_system (BYPASSRLS) role so the CLI can resolve the attempt
 * without knowing the tenant_id upfront — same pattern as score-candidate.
 * Questions are then fetched tenant-scoped via RLS through withTenant().
 *
 * Throws with an error whose .code === "ATTEMPT_NOT_FOUND" if the attempt row
 * does not exist. The CLI maps that to exit code 2.
 *
 * NOTE: this function requires DATABASE_URL and dynamically imports
 * @assessiq/tenancy. It MUST NOT be called from golden/fixture/scoring paths.
 */
export async function loadAttemptDiagnostic(
  attemptId: string,
): Promise<AttemptDiagnostic> {
  const { getPool, withTenant } = await import("@assessiq/tenancy");

  // ── Step 1: Resolve attempt row (BYPASSRLS) ───────────────────────────────
  interface AttemptRow {
    id: string;
    tenant_id: string;
    pack_id: string;
    level_id: string;
    count_requested: number;
    count_inserted: number;
    status: "success" | "partial" | "failed" | "running";
    error_code: string | null;
    error_message: string | null;
    stderr_tail: string | null;
    skill_sha: string | null;
    model: string | null;
    chunks_planned: number | null;
    chunks_failed: number | null;
    dedupe_dropped: number | null;
    citation_dropped: number | null;
    duration_ms: number | null;
    started_at: Date;
    finished_at: Date | null;
  }

  const pool = getPool();
  const rawClient = await pool.connect();
  let attempt: AttemptRow;
  try {
    await rawClient.query("BEGIN");
    await rawClient.query("SET LOCAL ROLE assessiq_system");
    const res = await rawClient.query<AttemptRow>(
      `SELECT id, tenant_id, pack_id, level_id,
              count_requested, count_inserted, status,
              error_code, error_message, stderr_tail,
              skill_sha, model,
              chunks_planned, chunks_failed, dedupe_dropped, citation_dropped,
              duration_ms, started_at, finished_at
         FROM generation_attempts
        WHERE id = $1`,
      [attemptId],
    );
    await rawClient.query("COMMIT");
    const row = res.rows[0];
    if (!row) {
      const err = new Error(`attempt ${attemptId} not found`);
      (err as NodeJS.ErrnoException).code = "ATTEMPT_NOT_FOUND";
      throw err;
    }
    attempt = row;
  } catch (err) {
    await rawClient.query("ROLLBACK").catch(() => {
      // swallow secondary rollback failure
    });
    throw err;
  } finally {
    rawClient.release();
  }

  // ── Step 2: Fetch inserted questions (tenant-scoped via RLS) ─────────────
  interface QuestionRow {
    id: string;
    type: string;
    topic: string;
    points: number;
    content: Record<string, unknown>;
    knowledge_base_sources: Array<{ id: string }>;
    created_at: Date;
  }

  const questionRows = await withTenant(attempt.tenant_id, async (c) => {
    const params: unknown[] = [attempt.pack_id, attempt.level_id, attempt.started_at];
    const finishedClause =
      attempt.finished_at !== null
        ? `AND created_at <= $4`
        : "";
    if (attempt.finished_at !== null) {
      params.push(attempt.finished_at);
    }
    const res = await c.query<QuestionRow>(
      `SELECT id, type, topic, points, content, knowledge_base_sources, created_at
         FROM questions
        WHERE pack_id = $1 AND level_id = $2
          AND created_at >= $3
          ${finishedClause}
          AND status IN ('ai_draft', 'active')
        ORDER BY created_at ASC`,
      params,
    );
    return res.rows;
  });

  // ── Step 3: Map to AttemptDiagnostic ─────────────────────────────────────
  return {
    id: attempt.id,
    packId: attempt.pack_id,
    levelId: attempt.level_id,
    status: attempt.status,
    countRequested: attempt.count_requested,
    countInserted: attempt.count_inserted,
    chunksPlanned: attempt.chunks_planned,
    chunksFailed: attempt.chunks_failed,
    dedupeDropped: attempt.dedupe_dropped,
    citationDropped: attempt.citation_dropped,
    errorCode: attempt.error_code,
    errorMessage: attempt.error_message,
    stderrTail: attempt.stderr_tail,
    skillSha: attempt.skill_sha,
    model: attempt.model,
    durationMs: attempt.duration_ms,
    startedAt: attempt.started_at.toISOString(),
    finishedAt: attempt.finished_at ? attempt.finished_at.toISOString() : null,
    insertedQuestions: questionRows.map((row) => ({
      id: row.id,
      type: row.type,
      topic: row.topic,
      points: row.points,
      contentKeys: Object.keys(row.content ?? {}),
      knowledgeBaseSourceIds: (row.knowledge_base_sources ?? []).map((s) => s.id),
      createdAt: row.created_at.toISOString(),
    })),
  };
}
