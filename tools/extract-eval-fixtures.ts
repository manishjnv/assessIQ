/**
 * tools/extract-eval-fixtures.ts
 *
 * Re-extracts the eval KB-source fixture files from the authoritative SOC KB
 * JSON so that modules/07-ai-grading/eval/fixtures/L*-sources.json stays in
 * sync with what the runtime actually feeds to the generation handler.
 *
 * WHEN TO RUN: any time modules/04-question-bank/src/knowledge-base/soc-l*.json
 * changes (new KB entries, ID renames, level_fit corrections).  If you skip
 * this step the eval fixture drifts and score-candidate will emit false
 * "unknown source ids" failures for IDs that exist in the runtime KB but are
 * absent from the stale fixture.
 *
 * What it does (and does NOT do):
 *  - Reads each soc-l*.json, extracts `sources` verbatim (no extra filtering).
 *  - The runtime handler receives the SAME slice — `SOC_KB_BY_LEVEL[level]`
 *    which is just `soc-l*.json`.sources — so the extracted fixture is
 *    guaranteed to match what filterByCitation validates against.
 *  - Does NOT modify the KB JSON, the handler, the MCP, or any generation skill.
 *  - Does NOT invent or omit fields: every field present in KbSource is
 *    preserved in the fixture (KbSourceRef in runner.ts carries the same set).
 *    Note: knowledgeBaseSources stored on questions rows drops `description`
 *    and `tags` (see types.ts GeneratedQuestionDraft), but those fields ARE
 *    carried in the fixture so scoreQuestion can resolve full source objects.
 *
 * Idempotency: running the script twice in a row produces no diff.  JSON is
 * serialised with 2-space indent + trailing newline, same as the existing
 * fixture files.  Source order from soc-l*.json is preserved verbatim —
 * this matches SOC_KB_BY_LEVEL in knowledge-base/index.ts which uses the raw
 * sources array without reordering.
 *
 * Usage (requires tsx, run from repo root):
 *   pnpm exec tsx tools/extract-eval-fixtures.ts              # dry-run (default)
 *   pnpm exec tsx tools/extract-eval-fixtures.ts --dry-run    # explicit dry-run
 *   pnpm exec tsx tools/extract-eval-fixtures.ts --apply      # write files
 *
 * Args:
 *   --dry-run    Compute and compare; do not write.
 *                Exit 0 if all fixtures are up-to-date, exit 1 if any differ.
 *   --apply      Write updated fixture files; exit 0 on success, exit 1 on error.
 *                If neither flag is given, dry-run mode is used (matches the
 *                project convention from tools/cleanup-stale-drafts.ts where
 *                --apply must be explicit to make changes).
 *
 * Exit codes:
 *   0  clean (dry-run: no diff; apply: writes succeeded)
 *   1  diff found (dry-run) OR IO/parse error (both modes)
 *   2  usage error (unknown flags)
 */

/* eslint-disable no-console */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = join(__dirname, "..");
const KB_DIR = join(REPO_ROOT, "modules", "04-question-bank", "src", "knowledge-base");
const FIXTURE_DIR = join(REPO_ROOT, "modules", "07-ai-grading", "eval", "fixtures");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface KbFile {
  version: string;
  level_fit: "L1" | "L2" | "L3";
  sources: Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Core extraction logic — exported for unit testing
// ---------------------------------------------------------------------------

/**
 * Reads soc-l<n>.json for the given level and returns the serialised content
 * that the fixture file should contain, plus metadata.
 *
 * Pure I/O function — no side effects beyond reading a file.
 * Exported so unit tests can verify determinism without invoking the full CLI.
 */
export async function computeFixtureContent(
  level: "L1" | "L2" | "L3",
): Promise<{ content: string; count: number; version: string }> {
  const n = level.slice(1); // "1" | "2" | "3"
  const kbPath = join(KB_DIR, `soc-l${n}.json`);

  let raw: string;
  try {
    raw = await readFile(kbPath, "utf8");
  } catch (err) {
    throw new Error(`Failed to read KB file ${kbPath}: ${(err as Error).message}`);
  }

  let kbFile: KbFile;
  try {
    kbFile = JSON.parse(raw) as KbFile;
  } catch (err) {
    throw new Error(`Failed to parse ${kbPath}: ${(err as Error).message}`);
  }

  if (!Array.isArray(kbFile.sources)) {
    throw new Error(`${kbPath} has no top-level "sources" array`);
  }

  if (kbFile.level_fit !== level) {
    throw new Error(
      `${kbPath} declares level_fit "${kbFile.level_fit}" but expected "${level}"`,
    );
  }

  // Preserve source order from the KB file.  The runtime handler uses
  // SOC_KB_BY_LEVEL[level] which is also the raw sources array — same order.
  // No additional filtering: the KB files are already level-scoped (enforced
  // by KbFileSchema.superRefine in knowledge-base/index.ts).
  const content = JSON.stringify(kbFile.sources, null, 2) + "\n";
  return { content, count: kbFile.sources.length, version: kbFile.version };
}

// ---------------------------------------------------------------------------
// Per-level processing
// ---------------------------------------------------------------------------

interface LevelResult {
  level: "L1" | "L2" | "L3";
  count: number;
  version: string;
  changed: boolean;
  written: boolean;
  error?: string;
}

async function processLevel(
  level: "L1" | "L2" | "L3",
  apply: boolean,
): Promise<LevelResult> {
  let computeResult: { content: string; count: number; version: string };
  try {
    computeResult = await computeFixtureContent(level);
  } catch (err) {
    return {
      level,
      count: 0,
      version: "?",
      changed: false,
      written: false,
      error: (err as Error).message,
    };
  }

  const { content, count, version } = computeResult;
  const fixturePath = join(FIXTURE_DIR, `${level}-sources.json`);

  // Compare with existing fixture file
  let existing: string | null = null;
  if (existsSync(fixturePath)) {
    try {
      existing = await readFile(fixturePath, "utf8");
    } catch {
      // Cannot read existing file — treat as changed so we write on --apply
    }
  }

  const changed = existing === null || existing !== content;

  if (apply && changed) {
    try {
      await writeFile(fixturePath, content, "utf8");
      return { level, count, version, changed, written: true };
    } catch (err) {
      return {
        level,
        count,
        version,
        changed,
        written: false,
        error: (err as Error).message,
      };
    }
  }

  return { level, count, version, changed, written: false };
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseCLIArgs(): { apply: boolean; dryRun: boolean } {
  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        "dry-run": { type: "boolean", default: false },
        apply: { type: "boolean", default: false },
      },
      strict: true,
    }));
  } catch (err) {
    process.stderr.write(
      `Usage error: ${err instanceof Error ? err.message : String(err)}\n` +
        "Usage: extract-eval-fixtures.ts [--dry-run | --apply]\n",
    );
    process.exit(2);
  }

  return {
    dryRun: values["dry-run"] as boolean,
    apply: values["apply"] as boolean,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { apply, dryRun } = parseCLIArgs();

  // When neither flag is set, default to dry-run (matches project convention
  // from cleanup-stale-drafts.ts: --apply is opt-in, dry-run is the safe default).
  const effectiveApply = apply && !dryRun;
  const mode = effectiveApply ? "apply" : "dry-run";

  console.log(`extract-eval-fixtures [${mode}]: syncing eval fixtures from SOC KB\n`);

  const results: LevelResult[] = [];
  let anyError = false;
  let anyChanged = false;

  for (const level of ["L1", "L2", "L3"] as const) {
    const result = await processLevel(level, effectiveApply);
    results.push(result);

    if (result.error) {
      console.error(`  ERROR [${result.level}]: ${result.error}`);
      anyError = true;
    } else {
      const changeCount = result.changed ? 1 : 0;
      let status: string;
      if (!result.changed) {
        status = "0 changes vs existing fixture";
      } else if (result.written) {
        status = `1 change — written to eval/fixtures/${result.level}-sources.json`;
      } else {
        status = "1 change vs existing fixture (stale)";
      }
      console.log(
        `  ${result.level}: ${result.count} sources extracted, ${status}` +
          ` (KB version ${result.version})`,
      );
      if (changeCount > 0) anyChanged = true;
    }
  }

  console.log("");

  if (anyError) {
    console.error("One or more levels failed — fixture files may be partially updated.");
    process.exit(1);
  }

  if (!effectiveApply && anyChanged) {
    console.error(
      "FIXTURE STALE: one or more fixture files diverge from the SOC KB.\n" +
        "Re-run with --apply to update:\n" +
        "  pnpm exec tsx tools/extract-eval-fixtures.ts --apply",
    );
    process.exit(1);
  }

  if (effectiveApply) {
    console.log("Done. Commit the updated fixture files with your KB changes.");
    console.log(
      "Re-run `pnpm eval:goldens-strict` to confirm no regressions before pushing.",
    );
  } else {
    console.log("All fixtures are up-to-date. No changes needed.");
  }
}

main().catch((err) => {
  console.error("extract-eval-fixtures: unexpected error:", err);
  process.exit(1);
});
