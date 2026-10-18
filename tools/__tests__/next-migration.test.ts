// @vitest-environment node
import { describe, expect, it } from "vitest";
import { highestMigration, nextFree, reservedFrom } from "../next-migration.mjs";

describe("next migration (Z-68)", () => {
  it("takes the highest 4-digit prefix and ignores 3-digit names", () => {
    expect(highestMigration(["0001_a.sql", "0205_b.sql", "0203_c.sql", "020_old.sql", "README.md"])).toBe(205);
    expect(highestMigration([])).toBe(0);
  });

  it("returns the next free numbers, skipping reserved ones", () => {
    expect(nextFree(205, [], 1)).toEqual(["0206"]);
    expect(nextFree(205, [], 3)).toEqual(["0206", "0207", "0208"]);
    const reserved = [{ number: 206, source: "docs/ROADMAP.md", line: 1 }];
    expect(nextFree(205, reserved, 2)).toEqual(["0207", "0208"]);
  });

  it("reads reservations, but not 'reserved and unused' or unrelated numbers", () => {
    const lines = [
      "Next free migration: 0206 (0206 and 0207 were reserved and unused).",
      "Migration 0210 reserved for the new module.",
      "Status documented as reserved (FU-C2) in 2026-10-01 notes.",
      "Tenant claimed 0211 and 0212 for the export job.",
      "Update docs/ROADMAP.md line 342 with 0206 at HEAD; numbers reserved in ROADMAP are listed here.",
    ];
    expect(reservedFrom(lines, "x").map((r) => [r.number, r.line])).toEqual([
      [210, 2],
      [211, 4],
      [212, 4],
    ]);
  });
});
