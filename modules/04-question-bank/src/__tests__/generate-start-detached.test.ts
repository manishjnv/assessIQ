// RW-93 — detached run: error marks the attempt failed; lock rejection surfaces as 409.
import { describe, it, expect, vi } from "vitest";
import { AppError } from "@assessiq/core";
import { startGenerateDetached, type DetachedDeps } from "../service/generation-async.js";

const args = { tenantId: "t", userId: "u", packId: "p", levelId: "l", count: 2 };
const deps = (over: Partial<DetachedDeps>): DetachedDeps => ({
  run: async () => ({ questionIds: [], generated: 0, skillSha: "x" }),
  markFailed: vi.fn(async () => undefined),
  sleep: async () => undefined,
  ...over,
});

describe("startGenerateDetached", () => {
  it("returns the attempt id without waiting for the run", async () => {
    const never = new Promise<never>(() => undefined);
    const run = vi.fn((..._a: unknown[]) => never) as unknown as DetachedDeps["run"] & ReturnType<typeof vi.fn>;
    const { attemptId } = await startGenerateDetached(args, deps({ run }));
    expect(attemptId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(run.mock.calls[0]![10]).toBe(attemptId);
  });

  it("marks the attempt failed when the detached run throws", async () => {
    let reject!: (e: unknown) => void;
    const run = new Promise<never>((_, r) => { reject = r; });
    const markFailed = vi.fn(async () => undefined);
    const { attemptId } = await startGenerateDetached(args, deps({ run: () => run, markFailed }));
    reject(new AppError("boom", "SKILL_FAILED", 500));
    await vi.waitFor(() => expect(markFailed).toHaveBeenCalledWith("t", attemptId, "SKILL_FAILED", "boom"));
  });

  it("throws the run's 409 when the lock is held", async () => {
    const run = () => Promise.reject(new AppError("in flight", "AIG_GRADING_IN_PROGRESS", 409));
    await expect(startGenerateDetached(args, deps({ run }))).rejects.toMatchObject({ code: "AIG_GRADING_IN_PROGRESS" });
  });
});
