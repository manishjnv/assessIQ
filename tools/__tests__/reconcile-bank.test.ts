// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseMap, reconcile, type ActualRow, type ExpectedStats } from "../reconcile-bank.js";

const expected: ExpectedStats = {
  packs: {
    practice: { total: 10, by_key_level: { "avg.a": { easy: 2, medium: 3, hard: 0 }, "age.b": { easy: 0, medium: 0, hard: 5 } } },
  },
  rows: [
    { template: "avg", category: "Quant", subtopic: "Averages" },
    { template: "age", category: "Quant", subtopic: "Ages" },
  ],
};
const opts = { map: { practice: "p1" } };
const row = (key: string | null, d: number | null, count: number, status = "active", pack = "p1"): ActualRow => ({ pack, key, difficulty_est: d, status, count });
const match = [row("avg.a", 1, 2), row("avg.a", 3, 3), row("age.b", 5, 5)];

describe("reconcile", () => {
  it("exact match has no deltas", () => {
    const r = reconcile(expected, match, opts);
    expect(r.deltaCount).toBe(0);
    expect(r.totals["practice"]).toEqual({ expected: 10, actual: 10 });
  });
  it("reports a count that is one short", () => {
    const r = reconcile(expected, [row("avg.a", 1, 1), row("avg.a", 3, 3), row("age.b", 5, 5)], opts);
    expect(r.deltas).toEqual([{ pack: "practice", key: "avg.a", level: "easy", expected: 2, actual: 1, diff: -1 }]);
    expect(r.deltaCount).toBe(1);
  });
  it("reports an extra key", () => {
    const r = reconcile(expected, [...match, row("zzz.x", 3, 4)], opts);
    expect(r.extras).toEqual([{ pack: "practice", key: "zzz.x", actual: 4 }]);
    expect(r.deltaCount).toBe(1);
  });
  it("reports a missing key", () => {
    const r = reconcile(expected, match.slice(0, 2), opts);
    expect(r.missing).toEqual([{ pack: "practice", key: "age.b", expected: 5 }]);
  });
  it("puts an odd difficulty in its own other:<n> bucket", () => {
    const r = reconcile(expected, [row("avg.a", 1, 2), row("avg.a", 3, 2), row("avg.a", 2, 1), row("age.b", 5, 5)], opts);
    expect(r.deltas.map((d) => d.level).sort()).toEqual(["medium", "other:2"]);
  });
  it("status filter: active ignores drafts, any counts them", () => {
    const rows = [...match, row("avg.a", 1, 1, "draft")];
    expect(reconcile(expected, rows, opts).deltaCount).toBe(0);
    const any = reconcile(expected, rows, { ...opts, status: "any" });
    expect(any.deltas).toEqual([{ pack: "practice", key: "avg.a", level: "easy", expected: 2, actual: 3, diff: 1 }]);
  });
  it("ignores rows of other packs and NULL keys unless allKeys", () => {
    const rows = [...match, row("avg.a", 1, 9, "active", "other"), row(null, 1, 7)];
    expect(reconcile(expected, rows, opts).deltaCount).toBe(0);
    expect(reconcile(expected, rows, { ...opts, allKeys: true }).extras).toEqual([{ pack: "practice", key: "(none)", actual: 7 }]);
  });
  it("rolls up by sub-topic and category", () => {
    const r = reconcile(expected, [row("avg.a", 1, 1), row("avg.a", 3, 3), row("age.b", 5, 5)], opts);
    expect(r.bySubtopic).toEqual([{ name: "Ages", expected: 5, actual: 5 }, { name: "Averages", expected: 5, actual: 4 }]);
    expect(r.byCategory).toEqual([{ name: "Quant", expected: 10, actual: 9 }]);
  });
});

describe("parseMap", () => {
  it("parses pairs and rejects junk", () => {
    expect(parseMap("practice=a,secure=b")).toEqual({ practice: "a", secure: "b" });
    expect(() => parseMap("practice")).toThrow();
  });
});
