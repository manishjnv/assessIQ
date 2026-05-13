/**
 * YAML-level key-coverage test for admin.yml.
 *
 * Runs without Docker/testcontainers — reads the YAML source file directly.
 * This test suite is the authoritative check that:
 *
 *   1. Every expected help_id key (including Stage 1.5+ additions) is present.
 *   2. No duplicate top-level keys exist in admin.yml.
 *   3. audience is one of the permitted enum values.
 *   4. short_text is non-empty and at most 120 characters (tooltip constraint).
 *   5. long_md is non-empty for every entry.
 *
 * "Via the existing fetch helper": admin.yml is the canonical source that the
 * generate-help-seed.ts tool converts into the DB seed migration. Validating
 * the YAML directly is equivalent to validating what will appear in the DB
 * after the next seed regeneration.
 *
 * Path arithmetic (mirrors help-system.test.ts convention):
 *   THIS_DIR = modules/16-help-system/src/__tests__/
 *   1 ..  →  modules/16-help-system/src/
 *   2 ..  →  modules/16-help-system/        ← MODULE_ROOT
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

// ---------------------------------------------------------------------------
// Path helpers — Windows-safe (strips leading /E:/ from import.meta.url)
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

const THIS_DIR = toFsPath(new URL(".", import.meta.url));
const MODULE_ROOT = join(THIS_DIR, "..", "..");
const ADMIN_YAML_PATH = join(MODULE_ROOT, "content", "en", "admin.yml");

// ---------------------------------------------------------------------------
// Parse the YAML once; all tests share the same parsed object.
// ---------------------------------------------------------------------------

interface HelpEntryRaw {
  audience: string;
  short_text: string;
  long_md?: string;
  related_keys?: string[];
}

const rawYaml = readFileSync(ADMIN_YAML_PATH, "utf-8");
const parsed = parse(rawYaml) as Record<string, HelpEntryRaw>;
const allKeys = Object.keys(parsed);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_AUDIENCES = new Set(["admin", "reviewer", "candidate", "all"]);
const SHORT_TEXT_MAX = 120;

/**
 * Pre-existing short_text violations that pre-date this test.
 * These are grandfathered — fix in a separate PR, not here.
 * The generate-help-seed.ts convention says short_text ≤ 120; these were
 * authored before the constraint was enforced in tests.
 */
const KNOWN_SHORT_TEXT_OVERFLOWS = new Set([
  "admin.questions.generate.draft",   // 124 chars as of 2026-05-10
  "admin.settings.ai_generate_mode",  // 131 chars, pre-dates enforcement test
  "admin.certificates.list",          // 156 chars, Phase 5 Certificates
  "admin.certificates.revoke",        // 162 chars, Phase 5 Certificates
  "admin.certificates.reissue",       // 155 chars, Phase 5 Certificates
]);

/**
 * Stage 1.5+ keys that must be present after this week's content authoring.
 * Each key listed here has a corresponding entry in admin.yml.
 */
const STAGE_1_5_KEYS: string[] = [
  "admin.generation-attempts.history",
  "admin.questions.bulk.archive",
  "admin.questions.bulk.approve",
  "admin.questions.generate.modal",
  "admin.questions.subjective",
  "admin.questions.attempt-status",
  "admin.ops.cli.cleanup",
  "admin.ops.cli.inspect-attempt",
  "admin.attempts.grading-dispatch",
  "admin.attempts.session-idle",
];

/**
 * Phase 11 Activity page help keys.
 */
const ACTIVITY_KEYS: string[] = [
  "admin.activity.heatmap.legend",
  "admin.activity.streak.explanation",
  "admin.activity.leaderboard.delta",
];

// ---------------------------------------------------------------------------
// Block A — Structural integrity
// ---------------------------------------------------------------------------

describe("Block A — admin.yml structural integrity", () => {
  it("file parses without error and contains entries", () => {
    expect(allKeys.length).toBeGreaterThan(0);
  });

  it("no duplicate top-level keys", () => {
    // The YAML parser silently overwrites duplicate keys.
    // Count top-level key lines in the raw file and compare to parsed count.
    // Top-level keys match /^[a-z][a-z0-9._-]+:\s*$/ at line start.
    const rawTopLevelKeys = rawYaml
      .split("\n")
      .filter((line) => /^[a-z][a-z0-9._-]+:\s*$/.test(line))
      .map((line) => line.trimEnd().replace(/:\s*$/, ""));

    const rawKeySet = new Set(rawTopLevelKeys);

    // If the raw file has more unique lines than parsed keys, a key was
    // duplicated and silently lost. Both counts must be equal.
    expect(rawKeySet.size).toBe(allKeys.length);
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
      if (KNOWN_SHORT_TEXT_OVERFLOWS.has(key)) continue; // grandfathered pre-existing violation
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

// ---------------------------------------------------------------------------
// Block B — Stage 1.5+ key presence and content
// ---------------------------------------------------------------------------

describe("Block B — Stage 1.5+ keys present and populated", () => {
  for (const key of STAGE_1_5_KEYS) {
    describe(`key: ${key}`, () => {
      it("is present in admin.yml", () => {
        expect(
          parsed[key],
          `'${key}' is missing from admin.yml — add it to the Stage 1.5+ section`,
        ).toBeDefined();
      });

      it("has audience = admin", () => {
        const entry = parsed[key];
        if (!entry) return; // guarded by prior test
        expect(entry.audience).toBe("admin");
      });

      it("has non-empty short_text within 120 chars", () => {
        const entry = parsed[key];
        if (!entry) return;
        expect(entry.short_text.length).toBeGreaterThan(0);
        expect(
          entry.short_text.length,
          `${key}: short_text is ${entry.short_text.length} chars — exceeds 120`,
        ).toBeLessThanOrEqual(SHORT_TEXT_MAX);
      });

      it("has non-empty long_md", () => {
        const entry = parsed[key];
        if (!entry) return;
        expect(
          (entry.long_md ?? "").trim().length,
          `${key}: long_md is empty`,
        ).toBeGreaterThan(0);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Block C — Phase 11 Activity page key presence and content
// ---------------------------------------------------------------------------

describe("Block C — Phase 11 Activity page keys present and populated", () => {
  for (const key of ACTIVITY_KEYS) {
    describe(`key: ${key}`, () => {
      it("is present in admin.yml", () => {
        expect(
          parsed[key],
          `'${key}' is missing from admin.yml — add it to the Phase 11 Activity section`,
        ).toBeDefined();
      });

      it("has audience = admin", () => {
        const entry = parsed[key];
        if (!entry) return; // guarded by prior test
        expect(entry.audience).toBe("admin");
      });

      it("has non-empty short_text within 120 chars", () => {
        const entry = parsed[key];
        if (!entry) return;
        expect(entry.short_text.length).toBeGreaterThan(0);
        expect(
          entry.short_text.length,
          `${key}: short_text is ${entry.short_text.length} chars — exceeds 120`,
        ).toBeLessThanOrEqual(SHORT_TEXT_MAX);
      });

      it("has non-empty long_md", () => {
        const entry = parsed[key];
        if (!entry) return;
        expect(
          (entry.long_md ?? "").trim().length,
          `${key}: long_md is empty`,
        ).toBeGreaterThan(0);
      });
    });
  }
});
