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
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  runEvalCase,
  loadBaseline,
  compareToBaseline,
  writeBaseline,
  loadFixture,
  scoreQuestion,
  loadAttemptDiagnostic,
  loadRuntimeThresholds,
} from "./runner.js";
import type { EvalResult, EvalType, GoldenQuestion, KbSourceRef, AttemptDiagnostic, RuntimeThresholds } from "./runner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LEVELS = ["L1", "L2", "L3"] as const;
const TYPES: EvalType[] = ["mcq", "log_analysis", "scenario", "kql", "subjective"];

type Level = "L1" | "L2" | "L3";

// ---------------------------------------------------------------------------
// score-goldens
// ---------------------------------------------------------------------------

export async function cmdScoreGoldens(level?: Level, type?: EvalType, _strict?: boolean): Promise<boolean> {
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

  const exitCode = anyFail ? 1 : 0;
  console.log(`EVAL GATE: ${totalPassed}/${totalTotal} goldens passed (exit ${exitCode})`);

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
// score-candidate — fixture freshness helper (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Compute the symmetric difference between a fixture's ID set and the
 * authoritative KB's ID set for a given SOC level.
 *
 * Pure function — no I/O, no process.exit. Exported for unit testing.
 *
 * @param _socLevel - Unused in the computation; present so callers can pass
 *   the level for clarity and so future per-level logic has a hook point.
 * @param fixtureIds - IDs from the loaded eval fixture file.
 * @param kbIds     - IDs from the corresponding soc-l*.json sources array.
 */
export function checkFixtureFreshness(
  _socLevel: "L1" | "L2" | "L3",
  fixtureIds: string[],
  kbIds: string[],
): { stale: boolean; inKbNotFix: string[]; inFixNotKb: string[] } {
  const kbSet = new Set(kbIds);
  const fixSet = new Set(fixtureIds);
  const inKbNotFix = [...kbSet].filter((id) => !fixSet.has(id));
  const inFixNotKb = [...fixSet].filter((id) => !kbSet.has(id));
  const stale = inKbNotFix.length > 0 || inFixNotKb.length > 0;
  return { stale, inKbNotFix, inFixNotKb };
}

// ---------------------------------------------------------------------------
// score-candidate — runtime metrics helpers (exported for testing)
// ---------------------------------------------------------------------------

export interface RuntimeMetricRow {
  metric: string;
  /** Computed value formatted as string, or "n/a" when not derivable. */
  value: string;
  /** Threshold expression, e.g. "≥0.60" or "≤1000". */
  threshold: string;
  verdict: "pass" | "fail" | "na";
}

export interface RuntimeMetricsResult {
  rows: RuntimeMetricRow[];
  /** True when at least one metric computed and failed its threshold. */
  anyFail: boolean;
  /** False when thresholds is null — caller should print "(no thresholds available)". */
  hasThresholds: boolean;
}

/**
 * Compute runtime metric rows from attempt data and thresholds.
 *
 * Pure function — no I/O, no process.exit. Metrics unavailable from the
 * attempt row (peak_rss, per_type_duration) receive verdict "na" and never
 * contribute to anyFail. Exported for unit testing.
 *
 * chunk_success_rate threshold uses ≥ (not >): 0.6 exactly is a pass.
 */
export function scoreRuntimeMetrics(
  attempt: {
    chunks_planned: number | null;
    chunks_failed: number | null;
    count_inserted: number;
    count_requested: number;
  },
  thresholds: RuntimeThresholds | null,
): RuntimeMetricsResult {
  if (thresholds === null) {
    return { rows: [], anyFail: false, hasThresholds: false };
  }

  const rows: RuntimeMetricRow[] = [];

  // chunk_success_rate = (chunks_planned - chunks_failed) / chunks_planned
  // Only when chunks_planned > 0 to avoid division by zero.
  {
    const planned = attempt.chunks_planned;
    let value = "n/a";
    let verdict: "pass" | "fail" | "na" = "na";
    if (planned !== null && planned > 0) {
      const failed = attempt.chunks_failed ?? 0;
      const rate = (planned - failed) / planned;
      value = rate.toFixed(2);
      verdict = rate >= thresholds.min_chunk_success_rate ? "pass" : "fail";
    }
    rows.push({
      metric: "chunk_success_rate",
      value,
      threshold: `\u2265${thresholds.min_chunk_success_rate.toFixed(2)}`,
      verdict,
    });
  }

  // total_inserted_pct = count_inserted / count_requested
  {
    let value = "n/a";
    let verdict: "pass" | "fail" | "na" = "na";
    if (attempt.count_requested > 0) {
      const pct = attempt.count_inserted / attempt.count_requested;
      value = pct.toFixed(2);
      verdict = pct >= thresholds.min_total_inserted_pct ? "pass" : "fail";
    }
    rows.push({
      metric: "total_inserted_pct",
      value,
      threshold: `\u2265${thresholds.min_total_inserted_pct.toFixed(2)}`,
      verdict,
    });
  }

  // per_type_duration (max) — not stored in the attempt row; measured at smoke
  // time via docker stats. Never fails even with --strict-runtime.
  rows.push({
    metric: "per_type_duration (max)",
    value: "n/a",
    threshold: `\u2264${thresholds.max_per_type_duration_ms_at_count_le_2}`,
    verdict: "na",
  });

  // peak_rss_mib — written into runtime-baseline.json by hand after smoke.
  // Not derivable from a single attempt row.
  rows.push({
    metric: "peak_rss_mib",
    value: "n/a",
    threshold: `\u2264${thresholds.max_peak_rss_mib}`,
    verdict: "na",
  });

  const anyFail = rows.some((r) => r.verdict === "fail");
  return { rows, anyFail, hasThresholds: true };
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
 *       OR at least one runtime metric fails AND --strict-runtime is set
 *   2 — usage error or DB connect / attempt-not-found failure
 *   3 — fixture is stale: eval/fixtures/<L>-sources.json diverges from soc-<L>.json.
 *       Re-run `pnpm exec tsx tools/extract-eval-fixtures.ts --apply` to fix.
 *       Use --skip-fixture-check to bypass this guard.
 */
async function cmdScoreCandidate(
  attemptId: string,
  strictRuntime = false,
  skipFixtureCheck = false,
): Promise<void> {
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
    count_requested: number;
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
      `SELECT id, tenant_id, pack_id, level_id, count_requested, count_inserted,
              status, model, skill_sha, duration_ms, chunks_planned, chunks_failed,
              dedupe_dropped, started_at
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

  // ── Fixture freshness guard ──────────────────────────────────────────────
  // Compares the loaded fixture's ID set against the live KB slice that the
  // runtime handler uses.  If they diverge by even one ID the fixture is stale
  // and score-candidate results are misleading.  Exit immediately so the
  // operator knows to re-run tools/extract-eval-fixtures.ts.
  //
  // Only runs when a fixture file was successfully loaded (fixtureSkipped===false)
  // and --skip-fixture-check has not been passed.
  // When the KB file is absent (unusual dev setup) the guard is skipped
  // silently — a missing KB is a separate problem.
  if (!fixtureSkipped && !skipFixtureCheck) {
    const kbFileName = `soc-l${socLevel.slice(1)}.json`;
    const kbFilePath = join(
      __dirname,
      "..",
      "..",
      "04-question-bank",
      "src",
      "knowledge-base",
      kbFileName,
    );
    if (existsSync(kbFilePath)) {
      const kbRaw = JSON.parse(await readFile(kbFilePath, "utf8")) as {
        sources?: Array<{ id: string }>;
      };
      const { stale, inKbNotFix, inFixNotKb } = checkFixtureFreshness(
        socLevel,
        fixture.map((s) => s.id),
        (kbRaw.sources ?? []).map((s) => s.id),
      );
      if (stale) {
        const totalDiff = inKbNotFix.length + inFixNotKb.length;
        const diffParts: string[] = [];
        if (inKbNotFix.length > 0) {
          const shown = inKbNotFix.slice(0, 5);
          const ellipsis = inKbNotFix.length > 5 ? `, …(${inKbNotFix.length - 5} more)` : "";
          diffParts.push(`+KB[${shown.join(", ")}${ellipsis}]`);
        }
        if (inFixNotKb.length > 0) {
          const shown = inFixNotKb.slice(0, 5);
          const ellipsis = inFixNotKb.length > 5 ? `, …(${inFixNotKb.length - 5} more)` : "";
          diffParts.push(`-fix[${shown.join(", ")}${ellipsis}]`);
        }
        console.error(
          `\nFIXTURE STALE: eval/fixtures/${socLevel}-sources.json diverges from ` +
            `soc-l${socLevel.slice(1)}.json by ${totalDiff} ID${totalDiff === 1 ? "" : "s"}. ` +
            `Re-run \`pnpm exec tsx tools/extract-eval-fixtures.ts --apply\` to regenerate. ` +
            `Diff: ${diffParts.join(" ")}`,
        );
        console.error(
          "  (Use --skip-fixture-check to bypass this guard for archaeology on known-stale fixtures.)",
        );
        process.exit(3);
      }
    }
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

  // ── Step 7b: Runtime threshold comparison ────────────────────────────────
  const runtimeThresholds = await loadRuntimeThresholds();
  const runtimeMetrics = scoreRuntimeMetrics(
    {
      chunks_planned: attempt.chunks_planned,
      chunks_failed: attempt.chunks_failed,
      count_inserted: attempt.count_inserted,
      count_requested: attempt.count_requested,
    },
    runtimeThresholds,
  );

  console.log("\nRuntime threshold comparison:");
  if (!runtimeMetrics.hasThresholds) {
    console.log(
      "  (no thresholds available — see runtime-baseline.json regression_thresholds)",
    );
  } else {
    console.log("metric                       | value   | threshold   | verdict");
    console.log("-----------------------------+---------+-------------+--------");
    for (const row of runtimeMetrics.rows) {
      const verdictStr =
        row.verdict === "pass" ? "\u2713" : row.verdict === "fail" ? "\u2717 FAIL" : "n/a";
      console.log(
        `${row.metric.padEnd(28)} | ${row.value.padEnd(7)} | ${row.threshold.padEnd(11)} | ${verdictStr}`,
      );
    }

    if (runtimeMetrics.anyFail && strictRuntime) {
      for (const row of runtimeMetrics.rows.filter((r) => r.verdict === "fail")) {
        console.error(
          `RUNTIME REGRESSION: ${row.metric} ${row.value} below threshold ${row.threshold}`,
        );
      }
      process.exit(1);
    }
  }

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
// inspect-attempt
// ---------------------------------------------------------------------------

/**
 * Render an AttemptDiagnostic into a human-readable report string.
 * Exported for unit testing — does NOT call process.exit.
 */
export function renderAttemptReport(
  d: AttemptDiagnostic,
  opts: { showStderr: boolean; showQuestions: boolean },
): string {
  const lines: string[] = [];

  // ── Section 1: Attempt header ─────────────────────────────────────────────
  const durationStr = d.durationMs !== null ? fmtDuration(d.durationMs) : "n/a";
  const shortId = d.id.slice(0, 8);

  lines.push(`Attempt ${d.id}`);
  lines.push(`Pack ${d.packId} / Level ${d.levelId}`);
  lines.push(
    `Status: ${d.status.padEnd(10)} Started: ${d.startedAt}`,
  );
  lines.push(
    `Duration: ${durationStr.padEnd(10)} Finished: ${d.finishedAt ?? "(running)"}`,
  );
  lines.push(
    `Counts: requested=${d.countRequested} inserted=${d.countInserted}`,
  );
  lines.push(
    `Chunks: planned=${d.chunksPlanned ?? "n/a"} failed=${d.chunksFailed ?? "n/a"}` +
      `  Dedupe: ${d.dedupeDropped ?? "n/a"}  Citation: ${d.citationDropped ?? "n/a"}`,
  );
  lines.push(`Model: ${d.model ?? "n/a"}`);
  lines.push(`Skill SHAs: ${fmtSkillShas(d.skillSha)}`);
  if (d.errorCode || d.errorMessage) {
    const truncMsg = (d.errorMessage ?? "").slice(0, 200);
    lines.push(`Error: ${d.errorCode ?? "(none)"}: ${truncMsg}`);
  }

  // ── Section 2: Per-type insert summary ────────────────────────────────────
  lines.push("");
  lines.push(`type           total inserted   topics (truncated)`);
  lines.push(`--------------+----------------+-------------------------------`);

  const allTypes: AttemptDiagnostic["insertedQuestions"][0]["type"][] = [
    "mcq",
    "log_analysis",
    "scenario",
    "kql",
    "subjective",
  ];

  // Build per-type map from inserted questions
  const byType = new Map<string, AttemptDiagnostic["insertedQuestions"]>();
  for (const q of d.insertedQuestions) {
    const arr = byType.get(q.type) ?? [];
    arr.push(q);
    byType.set(q.type, arr);
  }

  // Determine which types "failed" vs "not requested"
  // A type is considered "chunk-failed" when chunksPlanned > 0 && chunksFailed > 0
  // and no questions of that type were inserted. We show "— (chunk failed)" for
  // types present in no inserted rows when there were chunk failures overall.
  const hasChunkFailures =
    (d.chunksFailed ?? 0) > 0 && (d.chunksPlanned ?? 0) > 0;

  for (const t of allTypes) {
    const qs = byType.get(t) ?? [];
    const inserted = qs.length;
    if (inserted === 0) {
      const label = hasChunkFailures ? "— (chunk failed)" : "— ";
      lines.push(`${t.padEnd(14)} ${String(0).padEnd(16)} ${label}`);
    } else {
      const topics = qs
        .map((q) => `"${q.topic.slice(0, 32)}"`)
        .join(", ")
        .slice(0, 80);
      lines.push(`${t.padEnd(14)} ${String(inserted).padEnd(16)} ${topics}`);
    }
  }

  // ── Optional: stderr_tail ─────────────────────────────────────────────────
  if (opts.showStderr) {
    lines.push("");
    lines.push("--- stderr_tail ---");
    lines.push(d.stderrTail ?? "(none)");
    lines.push("--- end stderr_tail ---");
  }

  // ── Optional: per-question detail ────────────────────────────────────────
  if (opts.showQuestions) {
    lines.push("");
    lines.push(`Inserted questions (${d.insertedQuestions.length}):`);
    for (const q of d.insertedQuestions) {
      lines.push(`  ${q.id}  [${q.type}]`);
      lines.push(`    contentKeys           : ${q.contentKeys.join(", ") || "(none)"}`);
      lines.push(`    knowledgeBaseSources  : ${q.knowledgeBaseSourceIds.join(", ") || "(none)"}`);
    }
  }

  return lines.join("\n");
}

function fmtDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function fmtSkillShas(raw: string | null): string {
  if (!raw) return "n/a";
  // skill_sha may be a single sha or comma-joined list
  return raw
    .split(",")
    .map((s) => s.trim().slice(0, 8))
    .filter(Boolean)
    .join(", ");
}

/**
 * inspect-attempt subcommand.
 *
 * Exit codes:
 *   0 — attempt found and rendered
 *   2 — attempt not found OR DB connect failed
 *   (NEVER exits 1 — this is a diagnostic command, not a regression gate)
 */
async function cmdInspectAttempt(
  attemptId: string,
  showStderr: boolean,
  showQuestions: boolean,
): Promise<void> {
  if (!process.env["DATABASE_URL"]) {
    console.error(
      "DATABASE_URL not set — run from inside the api container or " +
        "set DATABASE_URL to point at the VPS postgres",
    );
    process.exit(2);
  }

  let diagnostic: AttemptDiagnostic;
  try {
    diagnostic = await loadAttemptDiagnostic(attemptId);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ATTEMPT_NOT_FOUND") {
      console.error(`attempt ${attemptId} not found`);
    } else {
      console.error(
        "inspect-attempt failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
    process.exit(2);
  }

  const report = renderAttemptReport(diagnostic, { showStderr, showQuestions });
  console.log(report);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    level: { type: "string" },
    type: { type: "string" },
    out: { type: "string" },
    "attempt-id": { type: "string" },
    strict: { type: "boolean" },
    "strict-runtime": { type: "boolean" },
    "show-stderr": { type: "boolean" },
    "show-questions": { type: "boolean" },
    "skip-fixture-check": { type: "boolean" },
  },
  allowPositionals: true,
});

const subcommand = positionals[0];

if (subcommand === "score-goldens") {
  const level = values["level"] as Level | undefined;
  const type = values["type"] as EvalType | undefined;
  const strict = values["strict"] as boolean | undefined;
  const ok = await cmdScoreGoldens(level, type, strict);
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
    console.error("Usage: cli-typed.ts score-candidate --attempt-id <uuid> [--strict-runtime] [--skip-fixture-check]");
    process.exit(2);
  }
  try {
    await cmdScoreCandidate(
      attemptId,
      values["strict-runtime"] === true,
      values["skip-fixture-check"] === true,
    );
  } catch (err) {
    console.error(
      "score-candidate failed:",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(2);
  }
} else if (subcommand === "inspect-attempt") {
  const attemptId = values["attempt-id"];
  if (!attemptId) {
    console.error("Usage: cli-typed.ts inspect-attempt --attempt-id <uuid> [--show-stderr] [--show-questions]");
    process.exit(2);
  }
  await cmdInspectAttempt(
    attemptId,
    values["show-stderr"] === true,
    values["show-questions"] === true,
  );
} else {
  console.error(
    `Unknown subcommand: ${subcommand ?? "(none)"}\n` +
      "Usage: cli-typed.ts score-goldens|write-baseline|diff-against-baseline|score-candidate|inspect-attempt\n" +
      "         [--level L1|L2|L3] [--type mcq|log_analysis|scenario|kql] [--out <path>]\n" +
      "         [--attempt-id <uuid>]      (score-candidate / inspect-attempt)\n" +
      "         [--strict-runtime]         (score-candidate: exit 1 when runtime metrics fail thresholds)\n" +
      "         [--show-stderr]            (inspect-attempt: print stderr_tail block)\n" +
      "         [--show-questions]         (inspect-attempt: print per-question content keys)",
  );
  process.exit(2);
}

} // end if (import.meta.url === pathToFileURL(...).href)
