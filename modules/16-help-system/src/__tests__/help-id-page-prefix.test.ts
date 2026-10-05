// N20 / RV71 guard: an element help id must start with its page's helpPage id,
// otherwise the page-scoped loader (key LIKE '<page>.%') never returns its text.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isValidHelpKey } from "../service.js";

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

// FU-D4 (2026-10-06): the format gate a saved key must pass (enforced at
// write time in upsertHelpForTenant) — a key that fails this can never match
// any page prefix, so the editor (today: upsertHelpForTenant; tomorrow: FU-D2's
// UI) cannot create a hidden key.
describe("isValidHelpKey (the save-time gate)", () => {
  it("accepts a well-formed, dot-separated, lowercase key", () => {
    expect(isValidHelpKey("admin.tenant_settings.name")).toBe(true);
    expect(isValidHelpKey("admin.page")).toBe(true);
  });

  it("rejects a hyphenated segment (the N16 bug class)", () => {
    expect(isValidHelpKey("admin.tenant-settings.name")).toBe(false);
  });

  it("rejects a single segment with no page prefix at all", () => {
    expect(isValidHelpKey("orphan_key")).toBe(false);
  });

  it("rejects uppercase, empty segments, and whitespace", () => {
    expect(isValidHelpKey("Admin.foo")).toBe(false);
    expect(isValidHelpKey("admin..foo")).toBe(false);
    expect(isValidHelpKey("admin.foo bar")).toBe(false);
    expect(isValidHelpKey("")).toBe(false);
  });
});
