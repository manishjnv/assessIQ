// @vitest-environment node
// EXP-15: exam-slice loader. Synthetic items only. No database: the pipeline calls are injected spies.
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error plain .mjs tool, no type declarations
import { applyDefaults, buildItems, parseFlags, pickSpotCheck, run, summarise, UsageError } from "../exam-slice/load.mjs";

const NOW = 1_800_000_000_000;
const flags = ["--file", "/x/slice.csv", "--domain", "soc", "--pack-name", "Slice", "--rights-status", "original", "--source-ref", "SYN-1"];
const opts = (extra: string[] = []) => parseFlags([...flags, ...extra]);

const csvRows = (n: number) => Array.from({ length: n }, (_, i) => ({
  row: i + 2,
  cells: { type: "mcq", question: `What is ${i} + 2?`, correct: "1", subtopic: i % 2 === 0 ? "even" : "odd" } as Record<string, string>,
}));

/** A preview result: every row ok, then the given overrides by row number. */
function previewOf(parsed: { rows: { row: number; cells: Record<string, string> }[] }, over: Record<number, Record<string, unknown>> = {}) {
  return {
    checksRun: ["exact", "normalised"],
    rows: parsed.rows.map((r) => ({ row: r.row, decision: "ok", dupClass: null, dupScope: null, errors: [], raw: r.cells, normalized: null, ...over[r.row] })),
  };
}

function deps(rowsIn: ReturnType<typeof csvRows>, over: Record<number, Record<string, unknown>> = {}, files: Record<string, string> = {}) {
  const written: Record<string, string> = { ...files };
  const d = {
    readFile: vi.fn(async (p: string) => { if (p in written) return written[p]; if (p === "/x/slice.csv") return Buffer.from("csv-bytes"); throw new Error("ENOENT"); }),
    writeFile: vi.fn(async (p: string, s: string) => { written[p] = s; }),
    now: () => NOW,
    stateDir: "/tmp",
    tenantId: "t-platform",
    parse: vi.fn(async () => ({ rows: rowsIn, errors: [] })),
    preview: vi.fn(async (_t: string, _m: unknown, parsed: never) => previewOf(parsed, over)),
    stage: vi.fn(async () => ({ importId: "imp-1" })),
    commit: vi.fn(async () => ({ importId: "imp-1", packId: "pack-1", committed: 3 })),
    resolveActor: vi.fn(async () => "actor-1"),
  };
  return { d, written };
}

describe("flags", () => {
  it("requires every flag and a known rights value", () => {
    expect(() => parseFlags(["--file", "a.csv"])).toThrow(UsageError);
    expect(() => opts(["--rights-status", "bogus"])).toThrow(/rights-status/);
    expect(() => opts(["--apply", "--dry-run"])).toThrow(/not both/);
    expect(opts().apply).toBe(false);
  });
});

describe("dry run", () => {
  it("writes nothing: no stage, no commit, no actor lookup; report and state file only", async () => {
    const { d, written } = deps(csvRows(3));
    const r = await run(opts(["--out", "/tmp/r.md"]), d);
    expect(d.stage).not.toHaveBeenCalled();
    expect(d.commit).not.toHaveBeenCalled();
    expect(d.resolveActor).not.toHaveBeenCalled();
    expect(d.preview).toHaveBeenCalledOnce();
    expect(r.code).toBe(0);
    expect(written["/tmp/r.md"]).toContain("| Rows | 3 |");
    expect(Object.keys(written).some((k) => k.includes("exam-slice-dryrun-"))).toBe(true);
  });

  it("fills blank rights and source ref from the flags and counts them", async () => {
    const { parsed, rightsFilled } = applyDefaults({ rows: csvRows(2), errors: [] }, opts());
    expect(parsed.rows[0]!.cells.rights_status).toBe("original");
    expect(parsed.rows[0]!.cells.source_ref).toBe("SYN-1");
    expect(rightsFilled.size).toBe(2);
  });

  it("does not record a pass when a row has an error", async () => {
    const { d, written } = deps(csvRows(2), { 2: { decision: "error", errors: [{ row: 2, column: "correct", message: "correct is required" }] } });
    const r = await run(opts(["--out", "/tmp/r.md"]), d);
    expect(r.code).toBe(1);
    expect(Object.keys(written).some((k) => k.includes("dryrun"))).toBe(false);
  });
});

describe("detection", () => {
  it("reports duplicates in the file, duplicates of existing questions and a missing answer key", () => {
    const rows = csvRows(4);
    rows[3]!.cells.correct = "";
    const prev = previewOf({ rows }, {
      3: { decision: "duplicate", dupClass: "exact", dupScope: "file" },
      4: { decision: "duplicate", dupClass: "normalised", dupScope: "existing" },
    });
    const { rightsFilled } = applyDefaults({ rows, errors: [] }, opts());
    const items = buildItems(prev.rows, rightsFilled, opts());
    const c = summarise(items);
    expect(c.duplicatesInFile).toBe(1);
    expect(c.duplicatesExisting).toBe(1);
    expect(c.missingKey).toBe(1);
    expect(items[3]!.keyPresent).toBe(false);
    expect(items[3]!.problems.join(" ")).toContain("answer key missing");
  });
});

describe("spot-check list", () => {
  const items = buildItems(
    previewOf({ rows: csvRows(60) }, { 7: { decision: "duplicate", dupClass: "exact", dupScope: "file" }, 30: { dupClass: "similar" } }).rows,
    new Set<number>(), opts(),
  );
  const hash = "ab12cd34".padEnd(64, "0");

  it("is deterministic and has 20 rows", () => {
    const a = pickSpotCheck(items, hash);
    expect(pickSpotCheck(items, hash)).toEqual(a);
    expect(a).toHaveLength(20);
    expect(pickSpotCheck(items, "ffffffff".padEnd(64, "0")).map((x: { row: number }) => x.row)).not.toEqual(a.map((x: { row: number }) => x.row));
  });

  it("includes every row with a warning", () => {
    const rows = pickSpotCheck(items, hash).map((x: { row: number }) => x.row);
    expect(rows).toContain(7);
    expect(rows).toContain(30);
  });

  it("takes at least 2 rows per subtopic", () => {
    const many = buildItems(previewOf({ rows: csvRows(100).map((r, i) => ({ ...r, cells: { ...r.cells, subtopic: i < 3 ? "rare" : `s${i % 5}` } })) }).rows, new Set<number>(), opts());
    const rows = new Set(pickSpotCheck(many, hash).map((x: { row: number }) => x.row));
    expect(many.filter((i: { subtopic: string; row: number }) => i.subtopic === "rare" && rows.has(i.row)).length).toBeGreaterThanOrEqual(2);
  });
});

describe("apply", () => {
  it("is refused without a passing dry run", async () => {
    const { d } = deps(csvRows(2));
    await expect(run(opts(["--apply"]), d)).rejects.toThrow(/dry run/);
    expect(d.stage).not.toHaveBeenCalled();
  });

  it("is refused when the dry run is older than one hour", async () => {
    const { d, written } = deps(csvRows(2));
    await run(opts(), d);
    d.now = () => NOW + 61 * 60 * 1000;
    await expect(run(opts(["--apply"]), d)).rejects.toThrow(/dry run/);
    expect(Object.keys(written).length).toBeGreaterThan(0);
  });

  it("is refused when a flag changed since the dry run", async () => {
    const { d } = deps(csvRows(2));
    await run(opts(), d);
    await expect(run(opts(["--apply", "--source-ref", "OTHER"]), d)).rejects.toThrow(/dry run/);
  });

  it("stages then commits after a passing dry run", async () => {
    const { d } = deps(csvRows(2));
    await run(opts(), d);
    const r = await run(opts(["--apply", "--out", "/tmp/a.md"]), d);
    expect(d.stage).toHaveBeenCalledOnce();
    expect(d.commit).toHaveBeenCalledWith("t-platform", "actor-1", "imp-1", { mode: "skip-errors" });
    expect(r.applied?.packId).toBe("pack-1");
  });
});
