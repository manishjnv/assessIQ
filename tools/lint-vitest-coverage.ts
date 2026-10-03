/**
 * tools/lint-vitest-coverage.ts  (RV71b)
 *
 * No test file may be silently never run. For every package dir under packages/, modules/,
 * apps/: each *.test.ts(x) / *.spec.ts(x) must be covered by EITHER the package's own
 * vitest.config.* (the package runs `vitest run` itself; CI runs `pnpm --filter ... test`)
 * OR the root vitest.config.ts include list (modules|packages/**\/__tests__/**\/*.test.ts).
 * The root include globs are read from vitest.config.ts, so a changed root config is honoured.
 *
 * Usage: pnpm lint:vitest-coverage | pnpm lint:vitest-coverage:self-test
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_ROOT, walk, rel, finish, selfTest } from "./lint-util.js";

/** Translate the simple globs used in the root config (** and *) to a RegExp. */
export function globToRe(g: string): RegExp {
  const s = g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, "(?:.*/)?");
  return new RegExp(`^${s}$`);
}

export function rootIncludes(cfg: string): RegExp[] {
  const inc = /include:\s*\[([^\]]*)\]/.exec(cfg);
  return inc ? [...inc[1]!.matchAll(/["']([^"']+)["']/g)].map((m) => globToRe(m[1]!)) : [];
}

/** pkgs: package dir (repo-relative) -> {hasConfig, tests (repo-relative)}. */
export function check(pkgs: Record<string, { hasConfig: boolean; tests: string[] }>, root: RegExp[]): string[] {
  const v: string[] = [];
  for (const [pkg, { hasConfig, tests }] of Object.entries(pkgs)) {
    if (hasConfig) continue;
    for (const t of tests) {
      if (!root.some((re) => re.test(t))) {
        v.push(`${t}: never run - ${pkg} has no vitest.config.* and the root vitest.config.ts include list does not match it`);
      }
    }
  }
  return v;
}

if (process.argv.includes("--self-test")) {
  const root = rootIncludes('include: ["modules/**/__tests__/**/*.test.ts"],');
  selfTest(
    "vitest-coverage",
    (t) => check({ "modules/x": { hasConfig: false, tests: t.split(",") } }, root),
    "modules/x/src/__tests__/a.test.ts,modules/x/src/__tests__/deep/b.test.ts",
    "modules/x/src/a.test.ts", // outside __tests__, no own config: never run
  );
} else {
  const cfg = fs.readFileSync(path.join(REPO_ROOT, "vitest.config.ts"), "utf8");
  const root = rootIncludes(cfg);
  const pkgs: Record<string, { hasConfig: boolean; tests: string[] }> = {};
  for (const group of ["packages", "modules", "apps"]) {
    const gdir = path.join(REPO_ROOT, group);
    if (!fs.existsSync(gdir)) continue;
    for (const d of fs.readdirSync(gdir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = path.join(gdir, d.name);
      const tests = walk(dir, (f) => /\.(test|spec)\.tsx?$/.test(f)).map(rel);
      if (tests.length === 0) continue;
      pkgs[`${group}/${d.name}`] = {
        hasConfig: fs.readdirSync(dir).some((f) => /^vitest\.(config|workspace)\./.test(f)),
        tests,
      };
    }
  }
  const n = Object.values(pkgs).reduce((a, p) => a + p.tests.length, 0);
  finish("vitest-coverage", check(pkgs, root), `OK (${n} test files in ${Object.keys(pkgs).length} packages)`);
}
