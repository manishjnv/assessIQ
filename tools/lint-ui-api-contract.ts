/**
 * tools/lint-ui-api-contract.ts  (RV74)
 *
 * Every API path the SPA calls must match a registered Fastify route + method.
 * Static scan (no DB / app boot):
 *   client: adminApi( api( call( fetch( in apps/web/src, modules/10-admin-dashboard/src,
 *           modules/11-candidate-ui/src. Method from `method: "X"` in the call args, else GET.
 *   server: <x>.get|post|put|patch|delete("/path") in apps/api/src and modules/<n>/src.
 * Params (`:id`, `${x}`) normalise to `:p`; query strings are dropped.
 * Calls whose path is a variable cannot be resolved statically and are skipped.
 * Known exceptions: tools/ui-api-contract.allowlist.txt, one `METHOD /path  # reason` per line.
 * A stale allowlist line (no longer needed) also fails.
 *
 * Usage: pnpm lint:ui-api-contract | pnpm lint:ui-api-contract:self-test
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_ROOT, walk, rel, isSource, lineOf, finish, selfTest } from "./lint-util.js";

const ALLOWLIST = path.join(REPO_ROOT, "tools", "ui-api-contract.allowlist.txt");
const WRAPPERS = "adminApi|api|call|fetch";

interface Route { method: string; path: string; where: string }

export function normalise(p: string): string {
  // `${x}` after a "/" is a path param; anywhere else (e.g. `${qs}`) it is a query suffix.
  let s = p.replace(/(\/?)\$\{[^}]*\}/g, (_m, sl: string) => (sl ? "/:p" : "")).replace(/\$\{.*$/, "").replace(/[?#].*$/, "");
  s = s.replace(/:[A-Za-z_]\w*/g, ":p").replace(/\/+/g, "/");
  if (s.length > 1) s = s.replace(/\/$/, "");
  return s;
}

export function extractServer(text: string, where: string): Route[] {
  const re = /\b\w+\.(get|post|put|patch|delete)(?:<[^()]{0,400}?>)?\(\s*(["'`])(\/[^"'`]*)\2/g;
  return [...text.matchAll(re)].map((m) => ({ method: m[1]!.toUpperCase(), path: normalise(m[3]!), where }));
}

/** Text of the argument list starting just after the opening paren at `i`. */
function args(text: string, i: number): string {
  let depth = 1, j = i;
  for (; j < text.length && depth > 0; j++) {
    const c = text[j]!;
    if (c === '"' || c === "'" || c === "`") {
      for (j++; j < text.length && text[j] !== c; j++) if (text[j] === "\\") j++;
    } else if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
  }
  return text.slice(i, j - 1);
}

export function extractClient(text: string, where: string): Route[] {
  const out: Route[] = [];
  const re = new RegExp(`(?<![.\\w])(${WRAPPERS})(?:<[^()]{0,200}?>)?\\(`, "g");
  for (const m of text.matchAll(re)) {
    const a = args(text, m.index! + m[0].length);
    const lit = /^\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/.exec(a);
    if (!lit) continue; // variable path (wrapper internals, logger): not resolvable statically
    let p = lit[2]!;
    const bareRoot = /base:\s*["']{2}/.test(a);
    // fetch(`${API_BASE}/x`) style: the base variable stands for /api
    p = p.replace(/^\$\{(?:API_BASE|DEFAULT_BASE|base)\}/, "/api");
    if (!p.startsWith("/") || /^\/api\$\{/.test(p)) continue; // wrapper internals: `${API_BASE}${path}`
    if (m[1] !== "fetch" && !bareRoot && !p.startsWith("/api/")) p = "/api" + p;
    const n = normalise(p);
    if (/^(\/api)?\/:p$/.test(n) || n === "/api") continue; // wrapper internals
    const mm = /method:\s*["'](\w+)["']/.exec(a);
    out.push({ method: (mm ? mm[1]! : "GET").toUpperCase(), path: n, where: `${where}:${lineOf(text, m.index!)}` });
  }
  return out;
}

const segMatch = (a: string, b: string): boolean => {
  const x = a.split("/"), y = b.split("/");
  return x.length === y.length && x.every((s, i) => s === y[i] || s === ":p" || y[i] === ":p");
};

export function check(client: Route[], server: Route[], allow: Map<string, string>): string[] {
  const v: string[] = [];
  const used = new Set<string>();
  for (const c of client) {
    if (server.some((s) => s.method === c.method && segMatch(s.path, c.path))) continue;
    const key = `${c.method} ${c.path}`;
    if (allow.has(key)) { used.add(key); continue; }
    v.push(`${c.where}: UI calls ${key} but no Fastify route matches (fix the route/UI, or allowlist with a reason)`);
  }
  for (const k of allow.keys()) if (!used.has(k)) v.push(`allowlist: "${k}" is no longer needed - remove the line`);
  return v;
}

function loadAllow(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of text.split("\n")) {
    const t = l.trim();
    if (!t || t.startsWith("#")) continue;
    const [spec, reason] = t.split(/\s+#\s*/);
    m.set(spec!.replace(/\s+/g, " "), reason ?? "");
  }
  return m;
}

if (process.argv.includes("--self-test")) {
  const srv = "app.post('/api/admin/things/:id/go', h); app.get<{ Params: X }>('/api/ok', h);";
  selfTest(
    "ui-api-contract",
    (cli) => check(extractClient(cli, "t"), extractServer(srv, "s"), new Map()),
    "adminApi(`/admin/things/${id}/go`, { method: 'POST' }); api('/ok?x=1');",
    "adminApi(`/admin/things/${id}/go`);", // wrong method: no matching route
  );
} else {
  const clientRoots = ["apps/web/src", "modules/10-admin-dashboard/src", "modules/11-candidate-ui/src"];
  const client = clientRoots
    .flatMap((r) => walk(path.join(REPO_ROOT, r), isSource))
    .flatMap((f) => extractClient(fs.readFileSync(f, "utf8"), rel(f)));
  const serverRoots = [
    path.join(REPO_ROOT, "apps/api/src"),
    ...fs.readdirSync(path.join(REPO_ROOT, "modules")).map((d) => path.join(REPO_ROOT, "modules", d, "src")),
  ];
  const server = serverRoots
    .flatMap((r) => walk(r, isSource))
    .flatMap((f) => extractServer(fs.readFileSync(f, "utf8"), rel(f)));
  const allow = fs.existsSync(ALLOWLIST) ? loadAllow(fs.readFileSync(ALLOWLIST, "utf8")) : new Map<string, string>();
  if (process.argv.includes("--list")) for (const c of client) console.log(c.method, c.path, c.where);
  finish("ui-api-contract", check(client, server, allow), `OK (${client.length} UI calls vs ${server.length} routes)`);
}
