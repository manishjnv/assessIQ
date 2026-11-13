// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CliError, LIMIT_NOTE, parseArgs, parseIdsFile, run, type Args, type Deps } from "../aiq-verify-activate.js";

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actor = { tenantId: "t", userId: "u", role: "super_admin" as const };

const args = (over: Partial<Args> = {}): Args => ({
  idsFile: "ids.txt", seedPrefixes: [], packs: [], verify: true, activate: true, backfill: false, commit: false, expect: null, ...over,
});

function fakes(over: Partial<Deps> = {}, text = `${U(1)}\n\n${U(2)}\n${U(1)}\n`): Deps & { calls: string[]; out_: string[]; err_: string[]; expects: Array<number | undefined> } {
  const expects: Array<number | undefined> = [];
  const calls: string[] = []; const out_: string[] = []; const err_: string[] = [];
  const d: Deps = {
    readFile: async () => text,
    getActor: async () => actor,
    resolveIds: async () => [U(5), U(6)],
    describeIds: async () => [{ slug: "p", total: 2, byStatus: { draft: 2 }, byReviewState: { in_review: 1, null: 1 }, noVersion: 2, otherDraftsInPack: 7 }],
    verifyQuestionsByIds: async (_a, ids) => { calls.push(`verify:${ids.length}`); return { verified: ids.length, alreadyVerified: 0 }; },
    activateQuestionsByIds: async (_a, ids) => { calls.push(`activate:${ids.length}`); return { activated: ids.length, alreadyActive: 0, snapshotsWritten: ids.length }; },
    backfillMissingSnapshots: async (_a, o) => { calls.push(`backfill:${o.commit}`); if (o.commit) expects.push(o.expect); return { packs: [{ packId: "pk", slug: "p", missing: 3 }], total: 3, written: o.commit ? 3 : 0 }; },
    out: (s) => void out_.push(s),
    err: (s) => void err_.push(s),
    ...over,
  };
  return Object.assign(d, { calls, out_, err_, expects });
}
const writes = (c: string[]): string[] => c.filter((x) => !x.startsWith("backfill:false"));
const exitOf = async (p: Promise<number>): Promise<number> => p.then((n) => n, (e) => (e instanceof CliError ? e.exitCode : -1));

describe("parseArgs", () => {
  it("accepts every flag", () => {
    expect(parseArgs(["--seed-prefix", "a@1:", "--seed-prefix", "b@2:", "--pack", "x", "--verify", "--activate", "--commit", "--expect", "4"]))
      .toEqual({ idsFile: "", seedPrefixes: ["a@1:", "b@2:"], packs: ["x"], verify: true, activate: true, backfill: false, commit: true, expect: 4 });
    expect(parseArgs(["--ids-file", "f", "--verify"]).idsFile).toBe("f");
    expect(parseArgs(["--backfill-snapshots", "--pack", "x", "--commit", "--expect", "3"]).backfill).toBe(true);
  });
  it.each([
    [["--ids-file", "f", "--seed-prefix", "a@1:", "--verify"]],
    [["--verify"]],
    [["--ids-file", "f"]],
    [["--ids-file"]],
    [["--ids-file", "f", "--verify", "--expect", "3"]],
    [["--ids-file", "f", "--verify", "--commit", "--expect", "x"]],
    [["--ids-file", "f", "--verify", "--bogus"]],
    [["--backfill-snapshots", "--verify"]],
    [["--backfill-snapshots", "--commit"]],
    [["--ids-file", "a", "--ids-file", "b", "--verify"]],
  ])("exits 5 for %j", (argv) => {
    expect(() => parseArgs(argv)).toThrowError(CliError);
    try { parseArgs(argv); } catch (e) { expect((e as CliError).exitCode).toBe(5); }
  });
});

describe("parseIdsFile", () => {
  it("skips blanks and drops duplicates", () => {
    expect(parseIdsFile(`${U(1)}\r\n\n  \n${U(2)}\n${U(1)}`)).toEqual([U(1), U(2)]);
  });
  it("a bad uuid is exit 3", async () => {
    expect(() => parseIdsFile("nope")).toThrowError(/not a uuid/);
    expect(await exitOf(run(args(), fakes({}, "nope\n")))).toBe(3);
  });
});

describe("run, ids form", () => {
  it("dry run writes nothing and prints the check lines", async () => {
    const d = fakes();
    expect(await run(args(), d)).toBe(0);
    expect(writes(d.calls)).toEqual([]);
    const o = d.out_.join("");
    expect(o).toContain("DRY RUN");
    expect(o).toContain('"resolved_ids": 2');
    expect(o).toContain('"other_drafts_in_pack"');
    expect(o).toContain("active rows without a snapshot: 3 (must be 0 after a load)");
    expect(o).toContain(LIMIT_NOTE);
  });
  it("--expect mismatch is exit 3 and nothing is written", async () => {
    const d = fakes();
    expect(await exitOf(run(args({ commit: true, expect: 3 }), d))).toBe(3);
    expect(writes(d.calls)).toEqual([]);
  });
  it("over 5,000 ids is exit 3", async () => {
    const d = fakes({ resolveIds: async () => Array.from({ length: 5001 }, (_, i) => U(i)) });
    expect(await exitOf(run(args({ idsFile: "", seedPrefixes: ["a@1:"], commit: true }), d))).toBe(3);
    expect(writes(d.calls)).toEqual([]);
  });
  it("a prefix without @<digits>: is exit 3", async () => {
    expect(await exitOf(run(args({ idsFile: "", seedPrefixes: ["abc@1"] }), fakes()))).toBe(3);
    expect(await exitOf(run(args({ idsFile: "", seedPrefixes: ["abc"] }), fakes()))).toBe(3);
  });
  it("commit runs verify then activate, with the post-load line", async () => {
    const d = fakes();
    expect(await run(args({ commit: true, expect: 2 }), d)).toBe(0);
    expect(d.calls.filter((c) => !c.startsWith("backfill"))).toEqual(["verify:2", "activate:2"]);
    const o = d.out_.join("");
    expect(o).toMatch(/ids_sha256=[0-9a-f]{64}/);
    expect(o).toContain("active rows without a snapshot");
    expect(o).toContain(LIMIT_NOTE);
  });
  it("activate failure after verify is exit 4 with the message", async () => {
    const d = fakes({ activateQuestionsByIds: async () => { throw new Error("boom"); } });
    expect(await run(args({ commit: true }), d)).toBe(4);
    expect(d.err_.join("")).toContain("verify was written");
    expect(d.err_.join("")).toContain("activate was NOT written");
  });
  it("activate failure without verify is not exit 4", async () => {
    const d = fakes({ activateQuestionsByIds: async () => { throw new Error("boom"); } });
    await expect(run(args({ commit: true, verify: false }), d)).rejects.toThrow("boom");
  });
  it("refused ids print at most 20 entries and exit 3", async () => {
    const bad = Array.from({ length: 30 }, (_, i) => ({ id: U(i), reason: "nope" }));
    const d = fakes({ verifyQuestionsByIds: async () => { throw Object.assign(new Error("refused"), { details: { code: "X", bad, bad_count: 30 } }); } });
    expect(await exitOf(run(args({ commit: true }), d))).toBe(3);
    const e = d.err_.join("");
    expect(e.match(/ {2}0{8}-/g)?.length).toBe(20);
    expect(e).toContain("refused 30 id(s)");
  });
  it("COMMIT line says the digest covers all ids; the activate result is printed whole", async () => {
    const packs = [{ packId: "pk", count: 2, idsSha256: "ab".repeat(32) }];
    const d = fakes({ activateQuestionsByIds: async () => ({ activated: 2, alreadyActive: 0, snapshotsWritten: 2, packs }) });
    await run(args({ commit: true }), d);
    const o = d.out_.join("");
    expect(o).toContain("over all ids");
    expect(o).toContain(`"idsSha256":"${"ab".repeat(32)}"`);
  });
  it("dry run reports ids not found in platform packs", async () => {
    const d = fakes({ describeIds: async () => [{ slug: "p", total: 1, byStatus: { draft: 1 }, byReviewState: {}, noVersion: 1, otherDraftsInPack: 0 }] });
    await run(args(), d);
    expect(d.out_.join("")).toContain('"not_found_in_platform_packs": 1');
  });
  it("activate failure after verify also lists the refused ids", async () => {
    const bad = [{ id: U(9), reason: "not draft" }];
    const d = fakes({ activateQuestionsByIds: async () => { throw Object.assign(new Error("refused"), { details: { bad, bad_count: 1 } }); } });
    expect(await run(args({ commit: true }), d)).toBe(4);
    expect(d.err_.join("")).toContain(`${U(9)}  not draft`);
  });
  it("a post-check failure after a commit says the writes were committed", async () => {
    const d = fakes({ backfillMissingSnapshots: async () => { throw new Error("db down"); } });
    await expect(run(args({ commit: true }), d)).rejects.toThrow("db down");
    expect(d.calls.filter((c) => c.startsWith("verify") || c.startsWith("activate"))).toEqual(["verify:2", "activate:2"]);
    expect(d.err_.join("")).toContain("WERE COMMITTED");
  });
  it("a post-check failure in a dry run does not claim a commit", async () => {
    const d = fakes({ backfillMissingSnapshots: async () => { throw new Error("db down"); } });
    await expect(run(args(), d)).rejects.toThrow("db down");
    expect(d.err_.join("")).not.toContain("WERE COMMITTED");
  });
  it("a CliError(3) from resolveIds propagates and nothing is written", async () => {
    const d = fakes({ resolveIds: async () => { throw new CliError(3, "unknown --pack slug"); } });
    const e = await run(args({ idsFile: "", seedPrefixes: ["a@1:"], packs: ["nope"], commit: true }), d).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CliError);
    expect((e as CliError).exitCode).toBe(3);
    expect(writes(d.calls)).toEqual([]);
  });
  it("no super admin is exit 1", async () => {
    expect(await exitOf(run(args(), fakes({ getActor: async () => null })))).toBe(1);
  });
});

describe("run, backfill form", () => {
  const b = (over: Partial<Args> = {}): Args => args({ idsFile: "", verify: false, activate: false, backfill: true, ...over });
  it("dry run does not write", async () => {
    const d = fakes();
    expect(await run(b(), d)).toBe(0);
    expect(d.calls.every((c) => c === "backfill:false")).toBe(true);
    expect(d.out_.join("")).toContain("DRY RUN");
  });
  it("commit with the right --expect writes", async () => {
    const d = fakes();
    expect(await run(b({ commit: true, expect: 3 }), d)).toBe(0);
    expect(d.calls).toContain("backfill:true");
    expect(d.expects).toEqual([3]);
    expect(d.out_.join("")).toContain(LIMIT_NOTE);
  });
  it("a service error on the commit propagates and prints no COMMITTED line", async () => {
    const d = fakes({ backfillMissingSnapshots: async (_a, o) => {
      if (o.commit) throw Object.assign(new Error("changed"), { details: { code: "REVIEW_COUNT_CHANGED" } });
      return { packs: [], total: 3, written: 0 };
    } });
    await expect(run(b({ commit: true, expect: 3 }), d)).rejects.toThrow("changed");
    expect(d.out_.join("")).not.toContain("COMMITTED");
  });
  it("wrong --expect is exit 3 and writes nothing", async () => {
    const d = fakes();
    expect(await exitOf(run(b({ commit: true, expect: 9 }), d))).toBe(3);
    expect(d.calls).not.toContain("backfill:true");
  });
});
