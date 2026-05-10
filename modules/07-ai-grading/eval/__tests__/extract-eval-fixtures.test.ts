/**
 * Unit tests for the eval-fixture extraction tooling.
 *
 * Covers two contracts:
 *
 * A) checkFixtureFreshness (pure function in cli-typed.ts):
 *    The freshness guard that score-candidate runs at startup.
 *    - Fresh fixture: no diff → stale=false.
 *    - Fixture with extra ID not in KB → stale=true, appears in inFixNotKb.
 *    - KB with extra ID not in fixture → stale=true, appears in inKbNotFix.
 *    - Both sides differ simultaneously → both arrays populated.
 *
 * B) computeFixtureContent (exported from tools/extract-eval-fixtures.ts):
 *    Determinism: calling the function twice for the same level returns
 *    byte-for-byte identical content.  If the KB files are present on disk
 *    (they always are in the repo), the content string also matches the
 *    committed fixture file — i.e. the fixtures are up-to-date.
 *
 * No DB, no Docker, no DATABASE_URL required.  No mocks needed for B because
 * it reads the real KB files on disk — exactly what the CI freshness-check
 * step does.
 */

import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { checkFixtureFreshness } from "../cli-typed.js";
import { computeFixtureContent } from "../../../../tools/extract-eval-fixtures.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Fixture directory (same as in extract-eval-fixtures.ts)
const FIXTURE_DIR = join(__dirname, "..", "fixtures");

// ---------------------------------------------------------------------------
// A. checkFixtureFreshness — pure function, no I/O
// ---------------------------------------------------------------------------

describe("checkFixtureFreshness", () => {
  it("returns stale=false when fixture IDs exactly match KB IDs", () => {
    const ids = ["nist.ir.triage", "mitre.t1566", "win.event.4625"];
    const result = checkFixtureFreshness("L1", ids, ids);
    expect(result.stale).toBe(false);
    expect(result.inKbNotFix).toHaveLength(0);
    expect(result.inFixNotKb).toHaveLength(0);
  });

  it("returns stale=true when fixture has an extra ID not in KB", () => {
    const kbIds = ["nist.ir.triage", "mitre.t1566"];
    const fixtureIds = ["nist.ir.triage", "mitre.t1566", "test.fake.id"];
    const result = checkFixtureFreshness("L1", fixtureIds, kbIds);
    expect(result.stale).toBe(true);
    expect(result.inFixNotKb).toContain("test.fake.id");
    expect(result.inKbNotFix).toHaveLength(0);
  });

  it("returns stale=true when KB has an extra ID not in fixture", () => {
    const fixtureIds = ["nist.ir.triage", "mitre.t1566"];
    const kbIds = ["nist.ir.triage", "mitre.t1566", "new.kb.entry"];
    const result = checkFixtureFreshness("L2", fixtureIds, kbIds);
    expect(result.stale).toBe(true);
    expect(result.inKbNotFix).toContain("new.kb.entry");
    expect(result.inFixNotKb).toHaveLength(0);
  });

  it("captures diffs in both directions when sets diverge on both sides", () => {
    const fixtureIds = ["shared.id", "only.in.fixture"];
    const kbIds = ["shared.id", "only.in.kb"];
    const result = checkFixtureFreshness("L3", fixtureIds, kbIds);
    expect(result.stale).toBe(true);
    expect(result.inFixNotKb).toContain("only.in.fixture");
    expect(result.inKbNotFix).toContain("only.in.kb");
  });

  it("returns stale=false for empty-vs-empty (edge case)", () => {
    const result = checkFixtureFreshness("L1", [], []);
    expect(result.stale).toBe(false);
  });

  it("handles duplicate IDs in either list gracefully (set semantics)", () => {
    // Duplicates within a list do not make it appear as a diff
    const ids = ["nist.ir.triage", "nist.ir.triage"];
    const kbIds = ["nist.ir.triage"];
    const result = checkFixtureFreshness("L1", ids, kbIds);
    expect(result.stale).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B. computeFixtureContent — determinism and fixture alignment
// ---------------------------------------------------------------------------

describe("computeFixtureContent", () => {
  it("returns identical content on two consecutive calls (determinism)", async () => {
    for (const level of ["L1", "L2", "L3"] as const) {
      const run1 = await computeFixtureContent(level);
      const run2 = await computeFixtureContent(level);
      expect(run1.content).toBe(run2.content);
    }
  });

  it("returns valid JSON that parses to an array with id fields", async () => {
    for (const level of ["L1", "L2", "L3"] as const) {
      const { content, count } = await computeFixtureContent(level);
      const parsed = JSON.parse(content) as unknown;
      expect(Array.isArray(parsed)).toBe(true);
      const arr = parsed as Array<{ id?: unknown }>;
      expect(arr.length).toBe(count);
      for (const entry of arr) {
        expect(typeof entry.id).toBe("string");
      }
    }
  });

  it("returns count > 0 for every level (KB is non-empty)", async () => {
    for (const level of ["L1", "L2", "L3"] as const) {
      const { count } = await computeFixtureContent(level);
      expect(count).toBeGreaterThan(0);
    }
  });

  it("produces content matching committed fixture files (zero diff)", async () => {
    // This is the key idempotency gate: after a124812 regenerated the
    // fixtures to match the runtime KB, running extract-eval-fixtures.ts
    // again must produce zero diff.  If this test fails, someone edited
    // soc-l*.json without re-running --apply.
    for (const level of ["L1", "L2", "L3"] as const) {
      const { content } = await computeFixtureContent(level);
      const fixturePath = join(FIXTURE_DIR, `${level}-sources.json`);
      let committed: string;
      try {
        committed = await readFile(fixturePath, "utf8");
      } catch {
        // If fixture file is missing (shouldn't happen in repo), skip this sub-check
        continue;
      }
      expect(content).toBe(committed);
    }
  });
});
