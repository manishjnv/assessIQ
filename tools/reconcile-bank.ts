/**
 * Read-only check: do the real question counts in the database match what the aptitude generator expects?
 *
 *   pnpm reconcile:bank --map practice=<slug>,secure=<slug> [--expected <stats.json>] [--status active|any] [--all-keys] [--json]
 *   pnpm reconcile:bank --map ... --actual-json <file>      (no DB; array of {pack,key,difficulty_est,status,count})
 *
 * Expected: docs/private/aptitude-generator/out/stats.json, key `packs` (counts per template key and level) and `rows`.
 * Actual: SELECT only, grouped by pack slug, template key (seed_ref before '@'), difficulty_est, status.
 * difficulty_est 1/3/5 = easy/medium/hard; any other value is its own bucket `other:<n>`.
 * Exit 0 = all match, 1 = any delta, 2 = usage or connection error. Counts only, never question text.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface ExpectedStats {
  packs: Record<string, { total: number; by_key_level: Record<string, Record<string, number>> }>;
  rows?: { template: string; category: string; subtopic: string; kind_names?: string[] }[];
}
export interface ActualRow { pack: string; key: string | null; difficulty_est: number | null; status: string; count: number }
export interface Opts { map: Record<string, string>; status?: "active" | "any"; allKeys?: boolean }
export interface Delta { pack: string; key: string; level: string; expected: number; actual: number; diff: number }
export interface PackTotal { expected: number; actual: number }
export interface Rollup { name: string; expected: number; actual: number }
export interface Result {
  deltas: Delta[];
  extras: { pack: string; key: string; actual: number }[];
  missing: { pack: string; key: string; expected: number }[];
  totals: Record<string, PackTotal>;
  bySubtopic: Rollup[];
  byCategory: Rollup[];
  deltaCount: number;
}

const LEVEL_OF: Record<number, string> = { 1: "easy", 3: "medium", 5: "hard" };
const levelName = (d: number | null): string => (d !== null && LEVEL_OF[d]) || `other:${d}`;
const sum = (xs: Iterable<number>): number => [...xs].reduce((a, b) => a + b, 0);

export function reconcile(expected: ExpectedStats, actual: ActualRow[], opts: Opts): Result {
  const status = opts.status ?? "active";
  const deltas: Delta[] = [];
  const extras: Result["extras"] = [];
  const missing: Result["missing"] = [];
  const totals: Result["totals"] = {};
  const subExp = new Map<string, number>(), subAct = new Map<string, number>();
  const catExp = new Map<string, number>(), catAct = new Map<string, number>();
  const rowOf = new Map((expected.rows ?? []).map((r) => [r.template, r]));
  const bump = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);
  const roll = (key: string, e: number, a: number) => {
    const r = rowOf.get(key.split(".")[0]!);
    const sub = r?.subtopic ?? "(unmapped)", cat = r?.category ?? "(unmapped)";
    bump(subExp, sub, e); bump(subAct, sub, a);
    bump(catExp, cat, e); bump(catAct, cat, a);
  };

  for (const [logical, slug] of Object.entries(opts.map)) {
    const exp = expected.packs[logical];
    if (!exp) continue;
    const act = new Map<string, Map<string, number>>(); // key -> level -> count
    let actTotal = 0;
    for (const r of actual) {
      if (r.pack !== slug || (status === "active" && r.status !== "active")) continue;
      if (r.key === null && !opts.allKeys) continue;
      const key = r.key ?? "(none)";
      const lv = act.get(key) ?? new Map<string, number>();
      const name = levelName(r.difficulty_est);
      lv.set(name, (lv.get(name) ?? 0) + r.count);
      act.set(key, lv);
      actTotal += r.count;
    }
    totals[logical] = { expected: exp.total, actual: actTotal };
    for (const [key, levels] of Object.entries(exp.by_key_level)) {
      const a = act.get(key);
      const eTotal = sum(Object.values(levels));
      if (!a) {
        if (eTotal > 0) missing.push({ pack: logical, key, expected: eTotal });
        roll(key, eTotal, 0);
        continue;
      }
      for (const lv of new Set([...Object.keys(levels), ...a.keys()])) {
        const e = levels[lv] ?? 0, n = a.get(lv) ?? 0;
        if (e !== n) deltas.push({ pack: logical, key, level: lv, expected: e, actual: n, diff: n - e });
      }
      roll(key, eTotal, sum(a.values()));
    }
    for (const [key, lv] of act) {
      if (key in exp.by_key_level) continue;
      extras.push({ pack: logical, key, actual: sum(lv.values()) });
      roll(key, 0, sum(lv.values()));
    }
    // stats.json total disagreeing with its own per-key sums is also drift worth failing on
    if (exp.total !== actTotal && !deltas.some((d) => d.pack === logical) && !extras.some((d) => d.pack === logical) && !missing.some((d) => d.pack === logical)) {
      deltas.push({ pack: logical, key: "(pack total)", level: "all", expected: exp.total, actual: actTotal, diff: actTotal - exp.total });
    }
  }
  const toRoll = (e: Map<string, number>, a: Map<string, number>): Rollup[] =>
    [...new Set([...e.keys(), ...a.keys()])].sort().map((name) => ({ name, expected: e.get(name) ?? 0, actual: a.get(name) ?? 0 }));
  return {
    deltas, extras, missing, totals,
    bySubtopic: toRoll(subExp, subAct), byCategory: toRoll(catExp, catAct),
    deltaCount: deltas.length + extras.length + missing.length,
  };
}

export function parseMap(s: string): Record<string, string> {
  const m: Record<string, string> = {};
  for (const part of s.split(",")) {
    const [k, v] = part.split("=");
    if (!k || !v) throw new Error(`bad --map entry '${part}' (use practice=<slug>,secure=<slug>)`);
    m[k.trim()] = v.trim();
  }
  return m;
}

async function loadFromDb(slugs: string[], status: "active" | "any"): Promise<ActualRow[]> {
  const { default: pg } = await import("pg");
  const { questionTemplateKeySql } = await import("../modules/04-question-bank/src/taxonomy-nodes.js");
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL not set");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL ROLE assessiq_system"); // as tools/pool-usage-report.ts: cross-tenant read, no writes
    const res = await client.query(
      `SELECT p.slug AS pack, ${questionTemplateKeySql("q")} AS key, q.difficulty_est, q.status, count(*)::int AS count
       FROM questions q JOIN question_packs p ON p.id = q.pack_id
       WHERE p.slug = ANY($1) ${status === "active" ? "AND q.status = 'active'" : ""}
       GROUP BY 1, 2, 3, 4`, [slugs]);
    await client.query("ROLLBACK");
    return res.rows.map((r) => ({
      pack: r.pack, key: r.key, difficulty_est: r.difficulty_est === null ? null : Number(r.difficulty_est), status: r.status, count: Number(r.count),
    }));
  } finally {
    await client.end();
  }
}

export function render(res: Result): string {
  const out: string[] = [];
  for (const [p, t] of Object.entries(res.totals)) out.push(`pack ${p}: expected ${t.expected}, actual ${t.actual}, diff ${t.actual - t.expected}`);
  if (res.deltas.length) {
    out.push("", "key / level deltas (pack key level expected actual diff):");
    for (const d of res.deltas) out.push(`  ${d.pack} ${d.key} ${d.level} ${d.expected} ${d.actual} ${d.diff > 0 ? "+" : ""}${d.diff}`);
  }
  if (res.extras.length) { out.push("", "extra keys (in DB, not expected):"); for (const e of res.extras) out.push(`  ${e.pack} ${e.key} actual ${e.actual}`); }
  if (res.missing.length) { out.push("", "missing keys (expected, absent in DB):"); for (const m of res.missing) out.push(`  ${m.pack} ${m.key} expected ${m.expected}`); }
  for (const [title, list] of [["sub-topic", res.bySubtopic], ["category", res.byCategory]] as const) {
    const bad = list.filter((r) => r.expected !== r.actual);
    out.push("", `${title} roll-up: ${list.length - bad.length}/${list.length} match`);
    for (const r of bad) out.push(`  ${r.name}: expected ${r.expected}, actual ${r.actual}, diff ${r.actual - r.expected}`);
  }
  out.push("", res.deltaCount === 0 ? "RECONCILE: OK" : `RECONCILE: ${res.deltaCount} delta(s)`);
  return out.join("\n");
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const mapArg = arg("map");
  if (!mapArg) throw new Error("usage: --map practice=<slug>,secure=<slug> [--expected f] [--status active|any] [--actual-json f] [--all-keys] [--json]");
  const map = parseMap(mapArg);
  const status = (arg("status") ?? "active") as "active" | "any";
  if (status !== "active" && status !== "any") throw new Error("--status must be active or any");
  const expFile = arg("expected") ?? path.resolve(import.meta.dirname, "..", "docs", "private", "aptitude-generator", "out", "stats.json");
  const expected: ExpectedStats = JSON.parse(fs.readFileSync(expFile, "utf8"));
  const actualFile = arg("actual-json");
  const actual: ActualRow[] = actualFile ? JSON.parse(fs.readFileSync(actualFile, "utf8")) : await loadFromDb(Object.values(map), status);
  const res = reconcile(expected, actual, { map, status, allKeys: flag("all-keys") });
  console.log(flag("json") ? JSON.stringify(res, null, 2) : render(res));
  process.exit(res.deltaCount === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("reconcile-bank.ts")) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(2); });
}
