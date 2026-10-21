// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const script = join(__dirname, "..", "docs-archive.mjs");
let root: string;
const run = (...args: string[]) => execFileSync("node", [script, ...args, "--root", root], { encoding: "utf8", env: { ...process.env, VITEST: "" } });
const get = (p: string) => readFileSync(join(root, p), "utf8");
const put = (p: string, s: string) => {
  mkdirSync(join(root, p, ".."), { recursive: true });
  writeFileSync(join(root, p), s);
};

const blocks = [
  "2026-10-20", "2026-10-19", "2026-10-18", "2026-10-17", "2026-10-16", "2026-10-02", "2026-09-30", "2026-09-29",
].map((d, i) => `# Session — ${d} — S${8 - i}\n\n**Headline:** block ${8 - i}\n`);
const session = `Intro text\n\n${blocks.join("\n")}`;

const H = "| ID (aliases) | Source | Task | Context | Verified status | Evidence | Who |\n|---|---|---|---|---|---|---|";
const row = (id: string, status: string) => `| ${id} | src | Title ${id} | ctx ${id} | ${status} | evidence ${id} | me |`;
const table = (...rows: string[]) => `${H}\n${rows.join("\n")}\n`;
const roadmap = `# Roadmap

## P0-Z. List

### Z.1 Conflicts
text

### Z.2 Pending
${table(row("Z-1", "✅ done"), row("Z-2", "pending"), row("Z-3", "closed (S1)"), row("Z-4", "pointer to Z-1"))}
### Z.3 Owner
${table(row("Z-5", "waiting"))}
### Z.4 After pilot
${table(row("Z-6", "later"))}
### Z.5 Closed by verification
${table(row("Z-7", "verified"))}
### Z.6 Done rows with an open tail
${table(row("Z-8", "✅ tail open"), row("Z-9", "open"))}
### Z.7 Counts

| Z.2 | 3 |

### Z.9 Final list
1. do it

## Hardening S1

old text one

## Done sections

old text two
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "docs-archive-"));
  put("docs/SESSION_STATE.md", session);
  put("docs/ROADMAP.md", roadmap);
  put("docs/moves.json", "[]");
});

const recountOf = async () => {
  // @ts-expect-error plain .mjs without types
  const { buildReport, splitLines } = await import("../roadmap-recount.mjs");
  const r = buildReport(splitLines(get("docs/ROADMAP.md")));
  return JSON.stringify({ s: r.sections, t: r.totals });
};

describe("docs-archive", () => {
  it("keeps 5 blocks and archives older ones by month", () => {
    run();
    const s = get("docs/SESSION_STATE.md");
    expect(s.match(/^# Session/gm)).toHaveLength(5);
    expect(s).toContain("Intro text");
    expect(s.trim().endsWith("Older session blocks: docs/archive/sessions-*.md (see docs/moves.json).")).toBe(true);
    const oct = get("docs/archive/sessions-2026-10.md");
    expect(oct).toContain("# Archived session blocks — 2026-10");
    expect(oct).toContain("block 3");
    expect(get("docs/archive/sessions-2026-09.md")).toContain("block 1");
    expect(existsSync(join(root, "docs/archive/sessions-2026-08.md"))).toBe(false);
  });

  it("is idempotent", () => {
    run();
    const names = ["docs/SESSION_STATE.md", "docs/ROADMAP.md", "docs/moves.json", "docs/archive/sessions-2026-10.md"];
    const snap = names.map(get);
    const out = run();
    expect(names.map(get)).toEqual(snap);
    expect(out).toContain("0 session block(s), 0 closed row(s)");
  });

  it("stubs closed rows with the same cell count and keeps the recount", async () => {
    const base = await recountOf();
    run();
    expect(await recountOf()).toBe(base);
    const r = get("docs/ROADMAP.md");
    expect(r).toContain(`| Z-1 | archived | Title Z-1 | archived | ✅ done | full row: docs/archive/ROADMAP-closed-rows-`);
    expect(r).toContain(row("Z-2", "pending"));
    expect(r).toContain(row("Z-4", "pointer to Z-1"));
    expect(r).toContain("| ID (aliases) |");
    for (const l of r.split("\n").filter((x) => /^\| Z-\d /.test(x))) expect(l.split(" | ")).toHaveLength(7);
    const closed = get(`docs/archive/ROADMAP-closed-rows-${new Date().toISOString().slice(0, 7)}.md`);
    expect(closed).toContain(row("Z-1", "✅ done"));
    expect(closed).toContain(row("Z-7", "verified"));
    expect(closed).not.toContain("Z-2 |");
  });

  it("moves the old tail and leaves a pointer section", () => {
    run();
    const r = get("docs/ROADMAP.md");
    expect(r).not.toContain("old text one");
    expect(r).toContain("## Older sections (archived)\n\n- Hardening S1\n- Done sections\n");
    expect(r).toContain("### Z.9 Final list");
    const hist = get(`docs/archive/ROADMAP-history-${new Date().toISOString().slice(0, 7)}.md`);
    expect(hist).toContain("old text one");
    expect(hist).toContain("old text two");
  });

  it("keeps CRLF", () => {
    put("docs/SESSION_STATE.md", session.replace(/\n/g, "\r\n"));
    put("docs/ROADMAP.md", roadmap.replace(/\n/g, "\r\n"));
    run();
    for (const p of ["docs/SESSION_STATE.md", "docs/ROADMAP.md", "docs/archive/sessions-2026-10.md"]) {
      const t = get(p);
      expect(t).toContain("\r\n");
      expect(t.replace(/\r\n/g, "")).not.toContain("\n");
    }
  });

  it("records extract entries once per target", () => {
    run();
    run();
    const mv = JSON.parse(get("docs/moves.json"));
    expect(mv.every((e: { extract: boolean }) => e.extract === true)).toBe(true);
    const pairs = mv.map((e: { from: string; to: string }) => `${e.from}>${e.to}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(pairs).toContain("docs/SESSION_STATE.md>docs/archive/sessions-2026-10.md");
    expect(mv).toHaveLength(4);
  });

  it("writes nothing with --dry-run", () => {
    const out = run("--dry-run");
    expect(out).toContain("[dry-run]");
    expect(get("docs/SESSION_STATE.md")).toBe(session);
    expect(get("docs/ROADMAP.md")).toBe(roadmap);
    expect(get("docs/moves.json")).toBe("[]");
    expect(existsSync(join(root, "docs/archive"))).toBe(false);
  });
});
