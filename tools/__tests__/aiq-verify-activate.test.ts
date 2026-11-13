// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CliError, LIMIT_NOTE, parseArgs, parseIdsFile, run, type Args, type Deps, type SyncResult } from "../aiq-verify-activate.js";

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actor = { tenantId: "t", userId: "u", role: "super_admin" as const };

const args = (over: Partial<Args> = {}): Args => ({
  idsFile: "ids.txt", seedPrefixes: [], packs: [], verify: true, activate: true, backfill: false, commit: false, expect: null, tenant: "platform", syncClones: false, ...over,
});

const SYNC: SyncResult = {
  packId: "pk", slug: "p", version: 4, bumped: false,
  clones: [
    { tenantId: "t1", tenantSlug: "wipro-soc", clonePackId: "c1", clonePackStatus: "published", unchanged: 5, wouldRevive: 0, sourceVersion: 3, activeMasterRows: 10, missingInClone: 4, result: { updated: true, added: 4, changed: 1, archived: 0, skipped: 2 } },
    { tenantId: "t2", tenantSlug: "acme", clonePackId: "c2", clonePackStatus: "draft", unchanged: 0, wouldRevive: 0, sourceVersion: null, activeMasterRows: 10, missingInClone: 10, result: { updated: false, added: 10, changed: 0, archived: 0, skipped: 0 } },
  ],
};
const SYNC_BAD: SyncResult = { ...SYNC, clones: [SYNC.clones[0]!, { ...SYNC.clones[1]!, error: "locked" }] };

function fakes(over: Partial<Deps> = {}, text = `${U(1)}\n\n${U(2)}\n${U(1)}\n`): Deps & { calls: string[]; out_: string[]; err_: string[]; expects: Array<number | undefined>; added: Array<number | undefined> } {
  const expects: Array<number | undefined> = [];
  const added: Array<number | undefined> = [];
  const calls: string[] = []; const out_: string[] = []; const err_: string[] = [];
  const d: Deps = {
    readFile: async () => text,
    getActor: async () => actor,
    resolveIds: async () => [U(5), U(6)],
    describeIds: async () => [{ slug: "p", total: 2, byStatus: { draft: 2 }, byReviewState: { in_review: 1, null: 1 }, noVersion: 2, otherDraftsInPack: 7 }],
    verifyQuestionsByIds: async (_a, ids) => { calls.push(`verify:${ids.length}`); return { verified: ids.length, alreadyVerified: 0 }; },
    activateQuestionsByIds: async (_a, ids) => { calls.push(`activate:${ids.length}`); return { activated: ids.length, alreadyActive: 0, snapshotsWritten: ids.length }; },
    syncClonesForPack: async (_a, _s, o) => { calls.push(`sync:${o.commit}`); added.push(o.expectAdded); return SYNC; },
    backfillMissingSnapshots: async (_a, o) => { calls.push(`backfill:${o.commit}`); if (o.commit) expects.push(o.expect); return { packs: [{ packId: "pk", slug: "p", missing: 3 }], total: 3, written: o.commit ? 3 : 0 }; },
    out: (s) => void out_.push(s),
    err: (s) => void err_.push(s),
    ...over,
  };
  return Object.assign(d, { calls, out_, err_, expects, added });
}
const writes = (c: string[]): string[] => c.filter((x) => !x.startsWith("backfill:false"));
const exitOf = async (p: Promise<number>): Promise<number> => p.then((n) => n, (e) => (e instanceof CliError ? e.exitCode : -1));

describe("parseArgs", () => {
  it("accepts every flag", () => {
    expect(parseArgs(["--seed-prefix", "a@1:", "--seed-prefix", "b@2:", "--pack", "x", "--verify", "--activate", "--commit", "--expect", "4"]))
      .toEqual({ idsFile: "", seedPrefixes: ["a@1:", "b@2:"], packs: ["x"], verify: true, activate: true, backfill: false, commit: true, expect: 4, tenant: "platform", syncClones: false });
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
    expect(o).toContain("active rows without a snapshot (tenant platform): 3 (must be 0 after a load)");
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

describe("--tenant and --sync-clones", () => {
  it("parseArgs: tenant defaults to platform and is accepted for backfill", () => {
    expect(parseArgs(["--backfill-snapshots"]).tenant).toBe("platform");
    expect(parseArgs(["--backfill-snapshots", "--tenant", "wipro-soc"]).tenant).toBe("wipro-soc");
  });
  it.each([
    [["--ids-file", "f", "--verify", "--tenant", "x"]],
    [["--seed-prefix", "a@1:", "--activate", "--tenant", "x"]],
    [["--sync-clones", "--pack", "p", "--tenant", "x"]],
    [["--sync-clones"]],
    [["--sync-clones", "--pack", "a", "--pack", "b"]],
    [["--sync-clones", "--pack", "a", "--commit"]],
    [["--sync-clones", "--pack", "a", "--expect", "1"]],
    [["--sync-clones", "--pack", "a", "--verify"]],
    [["--sync-clones", "--pack", "a", "--ids-file", "f"]],
    [["--sync-clones", "--pack", "a", "--backfill-snapshots"]],
    [["--tenant"]],
  ])("parseArgs exits 5 for %j", (argv) => {
    expect(() => parseArgs(argv)).toThrowError(CliError);
    try { parseArgs(argv); } catch (e) { expect((e as CliError).exitCode).toBe(5); }
  });
  it("parseArgs accepts --sync-clones with one pack; --commit needs --expect", () => {
    expect(parseArgs(["--sync-clones", "--pack", "p"])).toMatchObject({ syncClones: true, packs: ["p"], commit: false });
    expect(parseArgs(["--sync-clones", "--pack", "p", "--commit", "--expect", "14"])).toMatchObject({ commit: true, expect: 14 });
  });
  const b = (over: Partial<Args> = {}): Args => args({ idsFile: "", verify: false, activate: false, backfill: true, ...over });
  it("backfill for an organisation passes the slug and prints the tenant", async () => {
    const slugs: string[] = [];
    const d = fakes({ getActor: async (s) => { slugs.push(s); return { ...actor, role: "admin" }; } });
    expect(await run(b({ tenant: "wipro-soc" }), d)).toBe(0);
    expect(slugs).toEqual(["wipro-soc"]);
    const o = d.out_.join("");
    expect(o.startsWith("tenant: wipro-soc\n")).toBe(true);
    expect(o).toContain("active rows without a snapshot (tenant wipro-soc): 3 (must be 0 after a load)");
  });
  it("exit 1 message names the tenant slug", async () => {
    const e = await run(b({ tenant: "nope" }), fakes({ getActor: async () => null })).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CliError);
    expect((e as CliError).exitCode).toBe(1);
    expect((e as CliError).message).toContain("nope");
  });
  const s = (over: Partial<Args> = {}): Args => args({ idsFile: "", verify: false, activate: false, syncClones: true, packs: ["p"], expect: null, ...over });
  it("sync dry run calls commit false only and prints the clone lines and the note", async () => {
    const d = fakes();
    expect(await run(s(), d)).toBe(0);
    expect(d.calls).toEqual(["sync:false"]);
    const o = d.out_.join("");
    expect(o).toContain("DRY RUN");
    expect(o).toContain("clone wipro-soc (published): would add 4, update 1, archive 0, revive 0, leave 5 unchanged, skip 2; missing 4 of 10 active master rows (source version 3, pack version 4)");
    expect(o).toContain("clone acme (draft): would add 10, update 0, archive 0, revive 0, leave 0 unchanged, skip 0; missing 10 of 10");
    expect(o).toContain("TOTAL would add 14, update 1, archive 0, revive 0, skip 2");
    expect(o).toContain("A sync also updates clone rows whose master changed and archives clone rows whose master is no longer active (the existing resync rule).");
  });
  it("dry run warns on stderr when update or archive is above 0, and not when both are 0", async () => {
    const d = fakes();
    expect(await run(s(), d)).toBe(0);
    expect(d.err_.join("")).toContain("This sync would UPDATE, ARCHIVE, REVIVE or SKIP clone rows. Show the table to the owner before --commit.");
    const quiet: SyncResult = { ...SYNC, clones: [SYNC.clones[1]!] };
    const d2 = fakes({ syncClonesForPack: async () => quiet });
    expect(await run(s(), d2)).toBe(0);
    expect(d2.err_.join("")).toBe("");
    expect(d2.out_.join("")).toContain("TOTAL would add 10, update 0, archive 0, revive 0, skip 0");
  });
  it("a revive alone raises the warning and shows in the line and total", async () => {
    const one: SyncResult = { ...SYNC, clones: [{ ...SYNC.clones[1]!, wouldRevive: 3, result: { updated: true, added: 10, changed: 0, archived: 0, skipped: 0 } }] };
    const d = fakes({ syncClonesForPack: async () => one });
    expect(await run(s(), d)).toBe(0);
    expect(d.out_.join("")).toContain("archive 0, revive 3, leave");
    expect(d.out_.join("")).toContain("revive 3, skip 0");
    expect(d.err_.join("")).toContain("REVIVE");
  });
  it("sync commit passes --expect as expectAdded; the dry run passes none", async () => {
    const d = fakes();
    await run(s({ commit: true, expect: 14 }), d);
    expect(d.added).toEqual([14]);
    const d2 = fakes();
    await run(s(), d2);
    expect(d2.added).toEqual([undefined]);
  });
  it("sync commit: a service refusal propagates", async () => {
    const d = fakes({ syncClonesForPack: async () => { throw Object.assign(new Error("changed"), { details: { code: "REVIEW_COUNT_CHANGED" } }); } });
    await expect(run(s({ commit: true, expect: 1 }), d)).rejects.toThrow("changed");
  });
  it("sync commit prints the results", async () => {
    const d = fakes();
    expect(await run(s({ commit: true }), d)).toBe(0);
    expect(d.calls).toEqual(["sync:true"]);
    expect(d.out_.join("")).toContain("COMMITTED");
  });
  it("sync commit prints added, changed, archived and skipped per clone", async () => {
    const d = fakes();
    await run(s({ commit: true }), d);
    expect(d.out_.join("")).toContain("clone wipro-soc: added 4, updated 1, archived 0, skipped 2");
  });
  it("a clone with an error is exit 4 and names the tenant on stderr", async () => {
    const d = fakes({ syncClonesForPack: async () => SYNC_BAD });
    expect(await run(s({ commit: true }), d)).toBe(4);
    expect(d.err_.join("")).toContain("acme");
    expect(d.err_.join("")).toContain("other clones were written");
    expect(d.out_.join("")).toContain("clone acme: ERROR locked");
  });
});

describe("clone push after activate", () => {
  const act = (cloneSync: Array<{ packId: string; tenants: number; updated: number; failed: number; skipped: number }>): Partial<Deps> => ({
    activateQuestionsByIds: async () => ({ activated: 2, alreadyActive: 0, snapshotsWritten: 2, cloneSync }),
  });
  it("prints one line per entry and exits 0 when nothing failed", async () => {
    const d = fakes(act([{ packId: "pk1", tenants: 3, updated: 3, failed: 0, skipped: 0 }]));
    expect(await run(args({ commit: true }), d)).toBe(0);
    expect(d.out_.join("")).toContain("clone push pack pk1: tenants 3, updated 3, failed 0, skipped 0");
    expect(d.err_.join("")).toBe("");
  });
  it("a failed tenant is exit 4 with the stderr line, after the post-check", async () => {
    const d = fakes(act([{ packId: "pk1", tenants: 3, updated: 2, failed: 1, skipped: 0 }, { packId: "pk2", tenants: 1, updated: 1, failed: 0, skipped: 0 }]));
    expect(await run(args({ commit: true }), d)).toBe(4);
    expect(d.err_.join("")).toContain("clone push failed for 1 tenant(s) of pack pk1; the activation WAS written. Run --sync-clones --pack <slug> to finish.");
    expect(d.out_.join("")).toContain("clone push pack pk2: tenants 1, updated 1, failed 0, skipped 0");
    expect(d.out_.join("")).toContain("active rows without a snapshot");
  });
});

describe("fix round", () => {
  const s = (over: Partial<Args> = {}): Args => args({ idsFile: "", verify: false, activate: false, syncClones: true, packs: ["p"], expect: null, ...over });
  const c0 = SYNC.clones[0]!;
  it("skipped clone-push rows are exit 4 with the taxonomy message", async () => {
    const d = fakes({ activateQuestionsByIds: async () => ({ activated: 2, alreadyActive: 0, snapshotsWritten: 2, cloneSync: [{ packId: "pk1", tenants: 2, updated: 2, failed: 0, skipped: 5 }] }) });
    expect(await run(args({ commit: true }), d)).toBe(4);
    expect(d.out_.join("")).toContain("clone push pack pk1: tenants 2, updated 2, failed 0, skipped 5");
    expect(d.err_.join("")).toContain("clone push skipped 5 row(s) in pack pk1 (taxonomy miss); the activation WAS written. Fix the taxonomy, then run --sync-clones --pack <slug>.");
  });
  it("sync commit: a clone with result and error prints both and is exit 4", async () => {
    const d = fakes({ syncClonesForPack: async () => ({ ...SYNC, clones: [{ ...c0, error: "skipped 2 rows" }] }) });
    expect(await run(s({ commit: true, expect: 4 }), d)).toBe(4);
    const o = d.out_.join("");
    expect(o).toContain("clone wipro-soc: added 4, updated 1, archived 0, skipped 2");
    expect(o).toContain("clone wipro-soc: ERROR skipped 2 rows");
    expect(d.err_.join("")).toContain("clone sync failed for: wipro-soc. The other clones were written.");
  });
  it("dry run: a no-op clone shows revive 0 and does not count its wouldRevive", async () => {
    const noop = { ...c0, wouldRevive: 6, result: { updated: false, added: 0, changed: 0, archived: 0, skipped: 0 } };
    const d = fakes({ syncClonesForPack: async () => ({ ...SYNC, clones: [noop] }) });
    expect(await run(s(), d)).toBe(0);
    expect(d.out_.join("")).toContain("archive 0, revive 0, leave");
    expect(d.out_.join("")).toContain("TOTAL would add 0, update 0, archive 0, revive 0, skip 0");
    expect(d.err_.join("")).toBe("");
  });
  it("dry run with a clone error says the preview failed and nothing was written", async () => {
    const d = fakes({ syncClonesForPack: async () => ({ ...SYNC, clones: [{ ...SYNC.clones[1]!, error: "bad" }] }) });
    expect(await run(s(), d)).toBe(4);
    expect(d.err_.join("")).toContain("clone preview failed for: acme. Nothing was written.");
    expect(d.err_.join("")).not.toContain("The other clones were written");
  });
  it("a preview-error refusal on commit propagates (exit 3 by code) and names the tenants", async () => {
    const e = Object.assign(new Error("preview failed"), { details: { code: "REVIEW_COUNT_CHANGED", preview_errors: [{ tenantSlug: "acme", error: "boom" }] } });
    const d = fakes({ syncClonesForPack: async () => { throw e; } });
    await expect(run(s({ commit: true, expect: 1 }), d)).rejects.toBe(e);
    expect(d.err_.join("")).toContain("preview failed: acme (boom)");
    expect(d.out_.join("")).not.toContain("COMMITTED");
  });
});
