// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const tools = join(__dirname, "..");
let root: string;
const run = (script: string, ...args: string[]) =>
  execFileSync("node", [join(tools, script), ...args, "--root", root], { encoding: "utf8" });
const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" });
const put = (p: string, s: string) => {
  mkdirSync(join(root, p, ".."), { recursive: true });
  writeFileSync(join(root, p), s);
};
const get = (p: string) => readFileSync(join(root, p), "utf8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "docs-moves-"));
  git("init", "-q");
  put("docs/a.md", "# a\n");
  put("docs/old/x.md", "# x\n");
  put("docs/guide.md", "See `docs/a.md` and [a](a.md#top) and [x](old/x.md).\r\nline two docs/old/x.md.\r\n");
  put("CLAUDE.md", "read docs/a.md\n");
  git("add", "-A");
});

describe("docs move trail", () => {
  it("moves a file with git mv, records it, rewrites refs, keeps CRLF, lists CLAUDE.md", () => {
    const out = run("docs-move.mjs", "docs/a.md", "docs/design/a.md", "--reason", "tidy");
    expect(existsSync(join(root, "docs/design/a.md"))).toBe(true);
    expect(out).toContain("git mv docs/a.md");
    expect(git("ls-files")).not.toContain("docs/a.md");
    const moves = JSON.parse(get("docs/moves.json"));
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ from: "docs/a.md", to: "docs/design/a.md", reason: "tidy" });
    expect(get("docs/moves.json").endsWith("]\n")).toBe(true);
    const g = get("docs/guide.md");
    expect(g).toContain("`docs/design/a.md`");
    expect(g).toContain("[a](design/a.md#top)");
    expect(g).toContain("\r\n");
    expect(g.replace(/\r\n/g, "")).not.toContain("\n");
    expect(get("CLAUDE.md")).toBe("read docs/a.md\n");
    expect(out).toContain("CLAUDE.md needs approval: line 1: read docs/a.md");
  });

  it("moves a directory as one entry and rewrites prefix refs and links", () => {
    run("docs-move.mjs", "docs/old", "docs/new", "--reason", "rename");
    expect(JSON.parse(get("docs/moves.json"))[0]).toMatchObject({ from: "docs/old/", to: "docs/new/" });
    const g = get("docs/guide.md");
    expect(g).toContain("[x](new/x.md)");
    expect(g).toContain("docs/new/x.md.");
    expect(run("docs-where.mjs", "docs/old/x.md")).toContain("docs/old/x.md -> docs/new/x.md (moved");
  });

  it("re-points relative links inside the moved file", () => {
    const same = "see [a](../a.md#top) and [x](../old/x.md)\n";
    put("docs/design/d.md", same);
    git("add", "-A");
    run("docs-move.mjs", "docs/design/d.md", "docs/private/d.md", "--reason", "private");
    expect(get("docs/private/d.md")).toBe(same);
    run("docs-move.mjs", "docs/private/d.md", "docs/private/deep/d.md", "--reason", "deeper");
    expect(get("docs/private/deep/d.md")).toBe("see [a](../../a.md#top) and [x](../../old/x.md)\n");
  });

  it("follows chains and refuses an existing target", () => {
    run("docs-move.mjs", "docs/a.md", "docs/b.md", "--reason", "one");
    run("docs-move.mjs", "docs/b.md", "docs/c.md", "--reason", "two");
    expect(get("docs/guide.md")).toContain("`docs/c.md`");
    expect(run("docs-where.mjs", "docs/a.md")).toBe("docs/a.md -> docs/c.md (moved " + JSON.parse(get("docs/moves.json"))[1].date + ": two)\n");
    expect(() => run("docs-move.mjs", "docs/c.md", "docs/guide.md", "--reason", "x")).toThrow();
  });

  it("docs-where reports unknown paths and a missing arg", () => {
    expect(run("docs-where.mjs", "docs/zzz.md")).toBe("docs/zzz.md: never moved\n");
    try {
      execFileSync("node", [join(tools, "docs-where.mjs")], { stdio: "pipe" });
    } catch (e) {
      expect((e as { status: number }).status).toBe(2);
    }
  });
});
