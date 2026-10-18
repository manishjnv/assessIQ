// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve(__dirname, "../codex-review.sh");
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" });

function repoWith(line: string) {
  const d = mkdtempSync(join(tmpdir(), "codex-review-"));
  git(d, "init", "-q");
  git(d, "config", "user.email", "t@example.com");
  git(d, "config", "user.name", "t");
  git(d, "config", "commit.gpgsign", "false");
  writeFileSync(join(d, "a.txt"), "one\n");
  git(d, "add", "a.txt");
  git(d, "commit", "-q", "-m", "base");
  writeFileSync(join(d, "a.txt"), `one\n${line}\n`);
  git(d, "commit", "-q", "-am", "change");
  return d;
}
const run = (cwd: string, ...a: string[]) => spawnSync("bash", [script, ...a], { cwd, encoding: "utf8" });

describe("codex-review.sh (Z-69, dry-run only)", () => {
  it("clean diff: dry-run exits 0 and reports a clean scan", () => {
    const r = run(repoWith("hello world"), "HEAD~1", "--dry-run");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("secret scan: clean");
  });

  it("secret in an added line: exit 3, value never printed", () => {
    const key = "AKIA" + "ABCDEFGHIJKLMNOP";
    const r = run(repoWith(`const k = "${key}";`), "HEAD~1", "--dry-run");
    expect(r.status).toBe(3);
    expect(r.stdout + r.stderr).toContain("aws-akia");
    expect(r.stdout + r.stderr).not.toContain(key);
  });

  it("missing base: usage, exit 64", () => {
    expect(run(repoWith("x")).status).toBe(64);
  });
});
