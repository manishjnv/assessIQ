// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * RCA 2026-10-18: two copies of react-router in the built bundle give two separate
 * router contexts. The admin shell then calls useNavigate() outside the app's
 * <BrowserRouter>, React Router throws its invariant, and the admin page is blank after
 * login. The lockfile must resolve each router package to exactly one version.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Package entry names such as `  react-router@6.30.6:` in the `packages:` block of pnpm-lock.yaml. */
export function resolvedVersions(lock: string, pkg: string): string[] {
  const out = new Set<string>();
  const re = new RegExp(`^  '?${pkg.replace(/[/@.-]/g, "\\$&")}@([0-9][^:(']*)'?:`, "gm");
  for (const m of lock.matchAll(re)) out.add(m[1]!);
  return [...out].sort();
}

describe("one copy of the router packages", () => {
  const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8").replace(/\r\n/g, "\n");

  for (const pkg of ["react-router"]) {
    it(`${pkg} resolves to exactly one version`, () => {
      const v = resolvedVersions(lock, pkg);
      expect(v.length, `${pkg} versions in pnpm-lock.yaml: ${v.join(", ")}`).toBe(1);
    });
  }

  it("the helper sees two versions when the lockfile has two", () => {
    const fake = "packages:\n\n  react-router@6.30.3:\n    resolution: {}\n\n  react-router@6.30.6:\n    resolution: {}\n";
    expect(resolvedVersions(fake, "react-router")).toEqual(["6.30.3", "6.30.6"]);
  });
});
