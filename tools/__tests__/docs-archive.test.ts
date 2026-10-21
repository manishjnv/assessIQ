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

describe("docs-archive shrink, recount history, sections", () => {
  const longTitle = "Title **bold start and `code span that is long` and more words to pass one hundred characters easily so it must be cut here";
  const longStatus = "✅ (S9, 2026-10-16): a very long status text that goes on and on well past seventy characters in total";
  const bullets = [5, 4, 3, 2, 1].map((n) => `- S${n} recount update (x): note ${n}.`);
  bullets[0] = "- S5 recount update (x): Pending = 1 = 1. Closed = 2 = 2. Total = 3.";
  const rm2 = roadmap
    .replace(row("Z-1", "✅ done"), `| Z-1 | src | ${longTitle} | ctx | ${longStatus} | evidence | me |`)
    .replace("### Z.7 Counts\n\n| Z.2 | 3 |\n", `### Z.7 Counts\n\n| Z.2 | 3 |\n\n${bullets.join("\n")}\n\n### Z.7b Sheet\n\nsheet text\n\n### Z.8 Hygiene\n\nhygiene text\n`);
  const hist = () => get(`docs/archive/ROADMAP-history-${new Date().toISOString().slice(0, 7)}.md`);
  beforeEach(() => put("docs/ROADMAP.md", rm2));

  it("shrinks stub cells, keeps cell count, recount and closed status", async () => {
    const base = await recountOf();
    run();
    expect(await recountOf()).toBe(base);
    const l = get("docs/ROADMAP.md").split("\n").find((x) => x.startsWith("| Z-1 | "))!;
    const c = l.split(" | ");
    expect(c).toHaveLength(7);
    expect(c[2].length).toBeLessThanOrEqual(100);
    expect(c[2]).toMatch(/ …$/);
    expect((c[2].match(/`/g) ?? []).length % 2).toBe(0);
    expect((c[2].match(/\*\*/g) ?? []).length % 2).toBe(0);
    expect(c[4].length).toBeLessThanOrEqual(70);
    expect(c[4].startsWith("✅")).toBe(true);
    expect(get(`docs/archive/ROADMAP-closed-rows-${new Date().toISOString().slice(0, 7)}.md`)).toContain(longTitle);
  });

  it("keeps the newest 3 recount bullets and moves Z.7b and Z.8", () => {
    run();
    const r = get("docs/ROADMAP.md");
    expect(r).toContain("- S5 recount update");
    expect(r).toContain("- S3 recount update");
    expect(r).not.toContain("- S2 recount update");
    expect(r).toContain("- Older recount updates: docs/archive/ROADMAP-history-");
    expect(r).toContain("- Z.7b and Z.8: docs/archive/ROADMAP-history-");
    expect(r).not.toContain("sheet text");
    expect(r).toContain("### Z.9 Final list");
    const h = hist();
    expect(h).toContain("## Z.7 recount history (moved)");
    expect(h).toContain("- S2 recount update (x): note 2.");
    expect(h).toContain("- S1 recount update (x): note 1.");
    expect(h).toContain("### Z.7b Sheet\n\nsheet text");
    expect(h).toContain("### Z.8 Hygiene\n\nhygiene text");
    const pairs = JSON.parse(get("docs/moves.json")).map((e: { from: string; to: string }) => `${e.from}>${e.to}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("changes nothing on a second run", () => {
    run();
    const names = ["docs/ROADMAP.md", "docs/moves.json", "docs/SESSION_STATE.md"];
    const snap = [...names.map(get), hist()];
    run();
    expect([...names.map(get), hist()]).toEqual(snap);
  });
});

describe("docs-archive passes A (z7-history) and B (long-open-cells)", () => {
  const month = new Date().toISOString().slice(0, 7);
  const sent = "First sentence of the history. ".repeat(40);
  const long = `${sent}tail **bold \`code`;
  const r = (id: string, status: string, ctx: string) => `| ${id} | src | Title ${id} | ${ctx} | ${status} | evidence ${id} | me |`;
  const bullets = [
    "- S9 recount update (x): Pending = 1 = 1. Closed = 2 = 2. Total = 3.",
    "- S8 recount update (x): n8.",
    "- S7 recount update (x): n7.",
    "- S6 recount update (x): n6.",
    "- S3 (2026-10-17): narrative three.",
    "- Keep this plain note.",
  ];
  const rm3 = roadmap
    .replace(row("Z-2", "pending"), r("Z-2", "pending", long))
    .replace(row("Z-5", "waiting"), r("Z-5", "waiting", long))
    .replace(row("Z-9", "open"), r("Z-9", "open", long))
    .replace(row("Z-8", "✅ tail open"), r("Z-8", "✅ tail open", long))
    .replace("### Z.7 Counts\n\n| Z.2 | 3 |\n", `### Z.7 Counts\n\n| Z.2 | 3 |\n\n${bullets.join("\n")}\n`);
  const open = () => get(`docs/archive/ROADMAP-open-row-detail-${month}.md`);
  const hist = () => get(`docs/archive/ROADMAP-history-${month}.md`);
  beforeEach(() => put("docs/ROADMAP.md", rm3));

  it("cuts long cells of open Z.3/Z.6 rows only, keeps recount, Z.2 untouched", async () => {
    const base = await recountOf();
    run("--limit", "700");
    expect(await recountOf()).toBe(base);
    const r3 = get("docs/ROADMAP.md");
    const z5 = r3.split("\n").find((x) => x.startsWith("| Z-5 "))!;
    const c = z5.split(" | ");
    expect(c).toHaveLength(7);
    expect(c[3].length).toBeLessThanOrEqual(700);
    expect(c[3]).toMatch(/First sentence of the history\. … \[rest: docs\/archive\/ROADMAP-open-row-detail-\d{4}-\d{2}\.md § Z-5\]$/);
    expect(c[4]).toBe("waiting");
    expect(r3).toContain(r("Z-2", "pending", long)); // Z.2 untouched
    expect(r3.split("\n").find((x) => x.startsWith("| Z-8 "))).not.toContain("[rest:"); // closed row: stub only
    expect(r3.split("\n").find((x) => x.startsWith("| Z-9 "))).toContain("[rest:");
    expect(open()).toContain("### Z-5");
    expect(open()).toContain(`- cell 3 (Context): ${long}`);
  });

  it("moves old Z.7 bullets verbatim, keeps newest 3 recount updates", () => {
    run();
    const r3 = get("docs/ROADMAP.md");
    expect(r3).toContain("- S9 recount update");
    expect(r3).toContain("- S7 recount update");
    expect(r3).not.toContain("- S6 recount update");
    expect(r3).not.toContain("narrative three");
    expect(r3).toContain("- Keep this plain note.");
    expect(r3).toContain("- Older Z.7 notes: docs/archive/ROADMAP-history-");
    expect(hist()).toContain("## Z.7 history (moved, pass A)");
    expect(hist()).toContain("- S3 (2026-10-17): narrative three.");
  });

  it("is idempotent on a second run", () => {
    run();
    const names = ["docs/ROADMAP.md", "docs/moves.json"];
    const snap = [...names.map(get), open(), hist()];
    const out = run();
    expect([...names.map(get), open(), hist()]).toEqual(snap);
    expect(out).toContain("0 cell(s) cut");
    const pairs = JSON.parse(get("docs/moves.json")).map((e: { from: string; to: string }) => `${e.from}>${e.to}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });
});
