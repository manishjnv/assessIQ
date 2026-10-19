/**
 * tools/exam-slice/load.mjs (EXP-15 tooling)
 *
 * Load one exam slice (a csv/xlsx file the owner places on the VPS) into the PLATFORM tenant through the
 * existing EXP-4 import pipeline (parseImportFile -> stageImport -> commitImport). Nothing here calls AI.
 *
 *   --dry-run (default)  parse + validate + duplicate-check. Read-only DB transaction, no writes.
 *   --apply              stage + commit as the oldest active super admin of the platform tenant.
 *                        Refused unless a dry run of the same file + flags passed in the last hour.
 *
 * Run inside the api container (tools/ is bind-mounted at /app/tools):
 *   docker exec assessiq-api pnpm exec tsx tools/exam-slice/load.mjs --file /tmp/slice.csv \
 *     --domain <slug> --pack-name "<name>" --rights-status original --source-ref "<id>" --out /tmp/report.md
 * Full steps: docs/runbooks/exam-slice-spot-check.md
 *
 * Exit codes: 0 ok, 1 dry run found row errors, 2 usage error or apply refused, 3 unexpected error.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export const STATE_MAX_AGE_MS = 60 * 60 * 1000;
export const SPOT_CHECK_SIZE = 20;
// ponytail: copy of IMPORT_RIGHTS in modules/04-question-bank/src/import/v2.ts (not exported from the module index); the pipeline still validates every row.
export const RIGHTS = ["original", "derived_from_source", "scraped_raw", "licensed", "metadata_only"];
const ANSWER_KEY_COLUMNS = ["correct", "answer", "correct_order"];

export class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Pure helpers (tested without a database)
// ---------------------------------------------------------------------------

export function parseFlags(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      file: { type: "string" }, domain: { type: "string" }, "pack-name": { type: "string" },
      "rights-status": { type: "string" }, "source-ref": { type: "string" }, out: { type: "string" },
      "dry-run": { type: "boolean", default: false }, apply: { type: "boolean", default: false },
      "skip-errors": { type: "boolean", default: false },
    },
    strict: true,
  });
  for (const k of ["file", "domain", "pack-name", "rights-status", "source-ref"]) {
    if (!values[k]) throw new UsageError(`--${k} is required`);
  }
  if (values.apply && values["dry-run"]) throw new UsageError("use --dry-run or --apply, not both");
  if (!RIGHTS.includes(values["rights-status"])) throw new UsageError(`--rights-status must be one of: ${RIGHTS.join(", ")}`);
  const format = { ".csv": "csv", ".xlsx": "xlsx" }[extname(values.file).toLowerCase()];
  if (!format) throw new UsageError("--file must end in .csv or .xlsx");
  return {
    file: values.file, domain: values.domain, packName: values["pack-name"], rights: values["rights-status"],
    sourceRef: values["source-ref"], out: values.out, apply: values.apply, skipErrors: values["skip-errors"], format,
  };
}

/** Hash of the file bytes plus every flag that changes the result. The dry-run gate compares this value. */
export function runHash(bytes, o) {
  return createHash("sha256").update(bytes)
    .update(`\n${JSON.stringify([o.domain, o.packName, o.rights, o.sourceRef])}`).digest("hex");
}

/** Fill a blank rights_status / source_ref cell from the flags. Returns the new parse result and the rows that were filled. */
export function applyDefaults(parsed, o) {
  const rightsFilled = new Set();
  const rows = parsed.rows.map((r) => {
    const cells = { ...r.cells };
    if ((cells.rights_status ?? "") === "") { cells.rights_status = o.rights; rightsFilled.add(r.row); }
    if ((cells.source_ref ?? "") === "") cells.source_ref = o.sourceRef;
    return { row: r.row, cells };
  });
  return { parsed: { rows, errors: parsed.errors }, rightsFilled };
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);

/** One report line per row: what the owner reads, plus the flags used to pick the spot-check rows. */
export function buildItems(rows, rightsFilled, o) {
  return rows.map((r) => {
    const raw = r.raw ?? {};
    const text = String(raw.question ?? r.normalized?.content?.question ?? "").replace(/\s+/g, " ").trim();
    const keyPresent = ANSWER_KEY_COLUMNS.some((k) => (raw[k] ?? "").trim() !== "");
    const rights = raw.rights_status ?? "";
    const problems = r.errors.map((e) => (e.column ? `${e.column}: ${e.message}` : e.message));
    if (r.decision === "duplicate") {
      problems.push(`duplicate (${r.dupClass ?? "exact"}) of ${r.dupScope === "file" ? "an earlier row of this file" : "an existing question"}`);
    }
    if (r.dupClass === "similar") problems.push("similar to an existing question (80% or more)");
    if (!keyPresent) problems.push("answer key missing");
    if (rights !== "" && rights !== o.rights) problems.push(`rights_status '${rights}' differs from --rights-status '${o.rights}'`);
    return {
      row: r.row, text, type: raw.type ?? "", keyPresent, rights, rightsFilled: rightsFilled.has(r.row),
      sourceRef: raw.source_ref ?? "", subtopic: (raw.subtopic ?? "").trim(), decision: r.decision, dupScope: r.dupScope ?? null,
      similar: r.dupClass === "similar", problems,
    };
  });
}

export function summarise(items) {
  const n = (f) => items.filter(f).length;
  return {
    rows: items.length,
    valid: n((i) => i.decision === "ok"),
    errors: n((i) => i.decision === "error"),
    duplicatesInFile: n((i) => i.dupScope === "file"),
    duplicatesExisting: n((i) => i.dupScope === "existing"),
    similar: n((i) => i.similar),
    missingKey: n((i) => !i.keyPresent),
    rightsBlank: n((i) => i.rightsFilled),
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic spot-check list. Same hash and same rows give the same list.
 * 1. every row with a problem; 2. at least 2 rows per subtopic (when a subtopic column exists); 3. fill to `size` at random.
 * More than `size` rows come back when more rows have a problem.
 */
export function pickSpotCheck(items, hash, size = SPOT_CHECK_SIZE) {
  const rand = mulberry32(parseInt(hash.slice(0, 8), 16));
  const shuffle = (a) => {
    const b = [...a];
    for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; }
    return b;
  };
  const sorted = [...items].sort((a, b) => a.row - b.row);
  const chosen = new Map();
  const take = (i, why) => { if (!chosen.has(i.row)) chosen.set(i.row, why); };
  for (const i of sorted) if (i.problems.length > 0) take(i, "has a problem");
  const bySub = new Map();
  for (const i of sorted) if (i.subtopic !== "") bySub.set(i.subtopic, [...(bySub.get(i.subtopic) ?? []), i]);
  for (const sub of [...bySub.keys()].sort()) {
    const group = bySub.get(sub);
    let have = group.filter((i) => chosen.has(i.row)).length;
    for (const i of shuffle(group)) { if (have >= 2) break; if (!chosen.has(i.row)) { take(i, `subtopic ${sub}`); have++; } }
  }
  for (const i of shuffle(sorted)) { if (chosen.size >= size) break; take(i, "random"); }
  return sorted.filter((i) => chosen.has(i.row)).map((i) => ({ row: i.row, why: chosen.get(i.row) }));
}

const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function renderReport({ o, hash, items, counts, spot, mode, checksRun, applied }) {
  const L = [];
  L.push(`# Exam slice report (${mode})`, "");
  L.push(`- File: \`${basename(o.file)}\``, `- Run hash: \`${hash}\``, `- Domain: ${o.domain}`, `- Pack name: ${o.packName}`);
  L.push(`- Rights status flag: ${o.rights}`, `- Source ref flag: ${o.sourceRef}`);
  L.push(`- Duplicate checks run: ${checksRun.join(", ")}`);
  if (applied) L.push(`- Import id: ${applied.importId}`, `- Pack id: ${applied.packId}`, `- Committed: ${applied.committed}`);
  L.push("", "## Counts", "", "| Check | Count |", "| --- | --- |");
  L.push(`| Rows | ${counts.rows} |`, `| Valid | ${counts.valid} |`, `| Errors | ${counts.errors} |`);
  L.push(`| Duplicates inside the file | ${counts.duplicatesInFile} |`, `| Duplicates of existing questions | ${counts.duplicatesExisting} |`);
  L.push(`| Similar to an existing question (warning) | ${counts.similar} |`, `| Missing answer key | ${counts.missingKey} |`);
  L.push(`| rights_status blank in file (filled from the flag) | ${counts.rightsBlank} |`);
  L.push("", `## Spot-check list (${spot.length} rows)`, "", "| Row | Why |", "| --- | --- |");
  for (const s of spot) L.push(`| ${s.row} | ${s.why} |`);
  L.push("", "## Items", "", "| Row | Question (first 60 characters) | Type | Key | Rights | Source ref | Problem |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const i of items) {
    L.push(`| ${i.row} | ${cell(clip(i.text, 60))} | ${cell(i.type)} | ${i.keyPresent ? "Y" : "N"} | ${cell(i.rights)} | ${cell(clip(i.sourceRef, 40))} | ${cell(i.problems.join("; "))} |`);
  }
  return L.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Orchestration (dependencies injected so tests need no database)
// ---------------------------------------------------------------------------

const statePath = (dir, hash) => join(dir, `exam-slice-dryrun-${hash.slice(0, 16)}.json`);

export async function run(o, deps) {
  const bytes = await deps.readFile(o.file);
  const hash = runHash(bytes, o);
  if (o.apply) {
    let at = 0;
    try { at = Date.parse(JSON.parse(await deps.readFile(statePath(deps.stateDir, hash), "utf8")).at); } catch { /* no state file */ }
    if (!(deps.now() - at < STATE_MAX_AGE_MS)) {
      throw new UsageError("apply refused: no passing dry run of this file and these flags in the last hour. Run --dry-run first.");
    }
  }
  const parsed0 = await deps.parse(o.format, bytes);
  const { parsed, rightsFilled } = applyDefaults(parsed0, o);
  const meta = { fileName: basename(o.file), fileSha256: createHash("sha256").update(bytes).digest("hex"), format: o.format, domain: o.domain, packName: o.packName };
  const preview = await deps.preview(deps.tenantId, meta, parsed);
  const items = buildItems(preview.rows, rightsFilled, o);
  const counts = summarise(items);
  const spot = pickSpotCheck(items, hash);

  let applied = null;
  if (o.apply) {
    if (counts.errors > 0 && !o.skipErrors) {
      throw new UsageError(`apply refused: ${counts.errors} row(s) have errors. Fix the file, or add --skip-errors to load the valid rows only.`);
    }
    const actor = await deps.resolveActor(deps.tenantId);
    const staged = await deps.stage(deps.tenantId, actor, meta, parsed);
    applied = await deps.commit(deps.tenantId, actor, staged.importId, { mode: "skip-errors" });
  } else if (counts.errors === 0) {
    await deps.writeFile(statePath(deps.stateDir, hash), JSON.stringify({ hash, at: new Date(deps.now()).toISOString() }));
  }
  const out = o.out ?? `exam-slice-report-${hash.slice(0, 8)}.md`;
  await deps.writeFile(out, renderReport({ o, hash, items, counts, spot, mode: o.apply ? "apply" : "dry run", checksRun: preview.checksRun, applied }));
  return { counts, spot, out, applied, code: !o.apply && counts.errors > 0 ? 1 : 0 };
}

export function summaryLines(r) {
  const c = r.counts;
  return [
    `rows ${c.rows} | valid ${c.valid} | errors ${c.errors} | dup in file ${c.duplicatesInFile} | dup existing ${c.duplicatesExisting} | similar ${c.similar} | missing key ${c.missingKey} | rights blank ${c.rightsBlank}`,
    `spot-check rows: ${r.spot.map((s) => s.row).join(", ")}`,
    r.applied ? `committed ${r.applied.committed} questions into pack ${r.applied.packId}` : "dry run: nothing was written to the database",
    `report: ${r.out}`,
  ];
}

// ---------------------------------------------------------------------------
// CLI (real dependencies are loaded only here, so tests never import the TypeScript modules)
// ---------------------------------------------------------------------------

async function realDeps() {
  const qb = await import("../../modules/04-question-bank/src/index.ts");
  const { config } = await import("@assessiq/core");
  const pg = await import("pg");
  const Client = pg.Client ?? pg.default.Client;
  return {
    readFile: (p, enc) => readFile(p, enc),
    writeFile: (p, s) => writeFile(p, s, "utf8"),
    now: () => Date.now(),
    stateDir: tmpdir(),
    tenantId: config.PLATFORM_TENANT_ID,
    parse: qb.parseImportFile,
    preview: qb.previewImport,
    stage: qb.stageImport,
    commit: qb.commitImport,
    // BYPASSRLS lookup of the author only (same pattern as tools/aiq-import-pack.ts); the load itself runs under withTenant.
    async resolveActor(tenantId) {
      const c = new Client({ connectionString: config.DATABASE_URL });
      await c.connect();
      try {
        const r = await c.query(
          `SELECT id FROM users WHERE tenant_id = $1 AND role = 'super_admin' AND status = 'active' AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`,
          [tenantId],
        );
        if (r.rows[0] === undefined) throw new UsageError("the platform tenant has no active super admin");
        return r.rows[0].id;
      } finally { await c.end(); }
    },
  };
}

async function main() {
  let code = 0;
  try {
    const o = parseFlags(process.argv.slice(2));
    const r = await run(o, await realDeps());
    for (const line of summaryLines(r)) console.log(line);
    code = r.code;
  } catch (e) {
    console.error(e instanceof UsageError || e?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? `error: ${e.message}` : e);
    code = e instanceof UsageError || e?.code?.startsWith?.("ERR_PARSE_ARGS") ? 2 : 3;
  }
  try { await (await import("@assessiq/tenancy")).closePool(); } catch { /* pool was never opened */ }
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
