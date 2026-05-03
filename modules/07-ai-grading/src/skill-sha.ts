// AssessIQ — Phase 1 skill-sha capture (D4).
//
// Reads ~/.claude/skills/<name>/SKILL.md, returns sha256 of its bytes plus
// the frontmatter `version:` and `model:` values. The full sha256 is used
// for the audit log; the first 8 hex chars embed in `prompt_version_sha`.
//
// Frontmatter parser is a minimal regex per session decision: a `yaml`
// package import would pull a few-hundred-KB dep into a hot path that only
// reads two well-defined keys. The regex tolerates leading BOM, CRLF/LF
// line endings, and either single- or double-quoted values.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { AppError } from "@assessiq/core";
import { AI_GRADING_ERROR_CODES } from "./types.js";

export interface ParsedSkill {
  /** Full sha256 of SKILL.md raw bytes (no normalisation). */
  sha256: string;
  /** First 8 hex chars — embedded in prompt_version_sha. */
  short: string;
  /** Frontmatter `version:` value, or "unversioned" if absent. */
  label: string;
  /** Frontmatter `model:` value, or "unspecified" if absent. */
  model: string;
}

/**
 * Frontmatter block at start of file: `---\n...\n---`.
 * Captures the body between the two `---` lines for key extraction.
 */
const FM_BLOCK_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---/;
const VERSION_RE = /^version:\s*(.+?)\s*$/m;
const MODEL_RE = /^model:\s*(.+?)\s*$/m;

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function skillPath(name: string): string {
  return path.join(homedir(), ".claude", "skills", name, "SKILL.md");
}

export async function skillSha(name: string): Promise<ParsedSkill> {
  const filePath = skillPath(name);
  let buf: Buffer;
  try {
    buf = await readFile(filePath);
  } catch (err) {
    throw new AppError(
      `skill not found at ${filePath}`,
      AI_GRADING_ERROR_CODES.SKILL_NOT_FOUND,
      503,
      {
        details: { skill: name, path: filePath },
        cause: err,
      },
    );
  }

  const sha256 = createHash("sha256").update(buf).digest("hex");
  const short = sha256.slice(0, 8);

  const text = buf.toString("utf8");
  const fmMatch = FM_BLOCK_RE.exec(text);
  let label = "unversioned";
  let model = "unspecified";
  if (fmMatch) {
    const block = fmMatch[1] ?? "";
    const versionMatch = VERSION_RE.exec(block);
    if (versionMatch) label = unquote(versionMatch[1] ?? "");
    const modelMatch = MODEL_RE.exec(block);
    if (modelMatch) model = unquote(modelMatch[1] ?? "");
  }

  return { sha256, short, label, model };
}
