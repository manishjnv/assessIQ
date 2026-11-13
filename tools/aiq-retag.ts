/**
 * tools/aiq-retag.ts   (S109-D6)
 *
 * Moves LIVE template questions from one subject-map node to another by seed_ref prefix, through
 * retagBySeedPrefix (modules/04-question-bank/src/service/retag.ts). Only the link to the from-node is
 * swapped; stage, exam style and every other link stay. Idempotent. Runs in the assessiq-api container
 * the same way tools/aiq-import-csv.ts does (same config, same platform tenant, oldest active super_admin).
 *
 * Usage:
 *   pnpm tsx tools/aiq-retag.ts --moves moves.json [--pack <slug>]... [--include-clones] [--commit]
 *   pnpm tsx tools/aiq-retag.ts --node-diff
 *
 * moves.json: [{ "seedPrefix": "coord.distance_integer@", "fromNode": "quant/geometry/lines-and-angles",
 *                "toNode": "quant/geometry/coordinate-geometry" }]
 * Without --commit it is a dry run (same numbers, no write). --node-diff is read only: it prints the node
 * paths in the bundled subject-map file that the database does not have yet (run --seed-frameworks of
 * aiq-import-csv.ts first, then the moves).
 * Exit codes: 0 ok, 3 bad prefix or unresolved node (validation), 1 no platform tenant or super admin, 5 bad arguments or unexpected error.
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import subjectMap from "../modules/04-question-bank/src/frameworks/subject-map.json" with { type: "json" };

export const USAGE = "Usage: pnpm tsx tools/aiq-retag.ts --moves <file.json> [--pack <slug>]... [--include-clones] [--commit] | --node-diff";

interface Args { moves: string; packs: string[]; includeClones: boolean; commit: boolean; nodeDiff: boolean }
class CliError extends Error { constructor(public readonly exitCode: number, m: string) { super(m); } }

export function parseArgs(argv: string[]): Args {
  const a: Args = { moves: "", packs: [], includeClones: false, commit: false, nodeDiff: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]!;
    if (x === "--commit") a.commit = true;
    else if (x === "--include-clones") a.includeClones = true;
    else if (x === "--node-diff") a.nodeDiff = true;
    else if (x === "--moves" || x === "--pack") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new CliError(5, `${x} requires a value.\n${USAGE}`);
      if (x === "--moves") a.moves = v; else a.packs.push(v);
    } else throw new CliError(5, `unknown argument '${x}'.\n${USAGE}`);
  }
  if (!a.nodeDiff && a.moves === "") throw new CliError(5, `--moves <file> is required.\n${USAGE}`);
  return a;
}

type SeedNode = { code: string; children?: SeedNode[] };
/** Every node path ("quant", "quant/geometry", "quant/geometry/circles") of the bundled file. */
export function bundledPaths(nodes: SeedNode[] = (subjectMap as { nodes: SeedNode[] }).nodes, prefix = ""): string[] {
  return nodes.flatMap((n) => { const p = prefix + n.code; return [p, ...bundledPaths(n.children ?? [], p + "/")]; });
}

async function main(): Promise<number> {
  let close: (() => Promise<void>) | undefined;
  try {
    const args = parseArgs(process.argv.slice(2));
    const { Client } = await import("pg");
    const { config } = await import("@assessiq/core");
    const { closePool } = await import("@assessiq/tenancy");
    close = closePool;
    // Same pre-tenant lookups as aiq-import-csv.ts: system login (BYPASSRLS), read only.
    const q = async <T extends Record<string, unknown>>(sql: string): Promise<T[]> => {
      const c = new Client({ connectionString: config.SYSTEM_DATABASE_URL ?? config.DATABASE_URL });
      await c.connect();
      try { return (await c.query<T>(sql)).rows; } finally { await c.end(); }
    };
    if (args.nodeDiff) {
      const rows = await q<{ id: string; parent_id: string | null; code: string }>(
        `SELECT n.id, n.parent_id, n.code FROM taxonomy_nodes n JOIN frameworks f ON f.id = n.framework_id
          WHERE f.tenant_id IS NULL AND f.slug = 'subject-map' AND n.tenant_id IS NULL`);
      const byId = new Map(rows.map((r) => [r.id, r]));
      const pathOf = (r: { parent_id: string | null; code: string }): string => (r.parent_id === null ? r.code : `${pathOf(byId.get(r.parent_id)!)}/${r.code}`);
      const have = new Set(rows.map(pathOf));
      const missing = bundledPaths().filter((p) => !have.has(p));
      process.stdout.write(missing.length === 0 ? "no difference: the database has every node of the bundled subject-map\n" : `missing in the database (${missing.length}):\n${missing.join("\n")}\n`);
      return 0;
    }
    const moves = JSON.parse(await readFile(args.moves, "utf8")) as unknown;
    if (!Array.isArray(moves)) throw new CliError(5, "the moves file must hold a JSON array");
    const tenant = (await q<{ id: string }>(`SELECT id FROM tenants WHERE slug = 'platform' LIMIT 1`))[0];
    const actor = tenant === undefined ? undefined : (await q<{ id: string }>(
      `SELECT id FROM users WHERE tenant_id = '${tenant.id}' AND role = 'super_admin' AND status = 'active' AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`))[0];
    if (tenant === undefined || actor === undefined) throw new CliError(1, "platform tenant or active super_admin not found");
    const { retagBySeedPrefix } = await import("../modules/04-question-bank/src/service/retag.js");
    const r = await retagBySeedPrefix(
      { tenantId: tenant.id, userId: actor.id, role: "super_admin" },
      { moves: moves as never, dryRun: !args.commit, includeClones: args.includeClones, ...(args.packs.length > 0 ? { packSlugs: args.packs } : {}) },
    );
    process.stdout.write(`${r.dryRun ? "DRY RUN (add --commit to write)" : "COMMITTED"}\n`);
    for (const m of r.moves) {
      process.stdout.write(`${m.seedPrefix}  ${m.fromNode} -> ${m.toNode}  matched=${m.matched} ${r.dryRun ? "would_change" : "changed"}=${r.dryRun ? m.matched - m.skippedNotInFromNode : m.changed} skippedNotInFromNode=${m.skippedNotInFromNode}` +
        `${m.clonesChanged !== undefined ? ` clones=${m.clonesChanged}` : ""} packs=${JSON.stringify(m.changedByPack)}\n`);
    }
    process.stdout.write(`TOTAL matched=${r.totals.matched} changed=${r.totals.changed} skippedNotInFromNode=${r.totals.skippedNotInFromNode} clones=${r.totals.clonesChanged}\n`);
    return 0;
  } catch (e) {
    const code = (e as { details?: { code?: string } }).details?.code ?? "";
    const name = (e as { constructor?: { name?: string } }).constructor?.name ?? "";
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return e instanceof CliError ? e.exitCode : name === "ValidationError" || name === "NotFoundError" || code !== "" ? 3 : 5;
  } finally {
    await close?.().catch(() => undefined);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then((code) => process.exit(code));
}
