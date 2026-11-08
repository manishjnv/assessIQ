/**
 * Read-only report: "is the large pool ever left unused?"
 *
 *   pnpm tsx tools/pool-usage-report.ts --pack <slug> [--draws 2000] [--sections-json <file>]
 *   pnpm tsx tools/pool-usage-report.ts --items-json <file> --sections-json <file> [--draws N]   (no DB)
 *
 * Reads active questions of one pack + published blueprint sections (SELECT only), simulates N draws per
 * blueprint with the app's own pure rule (passesSectionTypeAndDifficulty, one item per template key per
 * test, keyless unlimited, uniform shuffle) and prints counts. Output is counts only, never question text.
 * Console + docs/private/aptitude-generator/out/pool-usage-<pack>.json (gitignored).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { passesSectionTypeAndDifficulty } from "../packages/question-types/src/section-filter.js";

export interface PoolItem {
  id: string;
  node_ids: string[]; // subject node ids (own + ancestors)
  style_node_ids: string[]; // [] = neutral
  type: string;
  difficulty_est: number | null;
  template_key: string | null; // null = keyless, unlimited
}
export interface PoolSection {
  blueprint: string;
  name: string;
  subject_node_id: string | null;
  question_count: number;
  difficulty_min?: number;
  difficulty_max?: number;
  allowed_types?: string[];
  style_node_id?: string;
}
export interface SectionStat {
  blueprint: string;
  section: string;
  pool: number;
  touched: number;
  share: number;
  meanUses: number;
  maxUses: number;
  maxOverMean: number;
  distinctKeys: number;
}
export interface PoolAnalysis {
  sections: SectionStat[];
  unreachable: { total: number; bySubject: Record<string, number>; byDifficulty: Record<string, number>; byStyle: Record<string, number> };
  warnings: string[];
}

const LEVELS = [1, 3, 5];

export function analyzePool(items: PoolItem[], sections: PoolSection[], draws: number, rng: () => number): PoolAnalysis {
  const subj = (s: PoolSection) => (it: PoolItem) => s.subject_node_id === null || it.node_ids.includes(s.subject_node_id);
  const cand = sections.map((s) => {
    const inSubj = subj(s);
    const ix: number[] = [];
    items.forEach((it, i) => { if (inSubj(it) && passesSectionTypeAndDifficulty(s, it)) ix.push(i); });
    return ix;
  });
  const reachable = new Set(cand.flat());
  const warnings: string[] = [];
  const stats: SectionStat[] = [];

  const byBp = new Map<string, number[]>();
  sections.forEach((s, si) => byBp.set(s.blueprint, [...(byBp.get(s.blueprint) ?? []), si]));

  const uses = sections.map(() => new Map<number, number>());
  for (const sis of byBp.values()) {
    for (let d = 0; d < draws; d++) {
      const usedItem = new Set<number>();
      const usedKey = new Set<string>();
      for (const si of sis) {
        const pool = cand[si]!.slice();
        let need = sections[si]!.question_count;
        for (let i = pool.length - 1; i >= 0 && need > 0; i--) { // partial Fisher-Yates
          const j = Math.floor(rng() * (i + 1));
          const t = pool[j]!; pool[j] = pool[i]!; pool[i] = t;
          const it = items[t]!;
          if (usedItem.has(t) || (it.template_key !== null && usedKey.has(it.template_key))) continue;
          usedItem.add(t);
          if (it.template_key !== null) usedKey.add(it.template_key);
          uses[si]!.set(t, (uses[si]!.get(t) ?? 0) + 1);
          need--;
        }
      }
    }
  }

  sections.forEach((s, si) => {
    const u = uses[si]!;
    const total = [...u.values()].reduce((a, b) => a + b, 0);
    const pool = cand[si]!.length;
    const mean = pool === 0 ? 0 : total / pool;
    const max = Math.max(0, ...u.values());
    const keys = new Set<string>();
    let keyless = 0;
    for (const i of cand[si]!) { const k = items[i]!.template_key; if (k === null) keyless++; else keys.add(k); }
    const distinctKeys = keys.size + keyless;
    stats.push({
      blueprint: s.blueprint, section: s.name, pool, touched: u.size, share: pool === 0 ? 0 : u.size / pool,
      meanUses: mean, maxUses: max, maxOverMean: mean === 0 ? 0 : max / mean, distinctKeys,
    });
    if (pool < s.question_count) warnings.push(`${s.blueprint}/${s.name}: pool ${pool} is below question_count ${s.question_count}`);
    if (distinctKeys < 5 * s.question_count) warnings.push(`${s.blueprint}/${s.name}: ${distinctKeys} distinct template keys, below 5x question_count (${5 * s.question_count})`);
  });

  // Owner rule: per blueprint and subject, difficulty bands must cover levels 1, 3 and 5.
  for (const [bp, sis] of byBp) {
    const bySubject = new Map<string, number[]>();
    for (const si of sis) bySubject.set(sections[si]!.subject_node_id ?? "*", [...(bySubject.get(sections[si]!.subject_node_id ?? "*") ?? []), si]);
    for (const [sub, list] of bySubject) {
      const missing = LEVELS.filter((l) => !list.some((si) => {
        const s = sections[si]!;
        return (s.difficulty_min ?? -Infinity) <= l && l <= (s.difficulty_max ?? Infinity);
      }));
      if (missing.length) warnings.push(`${bp}/subject ${sub}: difficulty bands miss level(s) ${missing.join(",")}`);
    }
  }

  const un = { total: 0, bySubject: {} as Record<string, number>, byDifficulty: {} as Record<string, number>, byStyle: {} as Record<string, number> };
  const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
  items.forEach((it, i) => {
    if (reachable.has(i)) return;
    un.total++;
    for (const n of it.node_ids.length ? it.node_ids : ["(none)"]) bump(un.bySubject, n);
    bump(un.byDifficulty, String(it.difficulty_est));
    bump(un.byStyle, it.style_node_ids.length ? it.style_node_ids.join("+") : "neutral");
  });
  return { sections: stats, unreachable: un, warnings };
}

/** Small seeded PRNG (mulberry32) for repeatable runs. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function loadFromDb(pack: string): Promise<{ items: PoolItem[]; sections: PoolSection[] }> {
  const { default: pg } = await import("pg");
  const { styleNodeIdsOfSql, questionTemplateKeySql } = await import("../modules/04-question-bank/src/taxonomy-nodes.js");
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL not set");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL ROLE assessiq_system"); // as tools/audit-rubrics.ts: cross-tenant read, no writes
    const ids = `COALESCE((SELECT array_agg(qt.node_id) FROM question_taxonomy qt WHERE qt.question_id = q.id), '{}')`;
    const itemRows = await client.query(
      `WITH RECURSIVE anc AS (
         SELECT qt.question_id, n.id, n.parent_id FROM question_taxonomy qt JOIN taxonomy_nodes n ON n.id = qt.node_id
         JOIN questions q ON q.id = qt.question_id JOIN question_packs p ON p.id = q.pack_id WHERE p.slug = $1 AND q.status = 'active'
         UNION SELECT a.question_id, n.id, n.parent_id FROM anc a JOIN taxonomy_nodes n ON n.id = a.parent_id)
       SELECT q.id, q.type, q.difficulty_est,
              COALESCE((SELECT array_agg(DISTINCT a.id) FROM anc a WHERE a.question_id = q.id), '{}') AS node_ids,
              ${styleNodeIdsOfSql(ids)} AS style_node_ids,
              ${questionTemplateKeySql("q")} AS template_key
       FROM questions q JOIN question_packs p ON p.id = q.pack_id WHERE p.slug = $1 AND q.status = 'active'`, [pack]);
    // exam_blueprint_sections has no difficulty columns in the DB: bands come only from --sections-json.
    const secRows = await client.query(
      `SELECT b.name AS blueprint, b.style_node_id, s.name, s.subject_node_id, s.question_count, s.allowed_types
       FROM exam_blueprint_sections s JOIN exam_blueprints b ON b.id = s.blueprint_id
       WHERE b.archived_at IS NULL ORDER BY b.name, b.edition, s.position`);
    await client.query("ROLLBACK");
    const items: PoolItem[] = itemRows.rows.map((r) => ({
      id: r.id, node_ids: r.node_ids, style_node_ids: r.style_node_ids, type: r.type,
      difficulty_est: r.difficulty_est === null ? null : Number(r.difficulty_est), template_key: r.template_key,
    }));
    const sections: PoolSection[] = secRows.rows.map((r) => ({
      blueprint: r.blueprint, name: r.name, subject_node_id: r.subject_node_id, question_count: r.question_count,
      allowed_types: r.allowed_types ?? undefined, ...(r.style_node_id ? { style_node_id: r.style_node_id } : {}),
    }));
    return { items, sections };
  } finally {
    await client.end();
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const pack = arg("pack") ?? "dry-run";
  const draws = Number(arg("draws") ?? 2000);
  const itemsFile = arg("items-json");
  const sectionsFile = arg("sections-json");
  let items: PoolItem[];
  let sections: PoolSection[];
  if (itemsFile) {
    if (!sectionsFile) throw new Error("--items-json needs --sections-json");
    items = JSON.parse(fs.readFileSync(itemsFile, "utf8"));
    sections = JSON.parse(fs.readFileSync(sectionsFile, "utf8"));
  } else {
    if (!arg("pack")) throw new Error("usage: --pack <slug> [--draws N] [--sections-json f] | --items-json f --sections-json f");
    ({ items, sections } = await loadFromDb(pack));
    if (sectionsFile) sections = JSON.parse(fs.readFileSync(sectionsFile, "utf8"));
  }
  const res = analyzePool(items, sections, draws, Math.random);
  console.log(`pack=${pack} items=${items.length} sections=${sections.length} draws=${draws}`);
  console.table(res.sections.map((s) => ({
    blueprint: s.blueprint, section: s.section, pool: s.pool, touched: s.touched, share: s.share.toFixed(3),
    mean: s.meanUses.toFixed(2), max: s.maxUses, "max/mean": s.maxOverMean.toFixed(2), keys: s.distinctKeys,
  })));
  console.log(`unreachable: ${res.unreachable.total}`, res.unreachable);
  for (const w of res.warnings) console.log(`WARN ${w}`);
  const out = path.resolve(import.meta.dirname, "..", "docs", "private", "aptitude-generator", "out");
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `pool-usage-${pack}.json`);
  fs.writeFileSync(file, JSON.stringify({ pack, draws, items: items.length, ...res }, null, 2));
  console.log(`wrote ${file}`);
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("pool-usage-report.ts")) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(2); });
}
