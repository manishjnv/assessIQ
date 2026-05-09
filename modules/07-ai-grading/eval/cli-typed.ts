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
/* eslint-disable no-console */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  runEvalCase,
  loadBaseline,
  compareToBaseline,
  writeBaseline,
} from "./runner.js";
import type { EvalResult, EvalType } from "./runner.js";

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
// Entry point
// ---------------------------------------------------------------------------

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    level: { type: "string" },
    type: { type: "string" },
    out: { type: "string" },
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
} else {
  console.error(
    `Unknown subcommand: ${subcommand ?? "(none)"}\n` +
      "Usage: cli-typed.ts score-goldens|write-baseline|diff-against-baseline\n" +
      "         [--level L1|L2|L3] [--type mcq|log_analysis|scenario|kql] [--out <path>]",
  );
  process.exit(1);
}
