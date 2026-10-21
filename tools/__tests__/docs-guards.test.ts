// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const tools = join(__dirname, "..");
let root: string;
const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" });
const put = (p: string, s: string) => {
  mkdirSync(join(root, p, ".."), { recursive: true });
  writeFileSync(join(root, p), s);
};
// Run a tool in the temp repo; returns stdout and exit code.
const run = (script: string, ...args: string[]) => {
  const r = spawnSync("node", [join(tools, script), ...args], { cwd: root, encoding: "utf8" });
  return { out: r.stdout, code: r.status };
};
const commit = (msg = "init") => {
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", msg);
};

// Fixtures are built from parts so this file holds no real-looking host, IP or price.
const host = ["srv", "1234567", ".hstgr", ".cloud"].join("");
const ip = [8, 8, 8, 8].join(".");
const price = ["Rs", " 4", "99"].join("");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "docs-guards-"));
  git("init", "-q");
});

describe("check-docs-privacy", () => {
  it("flags host, public IP, amount and private path by rule name only", () => {
    put("docs/a.md", `host ${host}\nip ${ip}\ncost ${price}\n`);
    put("docs/private/x.md", "ok\n");
    put("docs/PRIVATE_y.md", "ok\n");
    commit();
    const { out, code } = run("check-docs-privacy.mjs");
    expect(code).toBe(1);
    expect(out).toContain("docs/a.md:1: host-name");
    expect(out).toContain("docs/a.md:2: public-ip");
    expect(out).toContain("docs/a.md:3: currency-amount");
    expect(out).toContain("docs/private/x.md:0: private-path");
    expect(out).toContain("docs/PRIVATE_y.md:0: private-path");
    expect(out).not.toContain(host);
    expect(out).not.toContain(ip);
  });

  it("passes clean text: private IP, SQL placeholder, mention of a PRIVATE_ name", () => {
    put("docs/a.md", "ip 192.168.1.5 and 10.0.0.1, see PRIVATE_notes in the list, sql $1 and $2\n");
    put("src/q.ts", "const q = 'values ($10, $11)'; const ip = '1.2.3.4';\n");
    commit();
    const { out, code } = run("check-docs-privacy.mjs");
    expect(code).toBe(0);
    expect(out).toContain("0 finding(s)");
  });

  it("allowlist skips CLAUDE.md; --warn exits 0 with findings; --staged scans added lines only", () => {
    put("CLAUDE.md", `host ${host}\n`);
    put("docs/old.md", `ip ${ip}\n`);
    commit();
    expect(run("check-docs-privacy.mjs").out).toContain("docs/old.md:1: public-ip");
    expect(run("check-docs-privacy.mjs").out).not.toContain("CLAUDE.md");
    expect(run("check-docs-privacy.mjs", "--warn").code).toBe(0);
    put("docs/new.md", `fine\ncost ${price}\n`);
    git("add", "-A");
    const s = run("check-docs-privacy.mjs", "--staged");
    expect(s.out).toContain("docs/new.md:2: currency-amount");
    expect(s.out).not.toContain("docs/old.md");
  });
});

describe("check-docs-links", () => {
  it("reports dead links with a moved hint and honours a baseline", () => {
    put("docs/a.md", "[ok](b.md#x) [web](https://example.com) [anchor](#t) [gone](old/c.md) [dead](nope.md)\n");
    put("docs/b.md", "# b\n");
    put("docs/new/c.md", "# c\n");
    put("docs/moves.json", JSON.stringify([{ from: "docs/old/c.md", to: "docs/new/c.md", date: "2026-10-21", reason: "t" }]));
    commit();
    const { out, code } = run("check-docs-links.mjs");
    expect(code).toBe(1);
    expect(out).toContain("docs/a.md:1: dead link old/c.md -> moved to docs/new/c.md");
    expect(out).toContain("docs/a.md:1: dead link nope.md");
    expect(out).not.toContain("b.md#x");
    put("base.txt", "docs/a.md|old/c.md\ndocs/a.md|nope.md\n");
    const b = run("check-docs-links.mjs", "--baseline", "base.txt");
    expect(b.code).toBe(0);
    expect(b.out).toContain("0 new");
  });
});

describe("lint-docs guards", () => {
  const lint = () => run("lint-docs.mjs").out;
  beforeEach(() => {
    put("README.md", "# r\n\n*Type: reference*\n");
  });

  it("warns on missing Status and Rows lines, not on README or archive", () => {
    put("docs/plans/p.md", "# p\n\nno header\n");
    put("docs/plans/README.md", "# idx\n");
    put("docs/plans/archive/o.md", "# o\n");
    put("docs/design/ok.md", "# d\n\n**Status:** approved\nRows: none\n");
    commit();
    const out = lint();
    expect(out).toContain("docs-guard: missing Status line in first 15 lines: docs/plans/p.md");
    expect(out).toContain("docs-guard: missing Rows line in first 15 lines: docs/plans/p.md");
    expect(out).not.toContain("plans/README.md");
    expect(out).not.toContain("archive/o.md");
    expect(out).not.toContain("design/ok.md");
  });

  it("warns when all Rows are closed but Status is still a draft", () => {
    put("docs/ROADMAP.md", "| ID (aliases) | a | b | c | Status |\n| - | - | - | - | - |\n| Z-1 | x | y | z | ✅ done |\n| Z-2 | x | y | z | open |\n");
    put("docs/design/closed.md", "# c\n\nStatus: draft\nRows: Z-1\n");
    put("docs/design/mixed.md", "# m\n\nStatus: draft\nRows: Z-1, Z-2\n");
    commit();
    const out = lint();
    expect(out).toContain("all Rows closed but Status still draft/proposal: docs/design/closed.md");
    expect(out).not.toContain("proposal: docs/design/mixed.md");
  });

  it("warns on a size cap and on a missing New-Doc line, and points to the existing file", () => {
    put("docs/SESSION_STATE.md", "x".repeat(150001));
    put("docs/plans/2026-10-01-a-change-record.md", "# a\n\nStatus: done\nRows: none\n");
    commit("seed");
    put("docs/plans/2026-10-02-b-change-record.md", "# b\n\nStatus: done\nRows: none\n");
    commit("add b");
    let out = lint();
    expect(out).toContain("file over 150000 bytes: docs/SESSION_STATE.md");
    expect(out).toContain("new doc without \"New-Doc: <reason>\" in HEAD commit message: docs/plans/2026-10-02-b-change-record.md");
    expect(out).toContain("extend docs/plans/2026-10-01-a-change-record.md instead");
    put("docs/plans/2026-10-03-c-other.md", "# c\n\nStatus: done\nRows: none\n");
    commit("add c\n\nNew-Doc: new topic");
    out = lint();
    expect(out).not.toContain("without \"New-Doc");
  });
});
