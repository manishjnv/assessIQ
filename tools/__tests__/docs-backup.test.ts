// @vitest-environment node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const tools = join(__dirname, "..");
let root: string;
let dest: string;
const run = (...args: string[]) =>
  spawnSync("node", [join(tools, "docs-backup.mjs"), ...args], { encoding: "utf8", cwd: root, env: { ...process.env, VITEST: "" } });
const zips = () => readdirSync(dest).filter((f) => /^assessiq-docs-.*\.zip$/.test(f)).sort();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "docs-backup-root-"));
  dest = join(mkdtempSync(join(tmpdir(), "docs-backup-dest-")), "Backups");
  mkdirSync(join(root, "docs", "private"), { recursive: true });
  writeFileSync(join(root, "docs", "a.md"), "# A\n");
  writeFileSync(join(root, "docs", "private", "b.txt"), "private\n");
});

describe("docs-backup", () => {
  it("creates a zip in the dest folder and keeps only the newest N", () => {
    mkdirSync(dest, { recursive: true });
    for (let d = 1; d <= 7; d++) writeFileSync(join(dest, `assessiq-docs-2026-10-0${d}-0900.zip`), "old");
    writeFileSync(join(dest, "unrelated.txt"), "keep me");

    const r = run("--root", root, "--dest", dest, "--keep", "5");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/docs-backup: wrote .*assessiq-docs-\d{4}-\d{2}-\d{2}-\d{4}\.zip \(\d+\.\d{2} MB\)/);

    const left = zips();
    expect(left).toHaveLength(5);
    expect(left.some((f) => f.startsWith("assessiq-docs-2026-10-01") || f.startsWith("assessiq-docs-2026-10-02") || f.startsWith("assessiq-docs-2026-10-03"))).toBe(false);
    expect(left).toContain("assessiq-docs-2026-10-07-0900.zip");
    expect(existsSync(join(dest, "unrelated.txt"))).toBe(true);
  });

  it("prints skipped and exits 0 when there is no docs/ folder", () => {
    const empty = mkdtempSync(join(tmpdir(), "docs-backup-empty-"));
    const r = spawnSync("node", [join(tools, "docs-backup.mjs"), "--root", empty, "--dest", dest], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("docs-backup: skipped, no docs/ folder");
    expect(existsSync(dest)).toBe(false);
  });

  it("rejects --keep below 1", () => {
    const r = run("--root", root, "--dest", dest, "--keep", "0");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--keep must be a whole number of 1 or more");
  });
});
