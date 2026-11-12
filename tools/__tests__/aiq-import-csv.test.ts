// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CliError, commitRun, dryRun, parseArgs, type Args, type Deps } from "../aiq-import-csv.js";
import { validateRow } from "../../modules/04-question-bank/src/import/staging.js";

const HEAD = "type,topic,question,seed_ref";
const csv = (...rows: string[]): Buffer => Buffer.from([HEAD, ...rows].join("\n"), "utf8");
const ref = (n: number): string => `age.x@2:seed=${n}:gen=g1`;

const args = (over: Partial<Args> = {}): Args => ({
  tenant: "t1", packName: "P", domain: "aptitude", commit: false, publish: false, verifyAll: false, seedFrameworks: [], files: ["a.csv"], ...over,
});

/** Fake deps: preview marks a row as error when its topic cell is "BAD" (stand-in for the real validator). */
function fakes(files: Record<string, Buffer>, over: Partial<Deps> = {}): Deps & { calls: string[] } {
  const calls: string[] = [];
  const d: Deps = {
    readFile: async (p) => { const b = files[p]; if (!b) throw new Error("ENOENT"); return b; },
    resolveTenant: async (s) => (s === "t1" ? "tid" : null),
    resolveAdmin: async () => "admin",
    preview: async (_t, _m, parsed) => ({
      rows: parsed.rows.map((r) => ({
        row: r.row, decision: r.cells["topic"] === "BAD" ? "error" : "ok",
        errors: r.cells["topic"] === "BAD" ? [{ row: r.row, column: "topic", message: "bad topic" }] : [],
        dupScope: null,
      })),
    }),
    stage: async (_t, _u, meta, parsed) => {
      calls.push(`stage:${meta.fileName}:${meta.targetPackId ?? "new"}`);
      return {
        importId: "imp", status: "staged", counts: { total: parsed.rows.length, ok: parsed.rows.length, error: 0, duplicate: 0, skip: 0 },
        duplicateClasses: { exact: 0, normalised: 0, similar: 0 }, checksRun: [], rows: [],
      } as never;
    },
    commit: async () => { calls.push("commit"); return { packId: "pk", committed: 1 }; },
    discard: async () => { calls.push("discard"); },
    findPack: async () => (calls.includes("commit") ? "pk" : null),
    publish: async () => { calls.push("publish"); },
    resolveReviewer: async () => ({ userId: "rev", role: "super_admin" }),
    verifyPack: async (_t, packId, actor) => { calls.push(`verify:${packId}:${actor.userId}:${actor.role}`); return { verified: 1, skipped: 0 }; },
    listSeedCodes: async () => ["exam-structure", "cbse"],
    seedFramework: async (_u, code) => { calls.push(`seed:${code}`); return { frameworks: 1, nodesCreated: 2, nodesUpdated: 0, nodesUnchanged: 3 }; },
    err: () => undefined,
    ...over,
  };
  return Object.assign(d, { calls });
}

describe("parseArgs", () => {
  it("accepts the full usage", () => {
    expect(parseArgs(["--tenant", "t", "--pack-name", "N", "--commit", "--publish", "a.csv", "b.csv"]))
      .toEqual({ tenant: "t", packName: "N", domain: "aptitude", commit: true, publish: true, verifyAll: false, seedFrameworks: [], files: ["a.csv", "b.csv"] });
  });
  it("parses --seed-frameworks as a comma list", () => {
    expect(parseArgs(["--tenant", "t", "--pack-name", "N", "--seed-frameworks", "exam-structure, cbse", "a.csv"]).seedFrameworks)
      .toEqual(["exam-structure", "cbse"]);
  });
  it.each([
    [["--pack-name", "N", "a.csv"]],
    [["--tenant", "t", "a.csv"]],
    [["--tenant", "t", "--pack-name", "N"]],
    [["--tenant", "t", "--pack-name", "N", "--publish", "a.csv"]],
    [["--tenant", "t", "--pack-name", "N", "--verify-all", "a.csv"]],
    [["--tenant", "t", "--pack-name", "N", "--nope", "a.csv"]],
    [["--tenant"]],
  ])("rejects %j with exit 5", (argv) => {
    expect(() => parseArgs(argv)).toThrow(CliError);
    try { parseArgs(argv); } catch (e) { expect((e as CliError).exitCode).toBe(5); }
  });
});

describe("dryRun", () => {
  it("catches a bad row and exits 3 with the report shape", async () => {
    const d = fakes({ "a.csv": csv(`mcq,Ages,q1,${ref(1)}`, `mcq,BAD,q2,${ref(2)}`) });
    const { report, exitCode } = await dryRun(args(), d);
    expect(exitCode).toBe(3);
    expect(report.mode).toBe("dry-run");
    expect(report.rows).toBe(2);
    expect(report.row_errors).toEqual([{ file: "a.csv", row: 3, column: "topic", message: "bad topic" }]);
    expect(report.files[0]).toMatchObject({ file: "a.csv", rows: 2, ok: 1, errors: 1 });
    expect(Object.keys(report).sort()).toEqual(["duplicate_seed_refs", "files", "files_over_limits", "mode", "row_errors", "rows"]);
    expect(d.calls).toEqual([]); // nothing staged
  });

  it("rejects a public free range seed (seed % 1,000,000 >= 900,000) as a row error, exit 3", async () => {
    const { report, exitCode } = await dryRun(args(), fakes({ "a.csv": csv(`mcq,Ages,q1,${ref(2_900_000)}`, `mcq,Ages,q2,${ref(2_899_999)}`) }));
    expect(exitCode).toBe(3);
    expect(report.row_errors).toHaveLength(1);
    expect(report.row_errors[0]).toMatchObject({ file: "a.csv", row: 2, column: "seed_ref" });
    expect(report.row_errors[0]!.message).toContain("public free range");
  });

  it("commit refuses a public free range row before staging", async () => {
    const d = fakes({ "a.csv": csv(`mcq,Ages,q1,${ref(900_000)}`) });
    const { exitCode, report } = await commitRun(args({ commit: true }), d);
    expect(exitCode).toBe(3);
    expect(report.total.errors).toBe(1);
    expect(d.calls.some((c) => c.startsWith("stage"))).toBe(false);
  });

  it("exits 0 when every row is clean", async () => {
    const { exitCode, report } = await dryRun(args(), fakes({ "a.csv": csv(`mcq,Ages,q1,${ref(1)}`) }));
    expect(exitCode).toBe(0);
    expect(report.row_errors).toEqual([]);
  });

  it("reports a duplicate seed_ref inside a file and across files", async () => {
    const d = fakes({ "a.csv": csv(`mcq,A,q1,${ref(1)}`, `mcq,A,q2,${ref(1)}`), "b.csv": csv(`mcq,A,q3,${ref(1)}`) });
    const { report } = await dryRun(args({ files: ["a.csv", "b.csv"] }), d);
    expect(report.duplicate_seed_refs).toEqual([
      { seed_ref: ref(1), first: "a.csv:2", again: "a.csv:3" },
      { seed_ref: ref(1), first: "a.csv:2", again: "b.csv:2" },
    ]);
  });

  it("flags a file over the row limit (2,000) and exits 3", async () => {
    const rows = Array.from({ length: 2001 }, (_, i) => `mcq,A,q${i},${ref(i)}`);
    const { report, exitCode } = await dryRun(args(), fakes({ "a.csv": csv(...rows) }));
    expect(exitCode).toBe(3);
    expect(report.files_over_limits).toEqual([{ file: "a.csv", reason: "more than 2000 data rows" }]);
  });

  it("flags a file over 4 MB", async () => {
    const big = Buffer.alloc(4 * 1024 * 1024 + 1, "a");
    const { report, exitCode } = await dryRun(args(), fakes({ "a.csv": big }));
    expect(exitCode).toBe(3);
    expect(report.files_over_limits[0]!.file).toBe("a.csv");
  });

  it("exit 2 for a missing file, exit 1 for an unknown tenant", async () => {
    await expect(dryRun(args({ files: ["nope.csv"] }), fakes({}))).rejects.toMatchObject({ exitCode: 2 });
    await expect(dryRun(args({ tenant: "zz" }), fakes({ "a.csv": csv() }))).rejects.toMatchObject({ exitCode: 1 });
  });
});

describe("commitRun", () => {
  it("creates the pack with file 1, appends file 2 by name, publishes last", async () => {
    const d = fakes({ "a.csv": csv(`mcq,A,q1,${ref(1)}`), "b.csv": csv(`mcq,A,q2,${ref(2)}`) });
    const { report, exitCode } = await commitRun(args({ commit: true, publish: true, files: ["a.csv", "b.csv"] }), d);
    expect(exitCode).toBe(0);
    expect(d.calls).toEqual(["stage:a.csv:new", "commit", "stage:b.csv:pk", "commit", "publish"]);
    expect(report.total).toEqual({ inserted: 2, skipped_existing: 0, errors: 0 });
    expect(report.pack_id).toBe("pk");
    expect(report.published).toBe(true);
  });

  it("skips a file whose rows all exist (idempotent re-run) and discards the staged import", async () => {
    const d = fakes({ "a.csv": csv(`mcq,A,q1,${ref(1)}`) }, {
      findPack: async () => "pk",
      stage: async () => ({ importId: "imp", counts: { total: 1, ok: 0, error: 0, duplicate: 1, skip: 0 }, rows: [] }) as never,
    });
    const { report } = await commitRun(args({ commit: true }), d);
    expect(report.files[0]).toEqual({ file: "a.csv", inserted: 0, skipped_existing: 1, errors: 0 });
    expect(d.calls).toEqual(["discard"]);
  });

  it("does not commit a file with a bad row and exits 3", async () => {
    const d = fakes({ "a.csv": csv(`mcq,BAD,q1,${ref(1)}`) }, {
      stage: async () => ({ importId: "imp", counts: { total: 1, ok: 0, error: 1, duplicate: 0, skip: 0 }, rows: [{ errors: [{ row: 2, column: "topic", message: "bad" }] }] }) as never,
    });
    const { report, exitCode } = await commitRun(args({ commit: true }), d);
    expect(exitCode).toBe(3);
    expect(report.files[0]!.error_rows).toEqual([{ row: 2, column: "topic", message: "bad" }]);
    expect(d.calls).toEqual(["discard"]);
  });

  it("exit 3 and no other change when publish is refused", async () => {
    class ConflictError extends Error { details = { code: "PACK_NOT_DRAFT" }; }
    const d = fakes({ "a.csv": csv(`mcq,A,q1,${ref(1)}`) }, { publish: async () => { throw new ConflictError("must be draft"); } });
    await expect(commitRun(args({ commit: true, publish: true }), d)).rejects.toMatchObject({ exitCode: 3 });
  });

  it("dry run with --seed-frameworks seeds nothing and exits normally", async () => {
    const lines: string[] = [];
    const d = fakes({ "a.csv": csv(`mcq,Ages,q1,${ref(1)}`) }, { err: (l) => void lines.push(l) });
    const { exitCode } = await dryRun(args({ seedFrameworks: ["exam-structure"] }), d);
    expect(exitCode).toBe(0);
    expect(d.calls).toEqual([]);
    expect(lines.join("\n")).toContain("would load framework seeds exam-structure");
  });

  it("rejects an unknown seed code with exit 3 and the list, before any work", async () => {
    const d = fakes({ "a.csv": csv(`mcq,A,q1,${ref(1)}`) });
    const p = commitRun(args({ commit: true, seedFrameworks: ["nope"] }), d);
    await expect(p).rejects.toMatchObject({ exitCode: 3, message: expect.stringContaining("exam-structure, cbse") });
    expect(d.calls).toEqual([]);
  });

  it("seeds run before staging, counts are in the report", async () => {
    const d = fakes({ "a.csv": csv(`mcq,A,q1,${ref(1)}`) });
    const { report } = await commitRun(args({ commit: true, seedFrameworks: ["exam-structure", "cbse"] }), d);
    expect(d.calls).toEqual(["seed:exam-structure", "seed:cbse", "stage:a.csv:new", "commit"]);
    expect(report.seeded).toEqual([
      { code: "exam-structure", frameworks: 1, nodesCreated: 2, nodesUpdated: 0, nodesUnchanged: 3 },
      { code: "cbse", frameworks: 1, nodesCreated: 2, nodesUpdated: 0, nodesUnchanged: 3 },
    ]);
  });

  it("a seed failure exits 5 and stages nothing", async () => {
    const d = fakes({ "a.csv": csv(`mcq,A,q1,${ref(1)}`) }, { seedFramework: async () => { throw new Error("boom"); } });
    await expect(commitRun(args({ commit: true, seedFrameworks: ["cbse"] }), d)).rejects.toMatchObject({ exitCode: 5 });
    expect(d.calls).toEqual([]);
  });

  it("--verify-all runs bulkVerifyPack once after publish with the pack id and reviewer", async () => {
    const d = fakes({ "a.csv": csv(`mcq,A,q1,${ref(1)}`) });
    const { report, exitCode } = await commitRun(args({ commit: true, publish: true, verifyAll: true }), d);
    expect(exitCode).toBe(0);
    expect(d.calls).toEqual(["stage:a.csv:new", "commit", "publish", "verify:pk:rev:super_admin"]);
    expect(report.verified).toEqual({ pack_id: "pk", verified: 1, skipped: 0 });
  });

  it("--verify-all with 0 rows to verify is ok (idempotent re-run)", async () => {
    const d = fakes({ "a.csv": csv(`mcq,A,q1,${ref(1)}`) }, {
      findPack: async () => "pk",
      stage: async () => ({ importId: "imp", counts: { total: 1, ok: 0, error: 0, duplicate: 1, skip: 0 }, rows: [] }) as never,
      verifyPack: async () => ({ verified: 0, skipped: 1 }),
    });
    const { report, exitCode } = await commitRun(args({ commit: true, verifyAll: true }), d);
    expect(exitCode).toBe(0);
    expect(report.verified).toEqual({ pack_id: "pk", verified: 0, skipped: 1 });
  });

  it("--verify-all with no reviewer exits 1 before any write", async () => {
    const d = fakes({ "a.csv": csv(`mcq,A,q1,${ref(1)}`) }, { resolveReviewer: async () => null });
    await expect(commitRun(args({ commit: true, verifyAll: true }), d)).rejects.toMatchObject({ exitCode: 1 });
    expect(d.calls).toEqual([]);
  });

  it("exit 1 when the tenant has no active admin", async () => {
    const d = fakes({ "a.csv": csv() }, { resolveAdmin: async () => null });
    await expect(commitRun(args({ commit: true }), d)).rejects.toMatchObject({ exitCode: 1 });
  });
});

describe("dryRun with the real row validator (math column, R2)", () => {
  const MHEAD = "type,topic,points,level,question,options,correct,rationale,seed_ref,math";
  const mrow = (q: string, n: number, math: string): string =>
    [`mcq`, `Maths`, `1`, `1`, `"${q.replace(/"/g, '""')}"`, `"[""1"",""2"",""3"",""4""]"`, `2`, `r`, ref(n), math].join(",");
  const real = (): Deps => fakes({}, {
    readFile: async () => Buffer.from([MHEAD,
      mrow("Find \\(x\\) if \\(2x = 6\\).", 1, "true"),
      mrow("Find \\(\\frac{1}{\\) now", 2, "true"),
      mrow("Find \\(x\\) if \\(2x = 6\\).", 3, ""),
    ].join("\n"), "utf8"),
    preview: async (_t, _m, parsed) => ({
      rows: parsed.rows.map((r) => {
        const v = validateRow(r.row, r.cells);
        return { row: r.row, decision: v.errors.length > 0 ? "error" : "ok", errors: v.errors, dupScope: null };
      }),
    }),
  });

  it("passes a math=true row with TeX, fails malformed TeX and TeX without math=true", async () => {
    const { report, exitCode } = await dryRun(args(), real());
    expect(exitCode).toBe(3);
    expect(report.files[0]).toMatchObject({ rows: 3, ok: 1, errors: 2 });
    const cols = report.row_errors.map((e) => `${e.row}:${e.column}`).sort();
    expect(cols).toEqual(["3:math", "4:math"]);
    expect(report.row_errors.find((e) => e.row === 3)!.message).toMatch(/maths does not parse/);
    expect(report.row_errors.find((e) => e.row === 4)!.message).toBe("the text has LaTeX marks but math is not true");
  });
});

describe("dryRun with the real row validator (Hindi columns, EXP-9 A3)", () => {
  const HHEAD = "type,topic,points,level,question,options,correct,rationale,seed_ref,question_hi,options_hi,rationale_hi";
  const hrow = (n: number, optsHi: string): string =>
    [`mcq`, `T`, `1`, `1`, `Q?`, `"[""a"",""b"",""c"",""d""]"`, `2`, `r`, ref(n), `नमूना प्रश्न 1`, `"${optsHi.replace(/"/g, '""')}"`, ``].join(",");
  it("passes matching Hindi options and fails a count mismatch on options_hi", async () => {
    const deps = fakes({}, {
      readFile: async () => Buffer.from([HHEAD, hrow(1, '["क","ख","ग","घ"]'), hrow(2, '["क","ख"]')].join(String.fromCharCode(10)), "utf8"),
      preview: async (_t, _m, parsed) => ({
        rows: parsed.rows.map((r) => {
          const v = validateRow(r.row, r.cells);
          return { row: r.row, decision: v.errors.length > 0 ? "error" : "ok", errors: v.errors, dupScope: null };
        }),
      }),
    });
    const { report, exitCode } = await dryRun(args(), deps);
    expect(exitCode).toBe(3);
    expect(report.files[0]).toMatchObject({ rows: 2, ok: 1, errors: 1 });
    expect(report.row_errors.map((e) => `${e.row}:${e.column}`)).toEqual(["3:options_hi"]);
  });
});
