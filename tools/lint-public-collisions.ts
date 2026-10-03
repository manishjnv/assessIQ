/**
 * tools/lint-public-collisions.ts  (RV71d)
 *
 * A file or folder in a public/ dir is served at its own URL and can shadow an app route.
 *   apps/web/public       vs the SPA route table (Route path="..." in apps/web/src/App.tsx)
 *   apps/marketing/public vs the Astro pages (apps/marketing/src/pages/**; index -> folder URL,
 *                         [param] / [...rest] -> wildcard)
 * Collision = a public file URL (also with .html dropped) equals a route, or a public folder URL
 * equals / is a prefix of a route.
 *
 * Usage: pnpm lint:public-collisions | pnpm lint:public-collisions:self-test
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_ROOT, walk, finish, selfTest } from "./lint-util.js";

/** routes: URL patterns ("/a/:p", "/a/*"); publicFiles: URL paths of files under public/. */
export function check(routes: string[], publicFiles: string[], label: string): string[] {
  const v: string[] = [];
  const dirs = new Set<string>();
  for (const f of publicFiles) {
    const parts = f.split("/");
    for (let i = 2; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const eq = (route: string, url: string): boolean => {
    const r = route.split("/"), u = url.split("/");
    if (r.includes("*")) return u.length >= r.indexOf("*") && r.slice(0, r.indexOf("*")).every((s, i) => s === u[i] || s === ":p");
    return r.length === u.length && r.every((s, i) => s === u[i] || s === ":p");
  };
  const prefix = (route: string, dir: string): boolean => {
    const r = route.split("/").map((s) => (s === "*" ? s : s)), d = dir.split("/");
    return d.every((s, i) => r[i] === s || r[i] === ":p" || r[i] === "*");
  };
  for (const f of publicFiles) {
    const urls = [f, f.replace(/\.html$/, "")];
    const hit = routes.find((r) => urls.some((u) => eq(r, u)));
    if (hit) v.push(`${label}: public file ${f} shadows route ${hit}`);
  }
  for (const d of dirs) {
    const hit = routes.find((r) => prefix(r, d));
    if (hit) v.push(`${label}: public folder ${d}/ collides with route ${hit}`);
  }
  return v;
}

const pubUrls = (dir: string): string[] =>
  walk(dir).map((f) => "/" + path.relative(dir, f).replace(/\\/g, "/"));

export function spaRoutes(appTsx: string): string[] {
  // Route paths: absolute ones stand alone; relative children are joined to the nearest parent.
  const abs = [...appTsx.matchAll(/path=["'](\/[^"']*)["']/g)].map((m) => m[1]!);
  return abs.filter((p) => p !== "*").map((p) => p.replace(/:[A-Za-z_]\w*/g, ":p").replace(/\/$/, "") || "/");
}

export function astroRoutes(pageFiles: string[]): string[] {
  return pageFiles.map((f) => {
    let p = "/" + f.replace(/\.(astro|ts|md|mdx)$/, "").replace(/(^|\/)index$/, "");
    p = p.replace(/\[\.\.\.[^\]]+\]/g, "*").replace(/\[[^\]]+\]/g, ":p");
    return p.replace(/\/$/, "") || "/";
  });
}

if (process.argv.includes("--self-test")) {
  selfTest(
    "public-collisions",
    (t) => check(["/about", "/take/:p", "/og/*"], t.split(","), "t"),
    "/brand/a.png,/robots.txt",
    "/about.html,/take/x.png", // shadows /about and the /take route folder
  );
} else {
  const app = fs.readFileSync(path.join(REPO_ROOT, "apps/web/src/App.tsx"), "utf8");
  const pagesDir = path.join(REPO_ROOT, "apps/marketing/src/pages");
  const pages = walk(pagesDir).map((f) => path.relative(pagesDir, f).replace(/\\/g, "/"));
  const web = pubUrls(path.join(REPO_ROOT, "apps/web/public"));
  const mkt = pubUrls(path.join(REPO_ROOT, "apps/marketing/public"));
  const v = [
    ...check(spaRoutes(app), web, "apps/web/public"),
    ...check(astroRoutes(pages), mkt, "apps/marketing/public"),
  ];
  finish("public-collisions", v, `OK (${web.length} web + ${mkt.length} marketing public files checked)`);
}
