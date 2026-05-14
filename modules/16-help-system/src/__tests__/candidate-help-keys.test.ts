/**
 * YAML-level key-coverage test for candidate.yml (mirrors admin-help-keys.test.ts).
 *
 * Validates:
 *   1. File parses without error and contains entries.
 *   2. No duplicate top-level keys.
 *   3. All keys match the help_id format: [a-z0-9_] segments, dot-separated (no hyphens).
 *   4. audience is one of the permitted enum values.
 *   5. short_text is non-empty and at most 120 characters.
 *   6. long_md is non-empty for every entry.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

const THIS_DIR = toFsPath(new URL(".", import.meta.url));
const MODULE_ROOT = join(THIS_DIR, "..", "..");
const CANDIDATE_YAML_PATH = join(MODULE_ROOT, "content", "en", "candidate.yml");

interface HelpEntryRaw {
  audience: string;
  short_text: string;
  long_md?: string;
  related_keys?: string[];
}

const rawYaml = readFileSync(CANDIDATE_YAML_PATH, "utf-8");
const parsed = parse(rawYaml) as Record<string, HelpEntryRaw>;
const allKeys = Object.keys(parsed);

const VALID_AUDIENCES = new Set(["admin", "reviewer", "candidate", "all"]);
const SHORT_TEXT_MAX = 120;

describe("Block A — candidate.yml structural integrity", () => {
  it("file parses without error and contains entries", () => {
    expect(allKeys.length).toBeGreaterThan(0);
  });

  it("no duplicate top-level keys", () => {
    const rawTopLevelKeys = rawYaml
      .split("\n")
      .filter((line) => /^[a-z][a-z0-9._]+:\s*$/.test(line))
      .map((line) => line.trimEnd().replace(/:\s*$/, ""));
    const rawKeySet = new Set(rawTopLevelKeys);
    expect(rawKeySet.size).toBe(allKeys.length);
  });

  it("all keys match help_id format — segments [a-z0-9_], dot-separated, no hyphens", () => {
    const keyFormatRegex = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;
    for (const key of allKeys) {
      expect(
        keyFormatRegex.test(key),
        `'${key}' violates help_id format — segments must be [a-z0-9_], dot-separated`,
      ).toBe(true);
    }
  });

  it("all entries have a valid audience enum value", () => {
    for (const [key, entry] of Object.entries(parsed)) {
      expect(
        VALID_AUDIENCES.has(entry.audience),
        `${key}: audience '${entry.audience}' is not one of ${[...VALID_AUDIENCES].join(" | ")}`,
      ).toBe(true);
    }
  });

  it("all entries have a non-empty short_text within the 120-char limit", () => {
    for (const [key, entry] of Object.entries(parsed)) {
      expect(entry.short_text, `${key}: short_text is missing or empty`).toBeTruthy();
      expect(
        entry.short_text.length,
        `${key}: short_text is ${entry.short_text.length} chars — exceeds the 120-char tooltip limit`,
      ).toBeLessThanOrEqual(SHORT_TEXT_MAX);
    }
  });

  it("all entries have a non-empty long_md", () => {
    for (const [key, entry] of Object.entries(parsed)) {
      expect(
        (entry.long_md ?? "").trim().length > 0,
        `${key}: long_md is missing or empty`,
      ).toBe(true);
    }
  });
});
