/**
 * tools/aiq-verify-activate.ts
 *
 * Verifies and/or activates a chosen set of platform template questions (by id list or seed_ref prefix) through
 * verifyQuestionsByIds (service/review.ts) and activateQuestionsByIds (service/packs.ts), and can backfill missing
 * question_versions snapshots for ACTIVE rows (backfillMissingSnapshots, service/packs.ts). Runs in the assessiq-api
 * container the same way tools/aiq-retag.ts does (same config, platform tenant, oldest active super_admin).
 *
 * Usage:
 *   pnpm tsx tools/aiq-verify-activate.ts (--ids-file <file> | --seed-prefix <p>... [--pack <slug>]...) [--verify] [--activate] [--commit [--expect <n>]]
 *   pnpm tsx tools/aiq-verify-activate.ts --backfill-snapshots [--pack <slug>]... [--commit [--expect <n>]]
 *
 * Dry run is the default. --expect <n> (needs --commit) must equal the resolved id count (backfill: the backfill
 * total) and is checked BEFORE the first write. With --verify and --activate, verify runs first, then activate
 * (two transactions); if activate fails after verify was written the tool says so and exits 4.
 * Seed prefixes must end with "@<digits>:" (e.g. "coord.distance_integer@1:"). The ids file has one uuid per line.
 * Limit: 5,000 ids per call; split bigger files.
 * Exit codes: 0 ok, 1 no platform tenant or super admin, 3 validation (bad prefix or uuid, count mismatch,
 * over limit, refused ids), 4 partial (verify written, activate failed), 5 bad arguments or unexpected error.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { seedRefPrefixError } from "../modules/04-question-bank/src/import/v2.js";

export const USAGE = "Usage: pnpm tsx tools/aiq-verify-activate.ts (--ids-file <file> | --seed-prefix <p>... [--pack <slug>]...) [--verify] [--activate] [--commit [--expect <n>]] | --backfill-snapshots [--pack <slug>]... [--commit [--expect <n>]]  (prefixes end like coord.distance_integer@1:)";
export const LIMIT_NOTE = "Note: the pack-wide Activate all button activates every draft of a pack except rows marked needs_fix or disputed, and Verify all verifies every in_review row. To hold a row out of a load, mark it needs_fix.";
export const MAX_IDS = 5000;

export interface Args {
  idsFile: string; seedPrefixes: string[]; packs: string[]; verify: boolean; activate: boolean;
  backfill: boolean; commit: boolean; expect: number | null;
}
export class CliError extends Error { constructor(public readonly exitCode: number, m: string) { super(m); } }

export interface Actor { tenantId: string; userId: string; role: "super_admin" }
export interface PackDescription {
  slug: string; total: number; byStatus: Record<string, number>; byReviewState: Record<string, number>;
  noVersion: number; otherDraftsInPack: number;
}
export interface Deps {
  readFile: (p: string) => Promise<string>;
  getActor: () => Promise<Actor | null>;
  resolveIds: (o: { seedPrefixes?: string[]; packSlugs?: string[] }) => Promise<string[]>;
  describeIds: (ids: string[]) => Promise<PackDescription[]>;
  verifyQuestionsByIds: (actor: Actor, ids: string[]) => Promise<{ verified: number; alreadyVerified: number }>;
  activateQuestionsByIds: (actor: Actor, ids: string[]) => Promise<{ activated: number; alreadyActive: number; snapshotsWritten: number; packs?: Array<{ packId: string; count: number; idsSha256: string }> }>;
  backfillMissingSnapshots: (actor: Actor, o: { commit: boolean; packSlugs?: string[]; expect?: number }) =>
    Promise<{ packs: Array<{ packId: string; slug: string; missing: number }>; total: number; written: number }>;
  out: (s: string) => void;
  err: (s: string) => void;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { idsFile: "", seedPrefixes: [], packs: [], verify: false, activate: false, backfill: false, commit: false, expect: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]!;
    if (x === "--commit") a.commit = true;
    else if (x === "--verify") a.verify = true;
    else if (x === "--activate") a.activate = true;
    else if (x === "--backfill-snapshots") a.backfill = true;
    else if (x === "--ids-file" || x === "--seed-prefix" || x === "--pack" || x === "--expect") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new CliError(5, `${x} requires a value.\n${USAGE}`);
      if (x === "--ids-file") {
        if (a.idsFile !== "") throw new CliError(5, `--ids-file may be given once.\n${USAGE}`);
        a.idsFile = v;
      }
      else if (x === "--seed-prefix") a.seedPrefixes.push(v);
      else if (x === "--pack") a.packs.push(v);
      else {
        if (!/^[0-9]+$/.test(v)) throw new CliError(5, `--expect needs a whole number.\n${USAGE}`);
        a.expect = Number(v);
      }
    } else throw new CliError(5, `unknown argument '${x}'.\n${USAGE}`);
  }
  const bad = (m: string) => new CliError(5, `${m}\n${USAGE}`);
  if (a.expect !== null && !a.commit) throw bad("--expect only works together with --commit.");
  if (a.backfill) {
    if (a.idsFile !== "" || a.seedPrefixes.length > 0 || a.verify || a.activate) throw bad("--backfill-snapshots cannot be combined with --ids-file, --seed-prefix, --verify or --activate.");
    if (a.commit && a.expect === null) throw bad("--backfill-snapshots --commit needs --expect <n> (the total of the dry run).");
    return a;
  }
  if (a.idsFile !== "" && a.seedPrefixes.length > 0) throw bad("--ids-file and --seed-prefix cannot be used together.");
  if (a.idsFile === "" && a.seedPrefixes.length === 0) throw bad("one of --ids-file or --seed-prefix is required.");
  if (a.idsFile !== "" && a.packs.length > 0) throw bad("--pack only works with --seed-prefix.");
  if (!a.verify && !a.activate) throw bad("at least one of --verify or --activate is required.");
  return a;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One uuid per line, blank lines ignored, duplicates removed (first one wins, order kept). */
export function parseIdsFile(text: string): string[] {
  const seen = new Set<string>();
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const l = raw.trim();
    if (l === "") continue;
    if (!UUID.test(l)) throw new CliError(3, `ids file line ${i + 1}: not a uuid: ${l.slice(0, 60)}`);
    seen.add(l.toLowerCase());
  }
  return [...seen];
}

const sha = (ids: string[]): string => createHash("sha256").update([...ids].sort().join("\n")).digest("hex");

/** `committed`: the writes of this run are already in the database; a failure of this read must say so. */
async function postCheck(deps: Deps, actor: Actor, committed: boolean): Promise<string> {
  try {
    const r = await deps.backfillMissingSnapshots(actor, { commit: false });
    return `active rows without a snapshot: ${r.total} (must be 0 after a load)\n`;
  } catch (e) {
    if (committed) deps.err("The writes of this run WERE COMMITTED; only the read-only post-load check failed.\n");
    throw e;
  }
}

export async function run(args: Args, deps: Deps): Promise<number> {
  const actor = await deps.getActor();
  if (actor === null) throw new CliError(1, "platform tenant or active super_admin not found");
  const packOpt = args.packs.length > 0 ? { packSlugs: args.packs } : {};
  try {
    if (args.backfill) {
      const pre = await deps.backfillMissingSnapshots(actor, { commit: false, ...packOpt });
      if (args.expect !== null && args.expect !== pre.total) throw new CliError(3, `--expect ${args.expect} but the backfill total is ${pre.total}. Nothing written.`);
      if (!args.commit) {
        deps.out(`DRY RUN (add --commit to write)\n${JSON.stringify({ would_write: pre.total, packs: pre.packs }, null, 2)}\n`);
      } else {
        const r = await deps.backfillMissingSnapshots(actor, { commit: true, ...packOpt, ...(args.expect !== null ? { expect: args.expect } : {}) });
        deps.out(`COMMITTED\n${JSON.stringify({ total: r.total, written: r.written, packs: r.packs }, null, 2)}\n`);
      }
      deps.out(await postCheck(deps, actor, args.commit));
      deps.out(`${LIMIT_NOTE}\n`);
      return 0;
    }

    for (const p of args.seedPrefixes) {
      const e = seedRefPrefixError(p) ?? (/@[0-9]+:$/.test(p) ? null : "seed prefix must end with @<digits>: (e.g. coord.distance_integer@1:)");
      if (e !== null) throw new CliError(3, `bad seed prefix '${p}': ${e}`);
    }
    const ids = args.idsFile !== ""
      ? parseIdsFile(await deps.readFile(args.idsFile))
      : await deps.resolveIds({ seedPrefixes: args.seedPrefixes, ...packOpt });
    if (ids.length > MAX_IDS) throw new CliError(3, `${ids.length} ids is over the limit of ${MAX_IDS} per call. Split the file.`);
    if (args.expect !== null && args.expect !== ids.length) throw new CliError(3, `--expect ${args.expect} but ${ids.length} ids resolved. Nothing written.`);
    const digest = sha(ids);

    if (!args.commit) {
      const table = await deps.describeIds(ids);
      const sum = (f: (p: PackDescription) => number): number => table.reduce((n, p) => n + f(p), 0);
      const would = {
        verify: args.verify ? sum((p) => (p.byReviewState["in_review"] ?? 0) + (p.byReviewState["null"] ?? 0)) : null,
        activate: args.activate ? sum((p) => p.byStatus["draft"] ?? 0) : null,
        snapshots_to_write: args.activate ? sum((p) => p.noVersion) : null,
      };
      deps.out(`DRY RUN (add --commit to write)\n${JSON.stringify({ resolved_ids: ids.length, not_found_in_platform_packs: ids.length - sum((p) => p.total), ids_sha256: digest, would_change: would, other_drafts_in_pack: Object.fromEntries(table.map((p) => [p.slug, p.otherDraftsInPack])), packs: table }, null, 2)}\n`);
      deps.out(await postCheck(deps, actor, false));
      deps.out(`${LIMIT_NOTE}\n`);
      return 0;
    }

    deps.out(`COMMIT ids=${ids.length} ids_sha256=${digest} (over all ids; the activate result lists one idsSha256 per pack, equal to the audit row)\n`);
    let verified: unknown;
    if (args.verify) {
      verified = await deps.verifyQuestionsByIds(actor, ids);
      deps.out(`verify: ${JSON.stringify(verified)}\n`);
    }
    if (args.activate) {
      try {
        deps.out(`activate: ${JSON.stringify(await deps.activateQuestionsByIds(actor, ids))}\n`);
      } catch (e) {
        if (verified === undefined) throw e;
        deps.err(`${describe(e)}\n${badList(e) ?? ""}verify was written (${JSON.stringify(verified)}); activate was NOT written. Fix the cause and re-run with --activate only.\n`);
        return 4;
      }
    }
    deps.out(await postCheck(deps, actor, true));
    deps.out(`${LIMIT_NOTE}\n`);
    return 0;
  } catch (e) {
    if (e instanceof CliError) throw e;
    const list = badList(e);
    if (list !== null) {
      deps.err(`${describe(e)}\n${list}Nothing written.\n`);
      throw new CliError(3, "");
    }
    throw e;
  }
}

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The refused ids of a service error (details.bad), at most 20 lines; null when the error has none. */
function badList(e: unknown): string | null {
  const d = (e as { details?: { bad?: Array<{ id: string; reason: string }>; bad_count?: number } }).details;
  if (d?.bad === undefined) return null;
  return `refused ${d.bad_count ?? d.bad.length} id(s), first ${Math.min(20, d.bad.length)}:\n${d.bad.slice(0, 20).map((b) => `  ${b.id}  ${b.reason}`).join("\n")}\n`;
}

async function realDeps(): Promise<{ deps: Deps; close: () => Promise<void> }> {
  const { Client } = await import("pg");
  const { config } = await import("@assessiq/core");
  const { closePool } = await import("@assessiq/tenancy");
  // LIKE's default escape is the backslash, which likeOf uses.
  // Same pre-tenant lookups as aiq-retag.ts: system login (BYPASSRLS). Read only; every value is a bound parameter.
  const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const c = new Client({ connectionString: config.SYSTEM_DATABASE_URL ?? config.DATABASE_URL });
    await c.connect();
    try { return (await c.query<T>(sql, params)).rows; } finally { await c.end(); }
  };
  const tenant = (await q<{ id: string }>(`SELECT id FROM tenants WHERE slug = 'platform' LIMIT 1`))[0];
  const admin = tenant === undefined ? undefined : (await q<{ id: string }>(
    `SELECT id FROM users WHERE tenant_id = $1 AND role = 'super_admin' AND status = 'active' AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`, [tenant.id]))[0];
  const actor: Actor | null = tenant === undefined || admin === undefined ? null : { tenantId: tenant.id, userId: admin.id, role: "super_admin" };
  const review = await import("../modules/04-question-bank/src/service/review.js") as unknown as Pick<Deps, "verifyQuestionsByIds">;
  const packs = await import("../modules/04-question-bank/src/service/packs.js") as unknown as Pick<Deps, "activateQuestionsByIds" | "backfillMissingSnapshots">;
  const likeOf = (p: string): string => `${p.replace(/[\\%_]/g, "\\$&")}%`;
  const deps: Deps = {
    readFile: (p) => readFile(p, "utf8"),
    getActor: async () => actor,
    resolveIds: async (o) => {
      if (o.packSlugs !== undefined && o.packSlugs.length > 0) {
        const have = new Set((await q<{ slug: string }>(`SELECT slug FROM question_packs WHERE tenant_id = $1 AND slug = ANY($2::text[])`, [actor?.tenantId, o.packSlugs])).map((r) => r.slug));
        const unknown = o.packSlugs.filter((x) => !have.has(x));
        if (unknown.length > 0) throw new CliError(3, `unknown --pack slug (not a platform pack): ${unknown.join(", ")}`);
      }
      return (await q<{ id: string }>(
      `SELECT DISTINCT q.id FROM question_source qs JOIN questions q ON q.id = qs.question_id JOIN question_packs p ON p.id = q.pack_id
        WHERE p.tenant_id = $1 AND qs.origin = 'template_generated' AND qs.seed_ref LIKE ANY($2::text[])
          AND ($3::text[] IS NULL OR p.slug = ANY($3::text[])) ORDER BY q.id`,
      [actor?.tenantId, (o.seedPrefixes ?? []).map(likeOf), o.packSlugs ?? null])).map((r) => r.id);
    },
    describeIds: async (ids) => {
      const rows = await q<{ slug: string; status: string; review_state: string | null; no_version: boolean; n: string }>(
        `SELECT p.slug, q.status, q.review_state, NOT EXISTS (SELECT 1 FROM question_versions v WHERE v.question_id = q.id) AS no_version, count(*)::text AS n
           FROM questions q JOIN question_packs p ON p.id = q.pack_id
          WHERE p.tenant_id = $1 AND q.id = ANY($2::uuid[]) GROUP BY 1, 2, 3, 4`, [actor?.tenantId, ids]);
      const others = await q<{ slug: string; n: string }>(
        `SELECT p.slug, count(*)::text AS n FROM questions q JOIN question_packs p ON p.id = q.pack_id
          WHERE p.tenant_id = $1 AND q.status = 'draft' AND NOT (q.id = ANY($2::uuid[]))
            AND p.id IN (SELECT q2.pack_id FROM questions q2 WHERE q2.id = ANY($2::uuid[])) GROUP BY 1`, [actor?.tenantId, ids]);
      const by = new Map<string, PackDescription>();
      const get = (slug: string): PackDescription => {
        let d = by.get(slug);
        if (d === undefined) { d = { slug, total: 0, byStatus: {}, byReviewState: {}, noVersion: 0, otherDraftsInPack: 0 }; by.set(slug, d); }
        return d;
      };
      for (const r of rows) {
        const d = get(r.slug); const n = Number(r.n);
        d.total += n; d.byStatus[r.status] = (d.byStatus[r.status] ?? 0) + n;
        const k = r.review_state ?? "null"; d.byReviewState[k] = (d.byReviewState[k] ?? 0) + n;
        if (r.no_version) d.noVersion += n;
      }
      for (const r of others) get(r.slug).otherDraftsInPack = Number(r.n);
      return [...by.values()];
    },
    verifyQuestionsByIds: review.verifyQuestionsByIds,
    activateQuestionsByIds: packs.activateQuestionsByIds,
    backfillMissingSnapshots: packs.backfillMissingSnapshots,
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
  };
  return { deps, close: closePool };
}

async function main(): Promise<number> {
  let close: (() => Promise<void>) | undefined;
  try {
    const args = parseArgs(process.argv.slice(2));
    const r = await realDeps();
    close = r.close;
    return await run(args, r.deps);
  } catch (e) {
    const code = (e as { details?: { code?: string } }).details?.code ?? "";
    const name = (e as { constructor?: { name?: string } }).constructor?.name ?? "";
    const msg = e instanceof Error ? e.message : String(e);
    if (msg !== "") process.stderr.write(`${msg}\n`);
    return e instanceof CliError ? e.exitCode : name === "ValidationError" || name === "NotFoundError" || code !== "" ? 3 : 5;
  } finally {
    await close?.().catch(() => undefined);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then((code) => process.exit(code));
}
