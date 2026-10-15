// lint-migrations (RW-40): static checks on modules/*/migrations/*.sql.
//   R1 duplicate basename across modules
//   R2 4-digit prefix (except the documented legacy 3-digit set)
//   R3 no forward reference to a table created by a LATER file in the real apply order
//   R4 file name matches ^\d{3,4}_[a-z0-9_]+\.sql$
//   R5 every modules/**/*.sql sits at modules/<n>/migrations/ or modules/<n>/seeds/ (else migrate.ts skips it silently)
// The real apply order comes from tools/test-support/apply-all-migrations.ts (allMigrationFiles).
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { finish, rel, walk, REPO_ROOT } from "./lint-util.js";
import { allMigrationFiles } from "./test-support/apply-all-migrations.js";

/** The nine legacy 3-digit migrations. See docs/02-data-model.md "Migration numbering facts (RV78)". */
export const LEGACY_3_DIGIT = new Set([
  "010_oauth_identities.sql",
  "011_sessions.sql",
  "012_totp.sql",
  "013_recovery_codes.sql",
  "014_embed_secrets.sql",
  "015_api_keys.sql",
  "016_super_admin.sql",
  "020_users.sql",
  "021_user_invitations.sql",
]);

/** R5 exemptions: repo-relative .sql paths allowed outside migrations/ and seeds/. None on the current tree. */
const R5_EXEMPT = new Set<string>([]);
const R5_OK = /^modules\/[^/]+\/(migrations|seeds)\/[^/]+\.sql$/;

/** R5: input is repo-relative forward-slash paths of every modules/**\/*.sql (node_modules already excluded). */
export function lintSqlLocations(paths: string[]): string[] {
  return paths
    .filter((p) => !R5_OK.test(p) && !R5_EXEMPT.has(p))
    .map((p) => `${p}: R5 .sql must be at modules/<n>/migrations/ or modules/<n>/seeds/ (tools/migrate.ts skips other locations)`);
}

const NAME_RE = /^\d{3,4}_[a-z0-9_]+\.sql$/;
const IDENT = String.raw`(?:public\.)?"?(\w+)"?`;
const CREATED_RES = [
  new RegExp(String.raw`\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}`, "gi"),
  new RegExp(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}`, "gi"),
];
const REF_RES = [
  new RegExp(String.raw`\bREFERENCES\s+${IDENT}`, "gi"),
  new RegExp(String.raw`\bFROM\s+${IDENT}`, "gi"),
  new RegExp(String.raw`\bJOIN\s+${IDENT}`, "gi"),
  new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${IDENT}`, "gi"),
  new RegExp(String.raw`\bINSERT\s+INTO\s+${IDENT}`, "gi"),
  new RegExp(String.raw`\bUPDATE\s+${IDENT}`, "gi"),
];
const CTE_RES = [/\bWITH\s+(?:RECURSIVE\s+)?(\w+)\s+AS\b/gi, /,\s*(\w+)\s+AS\s*\(/gi];

/** Remove comments, string literals and dollar-quoted bodies (keep DO-block bodies, comment/string-stripped). */
function strip(sql: string): string {
  const re = /'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\/|\$([A-Za-z_]*)\$([\s\S]*?)\$\1\$/g;
  return sql.replace(re, (m, tag: string | undefined, body: string | undefined, offset: number) => {
    if (tag === undefined) return " ";
    // ponytail: function bodies (AS $$..$$) are late-bound and value payloads are prose, so only DO bodies are kept
    return /\bDO\s+(?:LANGUAGE\s+\w+\s+)?$/i.test(sql.slice(0, offset)) ? ` ${strip(body ?? "")} ` : " ";
  });
}

function names(sql: string, res: RegExp[]): string[] {
  return res.flatMap((r) => [...sql.matchAll(r)].map((m) => m[1]!.toLowerCase()));
}

export function lintMigrations(files: { path: string; content: string }[], order: string[]): string[] {
  const v: string[] = [];
  const seen = new Map<string, string>();
  for (const f of files) {
    const b = path.basename(f.path);
    const prev = seen.get(b);
    if (prev !== undefined) v.push(`${f.path}: R1 duplicate basename ${b} (also ${prev})`);
    else seen.set(b, f.path);
    if (!NAME_RE.test(b)) v.push(`${f.path}: R4 file name must match ${NAME_RE}`);
    else if (b.split("_")[0]!.length !== 4 && !LEGACY_3_DIGIT.has(b)) {
      v.push(`${f.path}: R2 prefix must be 4 digits (legacy 3-digit set: docs/02-data-model.md RV78)`);
    }
  }

  const pos = new Map(order.map((p, i) => [p, i]));
  const cleaned = new Map(files.map((f) => [f.path, strip(f.content)]));
  const creator = new Map<string, number>(); // table -> earliest creating position
  for (const f of files) {
    const i = pos.get(f.path);
    if (i === undefined) continue;
    for (const t of names(cleaned.get(f.path)!, CREATED_RES)) {
      if (!creator.has(t) || i < creator.get(t)!) creator.set(t, i);
    }
  }
  for (const f of files) {
    const i = pos.get(f.path);
    if (i === undefined) continue;
    const sql = cleaned.get(f.path)!;
    const ctes = new Set(names(sql, CTE_RES));
    const reported = new Set<string>();
    for (const t of names(sql, REF_RES)) {
      const j = creator.get(t);
      if (j === undefined || j <= i || ctes.has(t) || reported.has(t)) continue;
      reported.add(t);
      v.push(`${f.path}: R3 forward reference to "${t}" created later by ${order[j]}`);
    }
  }
  return v;
}

async function main(): Promise<never> {
  if (process.argv.includes("--self-test")) {
    const good = ["modules/x/migrations/0001_a.sql", "modules/x/seeds/a.sql"];
    const bad = [...good, "modules/x/migrations/sub/0001_a.sql", "modules/x/src/0001_a.sql"];
    if (lintSqlLocations(good).length !== 0 || lintSqlLocations(bad).length !== 2) {
      console.error("lint-migrations self-test FAILED (R5)");
      process.exit(1);
    }
    console.log("lint-migrations self-test: OK");
    process.exit(0);
  }
  const abs = await allMigrationFiles();
  const files = abs.map((p) => ({ path: rel(p), content: fs.readFileSync(p, "utf8") }));
  const sql = walk(path.join(REPO_ROOT, "modules"), (f) => f.endsWith(".sql")).map(rel);
  const v = [...lintMigrations(files, files.map((f) => f.path)), ...lintSqlLocations(sql)];
  return finish("lint-migrations", v, `ok (${files.length} files)`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
