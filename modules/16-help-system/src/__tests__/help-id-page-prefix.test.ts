// N20 / RV71 guard: an element help id must start with its page's helpPage id,
// otherwise the page-scoped loader (key LIKE '<page>.%') never returns its text.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../..");
const DIRS = ["modules/10-admin-dashboard/src/pages", "apps/web/src/pages"];

// Real exceptions (none today; N23 renamed the 30 ids that were here): { file (basename), id, reason }.
const ALLOWLIST: { file: string; id: string; reason: string }[] = [
];

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsxFiles(join(dir, e.name)) : e.name.endsWith(".tsx") ? [join(dir, e.name)] : [],
  );
}

describe("help ids sit under their page prefix", () => {
  it("has no id outside its helpPage prefix", () => {
    const bad: string[] = [];
    for (const d of DIRS) {
      for (const f of tsxFiles(join(ROOT, d))) {
        const src = readFileSync(f, "utf8");
        const pages = new Set([...src.matchAll(/helpPage="([^"]+)"/g)].map((m) => m[1]));
        if (pages.size !== 1) continue;
        const [page] = [...pages];
        const ids = [...src.matchAll(/(?:data-help-id|helpId)(?:=\{?|["']?\s*:\s*)[`"']([^"'`$]*)/g)].map((m) => m[1]!);
        for (const id of ids) {
          if (id.startsWith(`${page}.`)) continue;
          if (ALLOWLIST.some((a) => f.endsWith(a.file) && a.id === id)) continue;
          bad.push(`${f.slice(ROOT.length + 1)}: ${id} (page ${page})`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
