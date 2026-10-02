// AssessIQ — eval gate (E2).
//
// Grading prompts are skill files on the VPS. A prompt edit is only "approved" once
// the eval harness has run against it and an admin blessed that run: bless writes
// eval/baselines/<date>.json carrying `skill_shas`. This module compares the shas of
// the skills on disk NOW with every blessed baseline.
//
//   AI_EVAL_GATE=off      no check
//   AI_EVAL_GATE=warn     (default) log grading.eval_gate.unapproved and continue
//   AI_EVAL_GATE=enforce  unapproved -> 409 AIG_EVAL_GATE before any AI spawn
//   anything else         treated as enforce (fail-closed) and logged
//
// Read-only: reads skill files + baseline JSON, never spawns anything (no AI here).

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AppError, streamLogger } from "@assessiq/core";
import { skillSha } from "./skill-sha.js";
import { AI_GRADING_ERROR_CODES } from "./types.js";

const log = streamLogger("grading");

export type EvalGateMode = "off" | "warn" | "enforce";

export interface SkillShas {
  anchors: string;
  band: string;
  escalate: string;
}

export interface EvalGateStatus {
  mode: EvalGateMode;
  approved: boolean;
  current: SkillShas;
  baseline_date: string | null;
}

const SKILLS = { anchors: "grade-anchors", band: "grade-band", escalate: "grade-escalate" } as const;
const KEYS = Object.keys(SKILLS) as Array<keyof SkillShas>;

/** Short sha (same 8-hex format as gradings.prompt_version_sha) for all three grading skills. */
export async function currentSkillShas(): Promise<SkillShas> {
  const out = {} as SkillShas;
  for (const k of KEYS) {
    try {
      out[k] = (await skillSha(SKILLS[k])).short;
    } catch {
      out[k] = "missing"; // never equals a blessed sha -> unapproved
    }
  }
  return out;
}

function resolveMode(): EvalGateMode {
  const raw = (process.env["AI_EVAL_GATE"] ?? "warn").trim().toLowerCase();
  if (raw === "off" || raw === "warn" || raw === "enforce") return raw;
  log.error({ value: raw }, "grading.eval_gate.invalid_mode_treated_as_enforce");
  return "enforce";
}

function baselinesDir(): string {
  return (
    process.env["AIQ_EVAL_BASELINES_DIR"] || // empty .env line = unset
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "eval", "baselines")
  );
}

/** Date key (file name sans .json) of the first baseline whose skill_shas equal `current`, else null. */
async function findApprovingBaseline(dir: string, current: SkillShas): Promise<string | null> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort().reverse();
  } catch {
    return null; // no baselines dir yet -> nothing approved
  }
  for (const f of files) {
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, f), "utf8")) as { skill_shas?: Partial<SkillShas> };
      const s = parsed.skill_shas;
      if (s === undefined || s === null || typeof s !== "object") continue; // pre-gate baseline
      if (KEYS.every((k) => s[k] === current[k])) return f.replace(/\.json$/, "");
    } catch (err) {
      log.warn({ file: f, err: String(err) }, "grading.eval_gate.baseline_unreadable");
    }
  }
  return null;
}

export async function getEvalGateStatus(): Promise<EvalGateStatus> {
  const mode = resolveMode();
  const current = await currentSkillShas();
  const baseline_date = await findApprovingBaseline(baselinesDir(), current);
  return { mode, approved: baseline_date !== null, current, baseline_date };
}

/** Call at the start of an AI grading entry point, before any spawn. */
export async function assertEvalGate(): Promise<void> {
  if (resolveMode() === "off") return;
  const status = await getEvalGateStatus();
  if (status.approved) return;
  if (status.mode === "warn") {
    log.warn({ current: status.current }, "grading.eval_gate.unapproved");
    return;
  }
  throw new AppError(
    "Grading prompts changed since the last passing eval. Run the eval on the server and bless it (modules/07-ai-grading/eval/README.md).",
    AI_GRADING_ERROR_CODES.EVAL_GATE,
    409,
    { details: { current: status.current } },
  );
}
