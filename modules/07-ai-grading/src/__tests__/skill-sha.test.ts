/**
 * Unit tests for ../skill-sha.ts
 *
 * Isolation: vi.mock("node:os") intercepts homedir() so the module reads from
 * a tmpdir we control — no real ~/.claude involvement.
 *
 * Cleanup: afterEach removes the tmpdir created by mkdtempSync.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Mock node:os BEFORE importing skill-sha so it picks up the mock homedir.
// ---------------------------------------------------------------------------

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    homedir: vi.fn(() => "/tmp/__skill_sha_test__"),
  };
});

// Now import the module under test (after the mock is registered).
import { skillSha } from "../skill-sha.js";
import { AI_GRADING_ERROR_CODES } from "../types.js";
import { AppError } from "@assessiq/core";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testHomeDir: string;

function setupSkillFile(skillName: string, content: string): void {
  const skillDir = join(testHomeDir, ".claude", "skills", skillName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), content, "utf8");
}

function sha256Of(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Create a fresh tmpdir for each test.
  testHomeDir = mkdtempSync(join(tmpdir(), "skill-sha-test-"));
  // Point the mock homedir() at this fresh dir.
  vi.mocked(homedir).mockReturnValue(testHomeDir);
});

afterEach(() => {
  rmSync(testHomeDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("skillSha", () => {
  it("skill file with frontmatter version + model → correct label/model/sha", async () => {
    const content = "---\nversion: v1\nmodel: claude-haiku-4-5\n---\n# Grade Anchors skill\n";
    setupSkillFile("grade-anchors", content);

    const result = await skillSha("grade-anchors");

    const expectedSha = sha256Of(content);
    expect(result.sha256).toBe(expectedSha);
    expect(result.short).toBe(expectedSha.slice(0, 8));
    expect(result.label).toBe("v1");
    expect(result.model).toBe("claude-haiku-4-5");
  });

  it("skill file without frontmatter → label='unversioned', model='unspecified'", async () => {
    const content = "# No frontmatter here\n\nJust the skill body.\n";
    setupSkillFile("grade-band", content);

    const result = await skillSha("grade-band");

    const expectedSha = sha256Of(content);
    expect(result.sha256).toBe(expectedSha);
    expect(result.short).toBe(expectedSha.slice(0, 8));
    expect(result.label).toBe("unversioned");
    expect(result.model).toBe("unspecified");
  });

  it("frontmatter with double-quoted values → quotes stripped", async () => {
    const content = '---\nversion: "v2"\nmodel: "claude-sonnet-4-6"\n---\n# Body\n';
    setupSkillFile("grade-escalate", content);

    const result = await skillSha("grade-escalate");

    expect(result.label).toBe("v2");
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  it("frontmatter with single-quoted values → quotes stripped", async () => {
    const content = "---\nversion: 'v3'\nmodel: 'claude-sonnet-4-6'\n---\n# Body\n";
    setupSkillFile("grade-escalate", content);

    const result = await skillSha("grade-escalate");

    expect(result.label).toBe("v3");
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  it("frontmatter with only version (no model key) → label set, model='unspecified'", async () => {
    const content = "---\nversion: v4\n---\n# No model in frontmatter\n";
    setupSkillFile("grade-anchors", content);

    const result = await skillSha("grade-anchors");

    expect(result.label).toBe("v4");
    expect(result.model).toBe("unspecified");
  });

  it("frontmatter with only model (no version key) → label='unversioned', model set", async () => {
    const content = "---\nmodel: claude-opus-4-7\n---\n# No version\n";
    setupSkillFile("grade-anchors", content);

    const result = await skillSha("grade-anchors");

    expect(result.label).toBe("unversioned");
    expect(result.model).toBe("claude-opus-4-7");
  });

  it("two SKILL.md files with same content produce same sha256", async () => {
    const content = "---\nversion: v1\nmodel: claude-haiku-4-5\n---\n# Identical\n";
    setupSkillFile("skill-alpha", content);
    setupSkillFile("skill-beta", content);

    const a = await skillSha("skill-alpha");
    const b = await skillSha("skill-beta");

    expect(a.sha256).toBe(b.sha256);
    expect(a.short).toBe(b.short);
  });

  it("one-byte difference in content produces different sha256", async () => {
    const contentA = "---\nversion: v1\n---\nContent A\n";
    const contentB = "---\nversion: v1\n---\nContent B\n";
    setupSkillFile("skill-diffA", contentA);
    setupSkillFile("skill-diffB", contentB);

    const a = await skillSha("skill-diffA");
    const b = await skillSha("skill-diffB");

    expect(a.sha256).not.toBe(b.sha256);
  });

  it("missing skill file → throws AppError with SKILL_NOT_FOUND, status 503", async () => {
    // Do not create the skill file — just call directly.
    let caught: unknown;
    try {
      await skillSha("grade-nonexistent");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppError);
    const appErr = caught as AppError;
    expect(appErr.code).toBe(AI_GRADING_ERROR_CODES.SKILL_NOT_FOUND);
    expect(appErr.status).toBe(503);
  });

  it("short is always exactly 8 hex characters", async () => {
    const content = "---\nversion: v1\n---\n# Short check\n";
    setupSkillFile("grade-anchors", content);

    const result = await skillSha("grade-anchors");

    expect(result.short).toMatch(/^[0-9a-f]{8}$/);
    expect(result.short).toBe(result.sha256.slice(0, 8));
  });
});
