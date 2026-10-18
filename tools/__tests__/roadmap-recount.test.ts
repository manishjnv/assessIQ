// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildReport, countSection, parseZ7, sectionRows, splitLines } from "../roadmap-recount.mjs";

// Small fixture with the same table shape as docs/ROADMAP.md P0-Z.
const FIXTURE = [
  "### Z.2 Pending — Claude can do",
  "| ID (aliases) | Source | Task (original text) | Context / history | Verified status | Evidence | Who |",
  "|---|---|---|---|---|---|---|",
  "| Z-1 | s | t | c | ✅ (S14): done | e | Claude |",
  "| Z-2 | s | t | c | pending | e | Claude |",
  "### Z.3 Pending — needs the owner first",
  "| ID (aliases) | Source | Task (original text) | Context / history | Verified status | Evidence | Who |",
  "|---|---|---|---|---|---|---|",
  "| Z-3 | s | t | c | pending (owner) | e | Owner |",
  "### Z.4 After pilot (100%) rows",
  "| ID (aliases) | Source | Task (original text) | Context / history | Verified status | Evidence | Who |",
  "|---|---|---|---|---|---|---|",
  "| Z-4 | s | t | c | **✅ done** | e | Claude |",
  "### Z.5 Closed by verification",
  "| ID (aliases) | Source | Task (original text) | Context / history | Verified status | Evidence | Who |",
  "|---|---|---|---|---|---|---|",
  "| A | s | t | c | done: x | e | Who |",
  "| B | s | t | c | pointer row | e | Who |",
  "### Z.6 Done rows with an open tail",
  "| ID (aliases) | Source | Task (original text) | Context / history | Verified status | Evidence | Who |",
  "|---|---|---|---|---|---|---|",
  "| Z-5 | s | t | c | closed (S24) | e | Claude |",
  "| RW-1 tail | s | t | c | merged into row RW-1 (Z.2) | e | Claude |",
  "### Z.7 Counts",
  "| Sub-section | Rows |",
  "|---|---|",
  "| Z.2 Pending | 2 (fixture) |",
  "| Z.3 Pending | 1 (fixture) |",
  "| Z.4 After pilot | 1 (fixture) |",
  "| Z.5 Closed | 1 (fixture) |",
  "| Z.6 New pending | 1 rows |",
  "- S9 close recount (2026-10-18), by the status column: Pending = 1 + 1 + 0 + 0 + 1 = 3. Closed = 1 + 1 + 1 = 3. Total = 6.",
].join("\n");

describe("roadmap recount (Z-68)", () => {
  const lines = splitLines(FIXTURE);

  it("counts rows per section by the status column", () => {
    const counted = Object.fromEntries(
      ["Z.2", "Z.3", "Z.4", "Z.5", "Z.6"].map((n) => {
        const c = countSection(n, sectionRows(lines, n));
        return [n, [c.rows, c.closed, c.open, c.pointers]];
      }),
    );
    expect(counted).toEqual({
      "Z.2": [2, 1, 1, 0], // Z-1 closed by check mark, Z-2 pending
      "Z.3": [1, 0, 1, 0],
      "Z.4": [1, 1, 0, 0], // bold check mark still counts
      "Z.5": [1, 1, 0, 1], // all closed; pointer row skipped
      "Z.6": [1, 0, 1, 1], // "closed (S24)" has no check mark, so pending; pointer skipped
    });
  });

  it("reports no differences when the fixture Z.7 numbers match", () => {
    const report = buildReport(lines);
    expect(report.totals).toEqual({ pending: 3, closed: 3, total: 6, doneSharePct: 50 });
    expect(report.differences).toEqual([]);
    expect(report.same).toBe(true);
  });

  it("flags a difference when the Z.7 table is stale", () => {
    const stale = FIXTURE.replace("| Z.6 New pending | 1 rows |", "| Z.6 New pending | 2 rows |");
    const report = buildReport(splitLines(stale));
    expect(report.same).toBe(false);
    expect(report.differences).toEqual([{ what: "Z.6 rows (Z.7 table)", script: 1, z7: 2 }]);
  });

  it("reads the newest recount line from Z.7", () => {
    expect(parseZ7(lines).recount).toEqual({ label: "S9 close recount (2026-10-18)", pending: 3, closed: 3, total: 6 });
  });
});
