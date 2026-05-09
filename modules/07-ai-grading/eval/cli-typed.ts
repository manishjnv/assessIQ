// AssessIQ — modules/07-ai-grading/eval/cli-typed.ts
//
// CLI entry for type-sharded generation eval.
// Parallel to eval/cli.ts (grading eval — unchanged).
// Does NOT invoke claude. Operates on static golden JSON files only.
//
// Usage (requires tsx):
//   pnpm tsx modules/07-ai-grading/eval/cli-typed.ts score-goldens [--level L2] [--type mcq]
//   pnpm tsx modules/07-ai-grading/eval/cli-typed.ts write-baseline [--out eval/baseline.json]
//   pnpm tsx modules/07-ai-grading/eval/cli-typed.ts diff-against-baseline
//   pnpm tsx modules/07-ai-grading/eval/cli-typed.ts score-candidate --attempt-id <uuid>
/* eslint-disable no-console */

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  runEvalCase,
  loadBaseline,
  compareToBaseline,
  writeBaseline,
  loadFixture,
  scoreQuestion,
} from "./runner.js";
import type { EvalResult, EvalType, GoldenQuestion, KbSourceRef } from "./runner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LEVELS = ["L1", "L2", "L3"] as const;
const TYPES: EvalType[] = ["mcq", "log_analysis", "scenario", "kql"];

type Level = "L1" | "L2" | "L3";

// ---------------------------------------------------------------------------
// score-goldens
// ---------------------------------------------------------------------------

async function cmdScoreGoldens(level?: Level, type?: EvalType): Promise<boolean> {
  const levels: readonly string[] = level ? [level] : LEVELS;
  const types: EvalType[] = type ? [type] : TYPES;

  const results: EvalResult[] = [];
  for (const l of levels) {
    for (const t of types) {
      try {
        const r = await runEvalCase(l as Level, t);
        results.push(r);
      } catch (err) {
        // Missing golden files for L1/L3 are expected in this PR — skip silently
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("missing")) {
          // intentional no-op: golden not yet authored for this level/type
        } else {
          console.error(`  ERROR ${l}/${t}: ${msg}`);
        }
      }
    }
  }

  if (results.length === 0) {
    console.log("No golden files found for the requested level/type combination.");
    return true;
  }

  console.log("\nlevel | type          | passed | failed | reasons");
  console.log("------+---------------+--------+--------+---------------------------------");

  let anyFail = false;
  for (const r of results) {
    const failReasons = r.scores
      .filter((s) => s.failures.length > 0)
      .flatMap((s) => s.failures)
      .slice(0, 3)
      .join("; ");
    const reasons = failReasons.length > 0 ? failReasons.slice(0, 65) : "-";
    console.log(
      `${r.level.padEnd(5)} | ${r.type.padEnd(13)} | ${String(r.passed).padEnd(6)} | ${String(r.failed).padEnd(6)} | ${reasons}`,
    );
    if (r.failed > 0) anyFail = true;
  }

  const totalPassed = results.reduce((s, r) => s + r.passed, 0);
  const totalTotal = results.reduce((s, r) => s + r.total, 0);
  console.log(`\nTotal: ${totalPassed}/${totalTotal} passed`);

  return !anyFail;
}

// ---------------------------------------------------------------------------
// write-baseline
// ---------------------------------------------------------------------------

async function cmdWriteBaseline(outPath: string): Promise<void> {
  const results: Record<string, EvalResult> = {};
  let anyFail = false;

  for (const l of LEVELS) {
    for (const t of TYPES) {
      try {
        const r = await runEvalCase(l, t);
        results[`${l}-${t}`] = r;
        if (r.failed > 0) anyFail = true;
      } catch {
        // golden not authored yet — skip
      }
    }
  }

  if (anyFail) {
    console.error(
      "write-baseline refused: one or more golden questions have failures.\n" +
        "Fix all failures (run score-goldens) before writing a baseline.",
    );
    process.exit(1);
  }

  if (Object.keys(results).length === 0) {
    console.error("write-baseline refused: no golden files found.");
    process.exit(1);
  }

  await writeBaseline(results, outPath);
  console.log(`Baseline written → ${outPath} (${Object.keys(results).length} entries)`);
}

// ---------------------------------------------------------------------------
// diff-against-baseline
// ---------------------------------------------------------------------------

async function cmdDiffAgainstBaseline(): Promise<void> {
  const baseline = await loadBaseline();

  if (Object.keys(baseline).length === 0) {
    console.log(
      "No baseline yet — run write-baseline after confirming all goldens pass score-goldens.",
    );
    process.exit(0);
  }

  const current: Record<string, EvalResult> = {};
  for (const l of LEVELS) {
    for (const t of TYPES) {
      try {
        const r = await runEvalCase(l, t);
        current[`${l}-${t}`] = r;
      } catch {
        // golden not authored yet — skip
      }
    }
  }

  const { regressions, improvements, equal } = compareToBaseline(current, baseline);

  if (equal) {
    console.log("All scores match baseline — no regressions detected.");
  }
  for (const r of regressions) {
    console.log(`REGRESSION  ${r}`);
  }
  for (const i of improvements) {
    console.log(`IMPROVEMENT ${i}`);
  }

  if (regressions.length > 0) process.exit(1);
}

// ---------------------------------------------------------------------------
// score-candidate
// ---------------------------------------------------------------------------

/**
 * Score real ai_draft questions from a generation_attempts row against the
 * structural comparator. Requires DATABASE_URL in env (run from inside the
 * api container or with DATABASE_URL pointing at VPS postgres).
 *
 * Exit codes:
 *   0 — all (level, type) passed-rates meet or exceed baseline
 *   1 — at least one (level, type) passed-rate is below baseline (regression)
 *   2 — usage error or DB connect / attempt-not-found failure
 */
async function cmdScoreCandidate(attemptId: string): Promise<void> {
  // Guard: @assessiq/tenancy transitively imports @assessiq/core which
  // validates ALL env vars at module load time. If DATABASE_URL is missing
  // the import itself throws — check before importing.
  if (!process.env["DATABASE_URL"]) {
    console.error(
      "DATABASE_URL not set — run from inside the api container or " +
        "set DATABASE_URL to point at the VPS postgres",
    );
    process.exit(2);
  }

  // Dynamic import: deferred past the DATABASE_URL guard so the other
  // subcommands still work on a dev machine without a full env.
  const { getPool, withTenant } = await import("@assessiq/tenancy");

  // ── Step 1: Resolve attempt row ──────────────────────────────────────────
  // Use assessiq_system (BYPASSRLS) so the CLI can read generation_attempts
  // without already knowing the tenant_id — same pattern as getTenantBySlug.
  interface AttemptRow {
    id: string;
    tenant_id: string;
    pack_id: string;
    level_id: string;
    count_inserted: number;
    status: string;
    model: string | null;
    skill_sha: string | null;
    duration_ms: number | null;
    chunks_planned: number | null;
    chunks_failed: number | null;
    dedupe_dropped: number | null;
    started_at: Date;
  }

  const pool = getPool();
  const rawClient = await pool.connect();
  let attempt: AttemptRow;
  try {
    await rawClient.query("BEGIN");
    await rawClient.query("SET LOCAL ROLE assessiq_system");
    const res = await rawClient.query<AttemptRow>(
      `SELECT id, tenant_id, pack_id, level_id, count_inserted, status, model,
              skill_sha, duration_ms, chunks_planned, chunks_failed, dedupe_dropped,
              started_at
         FROM generation_attempts
        WHERE id = $1`,
      [attemptId],
    );
    await rawClient.query("COMMIT");
    const row = res.rows[0];
    if (!row) {
      console.error(`attempt ${attemptId} not found`);
      process.exit(2);
    }
    attempt = row;
  } catch (err) {
    await rawClient.query("ROLLBACK").catch(() => {
      // Secondary rollback failure — connection is likely dead; swallow.
    });
    throw err;
  } finally {
    rawClient.release();
  }

  // ── Step 2: Resolve level label → L1/L2/L3 ──────────────────────────────
  const levelLabel = await withTenant(attempt.tenant_id, async (c) => {
    const res = await c.query<{ label: string }>(
      `SELECT label FROM levels WHERE id = $1`,
      [attempt.level_id],
    );
    return res.rows[0]?.label ?? "";
  });

  const SOC_LEVELS = ["L1", "L2", "L3"] as const;
  const socLevel: "L1" | "L2" | "L3" =
    SOC_LEVELS.find((l) => levelLabel.includes(l)) ?? "L2";

  // ── Step 3: Load fixture (graceful degradation for missing levels) ───────
  const fixturePath = join(__dirname, "fixtures", `${socLevel}-sources.json`);
  let fixture: KbSourceRef[];
  let fixtureSkipped = false;

  if (existsSync(fixturePath)) {
    fixture = await loadFixture(socLevel);
  } else {
    fixtureSkipped = true;
    fixture = []; // will be replaced with synthetic fixture after candidates load
  }

  // ── Step 4: Load candidate questions (tenant-scoped via RLS) ────────────
  interface QuestionRow {
    id: string;
    type: string;
    topic: string;
    points: number;
    content: unknown;
    knowledge_base_sources: Array<{ id: string }>;
  }

  const questionRows = await withTenant(attempt.tenant_id, async (c) => {
    const res = await c.query<QuestionRow>(
      `SELECT id, type, topic, points, content, knowledge_base_sources
         FROM questions
        WHERE pack_id = $1 AND level_id = $2
          AND created_at >= $3
          AND status IN ('ai_draft', 'active')
        ORDER BY created_at ASC`,
      [attempt.pack_id, attempt.level_id, attempt.started_at],
    );
    return res.rows;
  });

  if (questionRows.length === 0) {
    console.log(
      `No candidate questions found for attempt ${attemptId.slice(0, 8)} — nothing to score.`,
    );
    process.exit(0);
  }

  // Map question rows to GoldenQuestion shape
  const candidates: GoldenQuestion[] = questionRows.map((row) => ({
    type: row.type as EvalType,
    topic: row.topic,
    points: row.points,
    content: row.content,
    knowledge_base_source_ids: row.knowledge_base_sources.map((s) => s.id),
  }));

  // Build synthetic fixture for levels with no fixture file so that
  // citationsResolve is effectively n/a (true) for all candidates.
  if (fixtureSkipped) {
    console.log(`no fixture for level ${socLevel} — skipping citation check`);
    const allSourceIds = new Set(
      candidates.flatMap((q) => q.knowledge_base_source_ids),
    );
    fixture = Array.from(allSourceIds).map((id) => ({
      id,
      name: id,
      citation: id,
      url: "n/a",
      level_fit: socLevel,
      function: "n/a",
      description: "n/a",
      tags: [],
      kb_version: "n/a",
    }));
  }

  // ── Step 5: Score per candidate, aggregate by type ───────────────────────
  interface TypeStats {
    total: number;
    passed: number;
    failed: number;
    reasons: string[];
  }
  const byType = new Map<string, TypeStats>();

  for (const [i, candidate] of candidates.entries()) {
    const score = scoreQuestion(candidate, fixture, i);
    const isPass =
      score.schemaValid &&
      score.citationsResolve &&
      score.structuralCompleteness &&
      score.topicNonEmpty;

    const entry: TypeStats = byType.get(candidate.type) ?? {
      total: 0,
      passed: 0,
      failed: 0,
      reasons: [],
    };
    entry.total++;
    if (isPass) {
      entry.passed++;
    } else {
      entry.failed++;
      entry.reasons.push(...score.failures.slice(0, 2));
    }
    byType.set(candidate.type, entry);
  }

  // ── Step 6: Print per-type table ─────────────────────────────────────────
  const shortId = attemptId.slice(0, 8);
  console.log(`\nCandidate scores for attempt ${shortId}:`);
  console.log("type          | total | passed | failed | reasons");
  console.log(
    "--------------+-------+--------+--------+-----------------------------------",
  );
  for (const [type, stats] of byType.entries()) {
    const reasons =
      stats.reasons.length > 0
        ? stats.reasons.slice(0, 3).join("; ").slice(0, 65)
        : "-";
    console.log(
      `${type.padEnd(13)} | ${String(stats.total).padEnd(5)} | ` +
        `${String(stats.passed).padEnd(6)} | ${String(stats.failed).padEnd(6)} | ${reasons}`,
    );
  }
  const totalPassed = [...byType.values()].reduce((s, v) => s + v.passed, 0);
  const totalTotal = [...byType.values()].reduce((s, v) => s + v.total, 0);
  console.log(`\nAttempt total: ${totalPassed}/${totalTotal} passed.`);

  // ── Step 7: Runtime metrics ───────────────────────────────────────────────
  console.log("\nRuntime metrics:");
  console.log(`  duration_ms    : ${attempt.duration_ms ?? "n/a"}`);
  console.log(`  chunks_planned : ${attempt.chunks_planned ?? "n/a"}`);
  console.log(`  chunks_failed  : ${attempt.chunks_failed ?? "n/a"}`);
  console.log(`  dedupe_dropped : ${attempt.dedupe_dropped ?? "n/a"}`);
  console.log(`  skill_sha      : ${attempt.skill_sha ?? "n/a"}`);
  console.log(`  model          : ${attempt.model ?? "n/a"}`);
  console.log(`  status         : ${attempt.status}`);

  // ── Step 8: Regression check against baseline ────────────────────────────
  const baseline = await loadBaseline();
  const regressions: string[] = [];

  if (Object.keys(baseline).length === 0) {
    console.log(
      "\n[baseline] No baseline.json found — skipping regression check. " +
        "Run write-baseline after goldens pass.",
    );
  } else {
    for (const [type, stats] of byType.entries()) {
      const key = `${socLevel}-${type}`;
      const base = baseline[key];
      if (base === undefined) continue;
      // Compare passed-rates rather than raw counts (candidate count ≠ golden count).
      const candidateRate = stats.total > 0 ? stats.passed / stats.total : 0;
      const baseRate = base.total > 0 ? base.passed / base.total : 0;
      if (candidateRate < baseRate) {
        regressions.push(
          `REGRESSION: ${key} dropped from ${base.passed}/${base.total} to ${stats.passed}/${stats.total}`,
        );
      }
    }
  }

  for (const r of regressions) {
    console.error(r);
  }

  process.exit(regressions.length > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    level: { type: "string" },
    type: { type: "string" },
    out: { type: "string" },
    "attempt-id": { type: "string" },
  },
  allowPositionals: true,
});

const subcommand = positionals[0];

if (subcommand === "score-goldens") {
  const level = values["level"] as Level | undefined;
  const type = values["type"] as EvalType | undefined;
  const ok = await cmdScoreGoldens(level, type);
  process.exit(ok ? 0 : 1);
} else if (subcommand === "write-baseline") {
  const outPath =
    (values["out"] as string | undefined) ?? join(__dirname, "baseline.json");
  await cmdWriteBaseline(outPath);
} else if (subcommand === "diff-against-baseline") {
  await cmdDiffAgainstBaseline();
} else if (subcommand === "score-candidate") {
  const attemptId = values["attempt-id"];
  if (!attemptId) {
    console.error("Usage: cli-typed.ts score-candidate --attempt-id <uuid>");
    process.exit(2);
  }
  try {
    await cmdScoreCandidate(attemptId);
  } catch (err) {
    console.error(
      "score-candidate failed:",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(2);
  }
} else {
  console.error(
    `Unknown subcommand: ${subcommand ?? "(none)"}\n` +
      "Usage: cli-typed.ts score-goldens|write-baseline|diff-against-baseline|score-candidate\n" +
      "         [--level L1|L2|L3] [--type mcq|log_analysis|scenario|kql] [--out <path>]\n" +
      "         [--attempt-id <uuid>]  (score-candidate only)",
  );
  process.exit(2);
}
