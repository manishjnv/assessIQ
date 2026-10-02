/**
 * E2 — eval gate: off / warn / enforce (approved + unapproved) / malformed baseline
 * skipped / invalid mode -> enforce, against a temp baselines dir. skillSha is mocked
 * (no skill files needed); nothing here spawns AI.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const shas: Record<string, string> = {
  "grade-anchors": "aaaaaaaa",
  "grade-band": "bbbbbbbb",
  "grade-escalate": "cccccccc",
};
vi.mock("../skill-sha.js", () => ({
  skillSha: vi.fn(async (name: string) => ({ short: shas[name] })),
}));

import { AppError } from "@assessiq/core";
import { assertEvalGate, getEvalGateStatus } from "../eval-gate.js";

let dir: string;
const CURRENT = { anchors: "aaaaaaaa", band: "bbbbbbbb", escalate: "cccccccc" };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aiq-baselines-"));
  process.env["AIQ_EVAL_BASELINES_DIR"] = dir;
  delete process.env["AI_EVAL_GATE"];
});
afterEach(async () => {
  delete process.env["AIQ_EVAL_BASELINES_DIR"];
  delete process.env["AI_EVAL_GATE"];
  await rm(dir, { recursive: true, force: true });
});

const bless = (date: string, skill_shas?: unknown) =>
  writeFile(join(dir, `${date}.json`), JSON.stringify({ run_id: "r", ...(skill_shas ? { skill_shas } : {}) }));

describe("eval gate", () => {
  it("off: no-op even when unapproved", async () => {
    process.env["AI_EVAL_GATE"] = "off";
    await expect(assertEvalGate()).resolves.toBeUndefined();
  });

  it("warn (default): unapproved does not throw", async () => {
    const st = await getEvalGateStatus();
    expect(st).toMatchObject({ mode: "warn", approved: false, baseline_date: null, current: CURRENT });
    await expect(assertEvalGate()).resolves.toBeUndefined();
  });

  it("enforce + approved baseline passes and reports its date", async () => {
    process.env["AI_EVAL_GATE"] = "enforce";
    await bless("2026-10-01", CURRENT);
    await expect(assertEvalGate()).resolves.toBeUndefined();
    expect(await getEvalGateStatus()).toMatchObject({ mode: "enforce", approved: true, baseline_date: "2026-10-01" });
  });

  it("enforce + unapproved throws 409 AIG_EVAL_GATE with current shas", async () => {
    process.env["AI_EVAL_GATE"] = "enforce";
    await bless("2026-10-01", { ...CURRENT, band: "deadbeef" }); // one skill differs
    const err = await assertEvalGate().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("AIG_EVAL_GATE");
    expect((err as AppError).status).toBe(409);
    expect((err as AppError).details).toMatchObject({ current: CURRENT });
  });

  it("baselines without skill_shas are ignored; malformed files are skipped", async () => {
    process.env["AI_EVAL_GATE"] = "enforce";
    await bless("2026-09-01"); // pre-gate baseline
    await writeFile(join(dir, "2026-09-02.json"), "{not json");
    await expect(assertEvalGate()).rejects.toMatchObject({ code: "AIG_EVAL_GATE" });
    await bless("2026-09-03", CURRENT); // a good one next to the bad ones
    await expect(assertEvalGate()).resolves.toBeUndefined();
  });

  it("invalid mode is treated as enforce (fail-closed)", async () => {
    process.env["AI_EVAL_GATE"] = "maybe";
    expect((await getEvalGateStatus()).mode).toBe("enforce");
    await expect(assertEvalGate()).rejects.toMatchObject({ code: "AIG_EVAL_GATE" });
  });

  it("a missing baselines dir is unapproved, not an error", async () => {
    process.env["AIQ_EVAL_BASELINES_DIR"] = join(dir, "nope");
    expect((await getEvalGateStatus()).approved).toBe(false);
  });
});
