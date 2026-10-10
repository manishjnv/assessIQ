/**
 * tools/lint-route-validation.ts  (RW-36b)
 *
 * Flags a mutating route handler (app.post / put / patch / delete) in apps/api/src/routes
 * whose request body is read (`req.body` / `request.body`) without validation: no Zod parse
 * (`.parse(` / `.safeParse(` / parseBody / tryParse / parseLifecycleBody /
 * parseSuperLifecycleBody) and no Fastify JSON `schema:` in the route options.
 *
 * WARN mode (default): prints file:line for each hit and exits 0.
 * `--strict` exits 1 on any hit (flip once the warn count is 0 and stays 0).
 *
 * Known limit: a body passed to a service that validates internally is still a hit here;
 * the route should parse first. Handlers that never read the body are not flagged.
 *
 * Usage: pnpm lint:route-validation | pnpm lint:route-validation:self-test
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_ROOT, walk, rel, isSource, lineOf, selfTest } from "./lint-util.js";

const ROUTES_DIR = path.join(REPO_ROOT, "apps/api/src/routes");
const REG = /\bapp\.(post|put|patch|delete)\s*\(/g;
const BODY_READ = /\b(?:req|request)\.body\b/g;
const VALIDATED = /\.(?:safeParse|parse)\(|\b(?:parseBody|tryParse|parseLifecycleBody|parseSuperLifecycleBody)\(|\bschema\s*:/;

/** Text of the balanced `( ... )` starting at `open`; skips strings and comments. */
function balanced(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); if (i < 0) break; continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i + 2); if (i < 0) break; i++; continue; }
    if (c === "'" || c === '"' || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

export function check(src: string, file: string): string[] {
  const hits: string[] = [];
  for (const m of src.matchAll(REG)) {
    const start = m.index! + m[0].length - 1;
    const call = balanced(src, start);
    const body = [...call.matchAll(BODY_READ)][0];
    if (body === undefined) continue;
    if (VALIDATED.test(call)) continue;
    hits.push(`${file}:${lineOf(src, start + body.index!)}  ${m[1]!.toUpperCase()} handler reads req.body without a schema parse`);
  }
  return hits;
}

if (process.argv.includes("--self-test")) {
  const good = `app.post('/x', { preHandler: a }, async (req) => { const b = parseBody(S, req.body); });\n` +
    `app.patch('/y', { schema: { body: s } }, async (req) => { const b = req.body; });\n` +
    `app.delete('/z', {}, async (req) => { return 1; });`;
  const bad = `app.post('/x', { preHandler: a }, async (req) => {\n  const b = req.body as {a: string};\n});`;
  selfTest("route-validation", (s) => check(s, "t.ts"), good, bad);
} else {
  const hits = walk(ROUTES_DIR, isSource).flatMap((f) => check(fs.readFileSync(f, "utf8"), rel(f)));
  for (const h of hits) console.warn(`  WARN ${h}`);
  console.log(`route-validation: ${hits.length} warning(s) (${process.argv.includes("--strict") ? "strict" : "warn mode, exit 0"})`);
  process.exit(hits.length > 0 && process.argv.includes("--strict") ? 1 : 0);
}
