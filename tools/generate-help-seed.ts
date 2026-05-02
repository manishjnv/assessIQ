/**
 * tools/generate-help-seed.ts
 *
 * Reads all *.yml files under modules/16-help-system/content/en/,
 * validates each entry against HelpEntrySchema (Zod), and emits an
 * idempotent seed migration at:
 *   modules/16-help-system/migrations/0011_seed_help_content.sql
 *
 * Usage:
 *   pnpm tsx tools/generate-help-seed.ts
 *
 * Exit codes:
 *   0 — success (seed emitted or placeholder emitted when no YAML found)
 *   1 — validation failure (specific file + key reported to stderr)
 *
 * SQL encoding choice — dollar-quoting ($$...$$) for long_md:
 *   Dollar-quoting avoids escape-sequence complexity entirely and produces
 *   readable SQL even when the markdown contains single-quotes, backslashes,
 *   or multi-line content. short_text uses standard single-quoted strings
 *   with doubled single-quotes (simpler for the common single-line case).
 *
 * Idempotency note:
 *   ON CONFLICT (tenant_id, key, locale, version) DO NOTHING means re-running
 *   the migration after a YAML edit does not change v1 rows already seeded.
 *   To update existing content, use the upsertHelp service (bumps version).
 *
 * Windows compatibility:
 *   All paths use path.join() — no hardcoded forward-slashes.
 */

import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CONTENT_DIR = path.join(
  REPO_ROOT,
  "modules",
  "16-help-system",
  "content",
  "en",
);
const OUTPUT_FILE = path.join(
  REPO_ROOT,
  "modules",
  "16-help-system",
  "migrations",
  "0011_seed_help_content.sql",
);

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const HelpEntrySchema = z.object({
  audience: z.enum(["admin", "reviewer", "candidate", "all"]),
  short_text: z.string().min(1).max(120),
  long_md: z.string().optional(),
  related_keys: z.array(z.string()).optional(),
});

type HelpEntry = z.infer<typeof HelpEntrySchema>;

/**
 * Validates a help_id string.
 * Must be lowercase, dot-separated, only [a-z0-9_] per segment.
 * e.g. "admin.assessments.create.duration" is valid.
 * Rejects: "Admin.foo", "admin..foo", "admin.foo bar".
 */
function isValidHelpId(key: string): boolean {
  if (!key || key.length === 0) return false;
  const segments = key.split(".");
  if (segments.length < 2) return false;
  return segments.every((seg) => /^[a-z0-9_]+$/.test(seg));
}

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

/**
 * Escape a string for SQL single-quoted literal.
 * Doubles any embedded single-quotes.
 */
function sqEscape(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Render long_md using dollar-quoting for clean multi-line SQL.
 * Picks a unique dollar-tag if the content itself contains "$$".
 */
function renderLongMd(text: string): string {
  // Choose a tag that doesn't appear in the text.
  let tag = "$$";
  if (text.includes("$$")) {
    tag = "$HELPMD$";
    if (text.includes("$HELPMD$")) {
      // Extremely unlikely; use a timestamp-based tag as last resort.
      tag = `$HELP_${Date.now()}$`;
    }
  }
  return `${tag}${text}${tag}`;
}

/**
 * Build a single INSERT row.
 * - id: gen_random_uuid() (postgres-side; ON CONFLICT prevents duplicates)
 * - tenant_id: NULL (global default; seeded as superuser BYPASSRLS)
 */
function buildInsert(key: string, entry: HelpEntry): string {
  const longMdValue =
    entry.long_md !== undefined ? renderLongMd(entry.long_md) : "NULL";

  return (
    `INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)\n` +
    `VALUES (\n` +
    `  gen_random_uuid(),\n` +
    `  NULL,\n` +
    `  '${sqEscape(key)}',\n` +
    `  '${sqEscape(entry.audience)}',\n` +
    `  'en',\n` +
    `  '${sqEscape(entry.short_text)}',\n` +
    `  ${longMdValue},\n` +
    `  1,\n` +
    `  'active'\n` +
    `) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const timestamp = new Date().toISOString();

  // Check if content directory exists.
  let entries: string[];
  try {
    const dirEntries = await fsp.readdir(CONTENT_DIR);
    entries = dirEntries.filter((f) => f.endsWith(".yml"));
  } catch {
    entries = [];
  }

  if (entries.length === 0) {
    process.stdout.write(
      `No YAML files found at ${CONTENT_DIR} — emitting placeholder seed migration.\n`,
    );
    const placeholder =
      `-- generated by tools/generate-help-seed.ts on ${timestamp}\n` +
      `-- DO NOT EDIT BY HAND. Re-run the generator after editing YAML.\n` +
      `-- No YAML files were present when this placeholder was emitted.\n` +
      `SELECT 1;\n`;
    await fsp.writeFile(OUTPUT_FILE, placeholder, "utf8");
    process.stdout.write(`Written: ${OUTPUT_FILE}\n`);
    process.exit(0);
  }

  // Parse and validate all YAML files.
  const allInserts: string[] = [];
  let hasError = false;

  for (const filename of entries.sort()) {
    const filePath = path.join(CONTENT_DIR, filename);
    let raw: unknown;
    try {
      const text = await fsp.readFile(filePath, "utf8");
      raw = parseYaml(text);
    } catch (err) {
      process.stderr.write(
        `ERROR: Failed to parse YAML in ${filename}: ${String(err)}\n`,
      );
      hasError = true;
      continue;
    }

    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      process.stderr.write(
        `ERROR: ${filename}: top-level YAML must be a mapping of help_id => entry.\n`,
      );
      hasError = true;
      continue;
    }

    const fileMap = raw as Record<string, unknown>;

    for (const [helpId, value] of Object.entries(fileMap)) {
      // Validate the help_id key string.
      if (!isValidHelpId(helpId)) {
        process.stderr.write(
          `ERROR: ${filename}: invalid help_id "${helpId}" — ` +
            `must be lowercase dot-separated segments of [a-z0-9_] only ` +
            `(e.g. "admin.assessments.create.duration").\n`,
        );
        hasError = true;
        continue;
      }

      // Validate the entry object.
      const parsed = HelpEntrySchema.safeParse(value);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `  ${i.path.join(".")}: ${i.message}`)
          .join("\n");
        process.stderr.write(
          `ERROR: ${filename}: key "${helpId}" failed validation:\n${issues}\n`,
        );
        hasError = true;
        continue;
      }

      allInserts.push(buildInsert(helpId, parsed.data));
    }
  }

  if (hasError) {
    process.stderr.write(
      `\nValidation failed — no output file written. Fix the errors above and re-run.\n`,
    );
    process.exit(1);
  }

  // Emit the SQL migration.
  const header =
    `-- generated by tools/generate-help-seed.ts on ${timestamp}\n` +
    `-- DO NOT EDIT BY HAND. Re-run the generator after editing YAML:\n` +
    `--   pnpm tsx tools/generate-help-seed.ts\n` +
    `--\n` +
    `-- Idempotency: ON CONFLICT (tenant_id, key, locale, version) DO NOTHING\n` +
    `-- means re-running this migration after a YAML edit does not change v1\n` +
    `-- rows already seeded. To update content, use the upsertHelp service\n` +
    `-- (which bumps version). Global rows (tenant_id IS NULL) are inserted as\n` +
    `-- the postgres superuser which BYPASSes RLS — the app role cannot insert\n` +
    `-- global rows per the INSERT policy on help_content.\n`;

  const body =
    allInserts.length > 0
      ? allInserts.join("\n\n")
      : `-- No entries found in YAML files — nothing to seed.\nSELECT 1;`;

  const output = `${header}\n${body}\n`;
  await fsp.writeFile(OUTPUT_FILE, output, "utf8");
  process.stdout.write(
    `Written: ${OUTPUT_FILE} (${allInserts.length} row(s))\n`,
  );
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`generate-help-seed error: ${String(err)}\n`);
  process.exit(1);
});
