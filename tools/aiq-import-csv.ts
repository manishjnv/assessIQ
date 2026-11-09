/**
 * tools/aiq-import-csv.ts
 *
 * Bulk import of the question generator's v2 CSV files into a named tenant, through the SAME
 * service functions the admin route (POST /api/admin/super/question-imports and .../:id/commit)
 * calls: parseImportFile -> stageImport -> commitImport (modules/04-question-bank/src/import/),
 * then publishPack (service/packs.ts). Every validation, duplicate rule, audit row and
 * limit (2,000 rows, 4 MB per file) is therefore the route's own.
 *
 * Usage:
 *   pnpm tsx tools/aiq-import-csv.ts --tenant <slug> --pack-name "<name>" [--domain aptitude]
 *       [--commit] [--publish] <file.csv> [<file2.csv> ...]
 *
 * Default is a DRY RUN: previewImport (READ ONLY transaction) validates every row and stores
 * nothing. With --commit each file is staged and committed (one transaction each) into the
 * pack named --pack-name (created as a draft by the first committed file, found by name for
 * later files and later runs). Rows whose seed_ref already exists in the tenant are decided
 * 'duplicate' by stageImport (one set-based query) and skipped, so a re-run is idempotent.
 * --publish (needs --commit) publishes the pack at the end through publishPack.
 *
 * Attribution: the oldest active admin of the tenant (same rule as aiq-import-pack.ts).
 * BYPASSRLS use: the same two pre-tenant lookups as the pack tool (tenant slug, admin).
 * The pack lookup by name runs inside withTenant (RLS on).
 *
 * Exit codes: 0 ok, 1 tenant or admin not found, 2 file not found, 3 validation error
 * (row errors, limits, publish refused), 4 conflict, 5 unexpected error / bad arguments.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { parseImportFile } from "../modules/04-question-bank/src/import/parse.js";
import { IMPORT_MAX_BYTES, IMPORT_MAX_ROWS } from "../modules/04-question-bank/src/import/limits.js";
import type { DryRunReport, ImportFileMeta, ParseResult } from "../modules/04-question-bank/src/import/types.js";

// ---------------------------------------------------------------------------
// Types and arguments
// ---------------------------------------------------------------------------

export class CliError extends Error {
  constructor(public readonly exitCode: number, message: string) {
    super(message);
  }
}

export interface Args {
  tenant: string;
  packName: string;
  domain: string;
  commit: boolean;
  publish: boolean;
  files: string[];
}

export const USAGE =
  'Usage: pnpm tsx tools/aiq-import-csv.ts --tenant <slug> --pack-name "<name>" [--domain aptitude] [--commit] [--publish] <file.csv> [<file2.csv> ...]';

export function parseArgs(argv: string[]): Args {
  const a: Args = { tenant: "", packName: "", domain: "aptitude", commit: false, publish: false, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--commit") a.commit = true;
    else if (arg === "--publish") a.publish = true;
    else if (arg === "--tenant" || arg === "--pack-name" || arg === "--domain") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new CliError(5, `${arg} requires a value.\n${USAGE}`);
      if (arg === "--tenant") a.tenant = v;
      else if (arg === "--pack-name") a.packName = v;
      else a.domain = v;
    } else if (arg.startsWith("--")) throw new CliError(5, `unknown flag '${arg}'.\n${USAGE}`);
    else a.files.push(arg);
  }
  if (a.tenant === "") throw new CliError(5, `--tenant <slug> is required.\n${USAGE}`);
  if (a.packName.trim() === "") throw new CliError(5, `--pack-name is required.\n${USAGE}`);
  if (a.files.length === 0) throw new CliError(5, `at least one CSV file is required.\n${USAGE}`);
  if (a.publish && !a.commit) throw new CliError(5, `--publish only works together with --commit.\n${USAGE}`);
  return a;
}

/** Everything that touches the database, injected so tests can use fakes. */
export interface Deps {
  readFile(path: string): Promise<Buffer>;
  resolveTenant(slug: string): Promise<string | null>;
  resolveAdmin(tenantId: string): Promise<string | null>;
  preview(tenantId: string, meta: ImportFileMeta, parsed: ParseResult): Promise<{ rows: Array<{ row: number; decision: string; errors: Array<{ row: number; column: string; message: string }>; dupScope: "file" | "existing" | null }> }>;
  stage(tenantId: string, userId: string, meta: ImportFileMeta, parsed: ParseResult): Promise<DryRunReport>;
  commit(tenantId: string, userId: string, importId: string): Promise<{ packId: string; committed: number }>;
  discard(tenantId: string, userId: string, importId: string): Promise<unknown>;
  findPack(tenantId: string, name: string): Promise<string | null>;
  publish(tenantId: string, packId: string, userId: string): Promise<unknown>;
  err(line: string): void;
}

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const codeOf = (e: unknown): string => {
  const x = e as { code?: string; details?: { code?: string } };
  return x.details?.code ?? x.code ?? "";
};
const nameOf = (e: unknown): string => (e as { constructor?: { name?: string } }).constructor?.name ?? "";

/** Maps a service error to a CliError (validation 3, conflict 4, other 5). */
export function toCliError(e: unknown): CliError {
  if (e instanceof CliError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const n = nameOf(e);
  if (n === "ValidationError") return new CliError(3, `${codeOf(e)}: ${msg}`);
  if (n === "ConflictError") return new CliError(4, `${codeOf(e)}: ${msg}`);
  return new CliError(5, `unexpected error: ${msg}`);
}

async function loadFiles(args: Args, deps: Deps): Promise<Array<{ path: string; name: string; data: Buffer }>> {
  const out = [];
  for (const path of args.files) {
    try {
      out.push({ path, name: basename(path), data: await deps.readFile(path) });
    } catch {
      throw new CliError(2, `File not found: ${path}`);
    }
  }
  return out;
}

const metaOf = (args: Args, f: { name: string; data: Buffer }, targetPackId?: string): ImportFileMeta => ({
  fileName: f.name, fileSha256: sha256(f.data), format: "csv", domain: args.domain, packName: args.packName,
  // ponytail: trigram "similar" flag skipped (advisory only, one scan per row is slow for 1,650 rows); exact, normalised and seed_ref checks still run.
  skipTrigram: true,
  ...(targetPackId !== undefined ? { targetPackId } : {}),
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

export interface DryRunOut {
  mode: "dry-run";
  files: Array<{ file: string; rows: number; ok: number; errors: number; duplicates_existing: number; duplicates_in_file: number }>;
  rows: number;
  row_errors: Array<{ file: string; row: number; column: string; message: string }>;
  duplicate_seed_refs: Array<{ seed_ref: string; first: string; again: string }>;
  files_over_limits: Array<{ file: string; reason: string }>;
}

export async function dryRun(args: Args, deps: Deps): Promise<{ report: DryRunOut; exitCode: number }> {
  const files = await loadFiles(args, deps);
  const tenantId = await deps.resolveTenant(args.tenant);
  if (tenantId === null) throw new CliError(1, `Tenant not found: ${args.tenant}`);
  const report: DryRunOut = { mode: "dry-run", files: [], rows: 0, row_errors: [], duplicate_seed_refs: [], files_over_limits: [] };
  const seen = new Map<string, string>(); // seed_ref -> "file:row" (across all files)
  for (const f of files) {
    if (f.data.byteLength > IMPORT_MAX_BYTES) {
      report.files_over_limits.push({ file: f.name, reason: `larger than ${IMPORT_MAX_BYTES} bytes (${f.data.byteLength})` });
      continue;
    }
    let parsed: ParseResult;
    try {
      parsed = await parseImportFile("csv", f.data);
    } catch (e) {
      const ce = toCliError(e);
      if (codeOf(e) === "IMPORT_TOO_MANY_ROWS") report.files_over_limits.push({ file: f.name, reason: `more than ${IMPORT_MAX_ROWS} data rows` });
      else report.row_errors.push({ file: f.name, row: 0, column: "", message: ce.message });
      continue;
    }
    for (const p of parsed.rows) {
      const ref = (p.cells["seed_ref"] ?? "").trim();
      if (ref === "") continue;
      const first = seen.get(ref);
      if (first !== undefined) report.duplicate_seed_refs.push({ seed_ref: ref, first, again: `${f.name}:${p.row}` });
      else seen.set(ref, `${f.name}:${p.row}`);
    }
    const pv = await deps.preview(tenantId, metaOf(args, f), parsed);
    const errs = pv.rows.flatMap((r) => r.errors.map((e) => ({ file: f.name, row: e.row, column: e.column, message: e.message })));
    report.row_errors.push(...errs);
    report.rows += pv.rows.length;
    report.files.push({
      file: f.name, rows: pv.rows.length,
      ok: pv.rows.filter((r) => r.decision === "ok").length,
      errors: pv.rows.filter((r) => r.decision === "error").length,
      duplicates_existing: pv.rows.filter((r) => r.decision === "duplicate" && r.dupScope === "existing").length,
      duplicates_in_file: pv.rows.filter((r) => r.decision === "duplicate" && r.dupScope === "file").length,
    });
  }
  const bad = report.row_errors.length > 0 || report.files_over_limits.length > 0;
  return { report, exitCode: bad ? 3 : 0 };
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export interface CommitOut {
  mode: "commit";
  pack_id: string | null;
  files: Array<{ file: string; inserted: number; skipped_existing: number; errors: number; error_rows?: Array<{ row: number; column: string; message: string }> }>;
  total: { inserted: number; skipped_existing: number; errors: number };
  published: boolean;
}

export async function commitRun(args: Args, deps: Deps): Promise<{ report: CommitOut; exitCode: number }> {
  const files = await loadFiles(args, deps);
  const tenantId = await deps.resolveTenant(args.tenant);
  if (tenantId === null) throw new CliError(1, `Tenant not found: ${args.tenant}`);
  const adminId = await deps.resolveAdmin(tenantId);
  if (adminId === null) throw new CliError(1, `Tenant has no active admin, cannot attribute import (tenant: ${args.tenant})`);
  const report: CommitOut = { mode: "commit", pack_id: null, files: [], total: { inserted: 0, skipped_existing: 0, errors: 0 }, published: false };
  let exitCode = 0;
  try {
    for (const f of files) {
      let parsed: ParseResult;
      try {
        parsed = await parseImportFile("csv", f.data);
      } catch (e) {
        throw toCliError(e);
      }
      const packId = await deps.findPack(tenantId, args.packName); // never two packs with one name
      const staged = await deps.stage(tenantId, adminId, metaOf(args, f, packId ?? undefined), parsed);
      const dup = staged.counts.duplicate;
      if (staged.counts.error > 0) {
        // Strict: a file with a bad row is not committed (the route would skip the rows; a bulk tool must not drop them silently).
        await deps.discard(tenantId, adminId, staged.importId);
        const error_rows = staged.rows.flatMap((r) => r.errors.map((e) => ({ row: e.row, column: e.column, message: e.message })));
        report.files.push({ file: f.name, inserted: 0, skipped_existing: dup, errors: staged.counts.error, error_rows });
        report.total.errors += staged.counts.error;
        exitCode = 3;
        break;
      }
      let inserted = 0;
      if (staged.counts.ok === 0) {
        await deps.discard(tenantId, adminId, staged.importId); // everything already there: nothing to commit
      } else {
        const r = await deps.commit(tenantId, adminId, staged.importId);
        report.pack_id = r.packId;
        inserted = r.committed;
      }
      if (report.pack_id === null && packId !== null) report.pack_id = packId;
      report.files.push({ file: f.name, inserted, skipped_existing: dup, errors: 0 });
      report.total.inserted += inserted;
      report.total.skipped_existing += dup;
    }
    if (args.publish && exitCode === 0) {
      if (report.pack_id === null) throw new CliError(3, "nothing to publish: the pack does not exist");
      try {
        await deps.publish(tenantId, report.pack_id, adminId);
        report.published = true;
      } catch (e) {
        const ce = toCliError(e);
        throw new CliError(3, `publish refused: ${ce.message}`);
      }
    }
  } catch (e) {
    const ce = toCliError(e);
    // Print what was done before the failure so a re-run knows where it stopped.
    deps.err(JSON.stringify({ partial: report, error: ce.message }));
    throw ce;
  }
  deps.err(
    `aiq-import-csv tenant=${args.tenant} pack="${args.packName}" pack_id=${report.pack_id ?? "-"} actor=${adminId} files=${files.length} ` +
      `inserted=${report.total.inserted} skipped_existing=${report.total.skipped_existing} errors=${report.total.errors} published=${report.published}`,
  );
  return { report, exitCode };
}

// ---------------------------------------------------------------------------
// Production wiring (dynamic imports: tests never load the database layer)
// ---------------------------------------------------------------------------

async function realDeps(): Promise<{ deps: Deps; close: () => Promise<void> }> {
  const { Client } = await import("pg");
  const { config } = await import("@assessiq/core");
  const { withTenant, closePool } = await import("@assessiq/tenancy");
  const { stageImport, previewImport, discardImport } = await import("../modules/04-question-bank/src/import/staging.js");
  const { commitImport } = await import("../modules/04-question-bank/src/import/commit.js");
  const { publishPack } = await import("../modules/04-question-bank/src/service/packs.js");
  const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T | null> => {
    const c = new Client({ connectionString: config.DATABASE_URL }); // system role, BYPASSRLS (pre-tenant lookups only)
    await c.connect();
    try {
      return ((await c.query<T>(sql, params)).rows[0] as T | undefined) ?? null;
    } finally {
      await c.end();
    }
  };
  const deps: Deps = {
    readFile: (p) => readFile(p),
    resolveTenant: async (slug) => (await one<{ id: string }>(`SELECT id FROM tenants WHERE slug = $1 LIMIT 1`, [slug]))?.id ?? null,
    resolveAdmin: async (tenantId) =>
      (await one<{ id: string }>(
        `SELECT id FROM users WHERE tenant_id = $1 AND role = 'admin' AND status = 'active' AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`,
        [tenantId],
      ))?.id ?? null,
    preview: (t, m, p) => previewImport(t, m, p),
    stage: (t, u, m, p) => stageImport(t, u, m, p),
    commit: (t, u, id) => commitImport(t, u, id, { mode: "skip-errors" }),
    discard: (t, u, id) => discardImport(t, u, id),
    findPack: (t, name) =>
      withTenant(t, async (client) => {
        const r = await client.query<{ id: string }>(
          `SELECT id FROM question_packs WHERE tenant_id = $1 AND name = $2 AND status <> 'archived' ORDER BY created_at ASC LIMIT 1`,
          [t, name],
        );
        return r.rows[0]?.id ?? null;
      }),
    publish: (t, id, u) => publishPack(t, id, u),
    err: (l) => void process.stderr.write(l + "\n"),
  };
  return { deps, close: () => closePool() };
}

async function main(): Promise<number> {
  let close: (() => Promise<void>) | undefined;
  try {
    const args = parseArgs(process.argv.slice(2));
    const r = await realDeps();
    close = r.close;
    const { report, exitCode } = args.commit ? await commitRun(args, r.deps) : await dryRun(args, r.deps);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return exitCode;
  } catch (e) {
    const ce = toCliError(e);
    process.stderr.write(ce.message + "\n");
    return ce.exitCode;
  } finally {
    await close?.().catch(() => undefined);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then((code) => process.exit(code));
}
