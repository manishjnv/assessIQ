/**
 * Unit tests for eval/metrics.ts (Z-164 EVAL-HARDEN, E1-E8, E15, E18). Pure functions: no files, no AI.
 */

import { describe, it, expect } from "vitest";

import {
  abortReasonForErrors,
  agreementByGroup,
  anchorF1,
  bandStats,
  blessBlockers,
  checkRunValidity,
  coverageOf,
  defaultBudgetUsd,
  effectiveStageModels,
  groupOfCase,
  inIdList,
  mcnemarExact,
  pairedBandRuns,
  parseIdList,
  parseModelField,
  questionKey,
  runSummary,
  runWarnings,
  targetChecks,
  wilsonLowerPct,
  requiredHits,
  requiredCases,
  type EvalActual,
  type EvalExpected,
} from "../metrics.js";

const exp = (id: string, band: number, hits: boolean[] = [], adversarial = false): EvalExpected => ({
  id,
  band,
  adversarial,
  anchors: hits.map((hit, i) => ({ anchor_id: `anchor-${i}`, hit })),
});
const act = (id: string, band: number | null, hits: boolean[] = [], extra: Partial<EvalActual> = {}): EvalActual => ({
  id,
  band,
  anchors: hits.map((hit, i) => ({ anchor_id: `anchor-${i}`, hit })),
  ...extra,
});
const mapOf = (...e: EvalExpected[]) => new Map(e.map((x) => [x.id, x]));

describe("E1 abort rule", () => {
  it("aborts after 3 errors in a row", () => {
    expect(abortReasonForErrors({ consecutive: 3, errors: 3, planned: 151 })).toMatch(/in a row/);
  });
  it("aborts when total errors pass 5% of the planned cases, even when they are not in a row", () => {
    expect(abortReasonForErrors({ consecutive: 0, errors: 2, planned: 27 })).toMatch(/5%/); // 7.4%
    expect(abortReasonForErrors({ consecutive: 0, errors: 8, planned: 151 })).toMatch(/5%/); // 5.3%
  });
  it("does not abort at or under 5%", () => {
    expect(abortReasonForErrors({ consecutive: 1, errors: 7, planned: 151 })).toBeNull(); // 4.6%
    expect(abortReasonForErrors({ consecutive: 0, errors: 0, planned: 9 })).toBeNull();
  });
  it("one error in a 9-case smoke aborts (11%)", () => {
    expect(abortReasonForErrors({ consecutive: 1, errors: 1, planned: 9 })).not.toBeNull();
  });
});

describe("E2 run validity", () => {
  const e = mapOf(exp("aiq-log-L1-1-01", 2, [true, false]), exp("aiq-log-L1-1-02", 1));
  it("is valid with no errors and anchors present", () => {
    expect(checkRunValidity([act("aiq-log-L1-1-01", 2, [true, false]), act("aiq-log-L1-1-02", 1)], e).valid).toBe(true);
  });
  it("names an errored case", () => {
    const r = checkRunValidity([act("aiq-log-L1-1-01", null, [], { error: { code: "X", message: "m" } })], e);
    expect(r.valid).toBe(false);
    expect(r.problems.join(" ")).toContain("aiq-log-L1-1-01");
  });
  it("flags a degraded Stage 1 and an anchored case with empty anchors", () => {
    const r = checkRunValidity([act("aiq-log-L1-1-01", 2, [], { degraded: true })], e);
    expect(r.problems.join(" ")).toContain("degraded");
    const r2 = checkRunValidity([act("aiq-log-L1-1-01", 2, [])], e);
    expect(r2.problems.join(" ")).toContain("returned no anchors");
  });
  it("is invalid when the run was aborted", () => {
    expect(checkRunValidity([], e, "budget").valid).toBe(false);
  });
});

describe("E4 band statistics", () => {
  it("counts distribution, over and under by expected band, within-one and exact", () => {
    const s = bandStats([
      { expected: 4, actual: 4 },
      { expected: 4, actual: 3 }, // under
      { expected: 2, actual: 3 }, // over
      { expected: 0, actual: 3 }, // over by 3
      { expected: 1, actual: null }, // error = miss
    ]);
    expect(s.exactPct).toBe(20);
    expect(s.withinOnePct).toBe(60);
    expect(s.overTotal).toBe(2);
    expect(s.underTotal).toBe(1);
    expect(s.over[2]).toBe(1);
    expect(s.under[4]).toBe(1);
    expect(s.distribution[3]).toEqual({ band: 3, expected: 0, actual: 3 });
  });
  it("kappa is 1 for perfect agreement over two bands and null when all cases sit in one band", () => {
    expect(bandStats([{ expected: 1, actual: 1 }, { expected: 3, actual: 3 }]).kappaQw).toBe(1);
    expect(bandStats([{ expected: 2, actual: 2 }, { expected: 2, actual: 2 }]).kappaQw).toBeNull();
  });
  it("a one-band slip scores a higher kappa than a three-band slip", () => {
    const near = bandStats([{ expected: 0, actual: 0 }, { expected: 4, actual: 3 }, { expected: 2, actual: 2 }]).kappaQw!;
    const far = bandStats([{ expected: 0, actual: 0 }, { expected: 4, actual: 1 }, { expected: 2, actual: 2 }]).kappaQw!;
    expect(near).toBeGreaterThan(far);
  });
});

describe("E15 anchor F1", () => {
  it("does not pool anchor ids across questions", () => {
    // Question A: anchor-0 perfect. Question B: anchor-0 always missed. Pooled would hide the miss in B.
    const e = mapOf(exp("aiq-log-L1-1-01", 2, [true]), exp("aiq-log-L1-2-01", 2, [true]));
    const f = anchorF1([act("aiq-log-L1-1-01", 2, [true]), act("aiq-log-L1-2-01", 2, [false])], e);
    expect(f.perAnchor["aiq-log-L1-1|anchor-0"]).toBe(1);
    expect(f.perAnchor["aiq-log-L1-2|anchor-0"]).toBe(0);
    expect(f.macro).toBe(0.5);
    expect(f.micro).toBeCloseTo(0.667, 3);
  });
  it("an anchor with no expected hit and no false positive is left out, not scored 0", () => {
    const e = mapOf(exp("aiq-log-L1-1-01", 2, [false, true]));
    const f = anchorF1([act("aiq-log-L1-1-01", 2, [false, true])], e);
    expect(f.undefinedCount).toBe(1);
    expect(f.macro).toBe(1);
  });
  it("an errored case counts its expected hits as misses", () => {
    const e = mapOf(exp("aiq-log-L1-1-01", 2, [true]));
    const f = anchorF1([act("aiq-log-L1-1-01", null, [], { error: { code: "X", message: "m" } })], e);
    expect(f.micro).toBe(0);
  });
});

describe("E6 McNemar", () => {
  it("is 1 with no discordant pairs and small for a lopsided split", () => {
    expect(mcnemarExact(0, 0)).toBe(1);
    expect(mcnemarExact(10, 10)).toBe(1);
    expect(mcnemarExact(12, 2)).toBeLessThan(0.05);
  });
  it("matches a known value: b=5, c=1 gives p = 0.2188", () => {
    expect(mcnemarExact(5, 1)).toBeCloseTo(0.2188, 3);
  });
  it("pairs only the cases both runs graded without error", () => {
    const e = mapOf(exp("c1", 1), exp("c2", 1), exp("c3", 1), exp("c4", 1));
    const a = [act("c1", 1), act("c2", 1), act("c3", 0), act("c4", 1)];
    const b = [act("c1", 1), act("c2", 0), act("c3", 0), act("c4", null, [], { error: { code: "X", message: "m" } })];
    const r = pairedBandRuns(a, b, e);
    expect(r).toMatchObject({ paired: 3, bothRight: 1, aOnly: 1, bOnly: 0, bothWrong: 1 });
  });
});

describe("E7 tuning set and groups", () => {
  it("parses ids and comments", () => {
    expect(parseIdList("# tuning\naiq-log-L1-1\n\naiq-log-L2-4-01 # x\n")).toEqual(["aiq-log-L1-1", "aiq-log-L2-4-01"]);
  });
  it("matches an entry exactly or as a prefix up to a dash, not a longer number", () => {
    const list = ["aiq-log-L1-1", "aiq-log-L2-4-01"];
    expect(inIdList("aiq-log-L1-1-03", list)).toBe(true);
    expect(inIdList("aiq-log-L1-1", list)).toBe(true);
    expect(inIdList("aiq-log-L1-10-01", list)).toBe(false);
    expect(inIdList("aiq-log-L2-4-02", list)).toBe(false);
  });
  it("groups by level and type and reports agreement for each", () => {
    expect(groupOfCase("aiq-scen-L3-2-01")).toEqual({ type: "scen", level: "L3" });
    expect(groupOfCase("override-123")).toEqual({ type: "other", level: "other" });
    const g = agreementByGroup(
      [
        { id: "aiq-log-L1-1-01", match: true },
        { id: "aiq-log-L1-1-02", match: false },
        { id: "aiq-log-L2-1-01", match: true },
      ],
      "level",
    );
    expect(g["L1"]).toEqual({ matched: 1, total: 2, pct: 50 });
    expect(g["L2"]?.pct).toBe(100);
  });
  it("question key drops the answer variant", () => {
    expect(questionKey("aiq-log-L1-4-02")).toBe("aiq-log-L1-4");
  });
});

describe("E8 coverage and bless", () => {
  it("counts errored and missing cases and blocks bless", () => {
    const c = coverageOf([act("a", 1), act("b", null, [], { error: { code: "X", message: "m" } })], ["a", "b", "c"]);
    expect(c).toEqual({ total: 3, graded: 1, errored: 1, missing: 1 });
    expect(blessBlockers(c)).toHaveLength(2);
  });
  it("allows bless only when every case is graded", () => {
    expect(blessBlockers(coverageOf([act("a", 1)], ["a"]))).toEqual([]);
  });
});

describe("E5 models and warnings", () => {
  it("api mode env override wins over the frontmatter; CLI mode ignores it", () => {
    const fm = { anchors: "claude-haiku-5-5", band: "claude-sonnet-5-5", escalate: "claude-opus-5-5" };
    expect(effectiveStageModels(fm, { AI_API_MODEL_GRADE_BAND: "claude-opus-5-5" }, "anthropic-api").band).toBe("claude-opus-5-5");
    expect(effectiveStageModels(fm, { AI_API_MODEL_GRADE_BAND: "claude-opus-5-5" }, "claude-code-vps").band).toBe("claude-sonnet-5-5");
  });
  it("splits the proposal model field on semicolons", () => {
    expect(parseModelField("claude-haiku-5-5;claude-sonnet-5-5;-")).toEqual({
      anchors: "claude-haiku-5-5",
      band: "claude-sonnet-5-5",
      escalate: "-",
    });
  });
  it("warns on an unknown model, a missing stage_models and an old baseline sha", () => {
    const w = runWarnings(
      { skill_shas: { band: "bbbb" }, stage_models: { anchors: "gpt-x" } },
      { skill_shas: { band: "aaaa" } },
    );
    expect(w.join(" ")).toContain("unknown model id for anchors");
    expect(w.join(" ")).toContain("baseline band skill sha aaaa differs");
    expect(runWarnings({}, null).join(" ")).toContain("no stage_models");
  });
});

describe("E9 and E18", () => {
  it("default USD cap: 10 for the full run, 1 otherwise", () => {
    expect(defaultBudgetUsd(true)).toBe(10);
    expect(defaultBudgetUsd(false)).toBe(1);
  });
  it("summarises injection band 4, escalations and rupees", () => {
    const e = mapOf(exp("a", 0, [], true), exp("b", 2), exp("c", 2));
    const s = runSummary(
      [act("a", 4), act("b", 2, [], { escalation_stage: "3" }), act("c", 2, [], { escalation_stage: "2" })],
      e,
      0.3,
      10,
    );
    expect(s.injectionBand4).toBe(1);
    expect(s.escalations).toBe(1);
    expect(s.rupeesPerCase).toBe(8.5); // 0.3 USD x 85 / 3 cases
    expect(s.rupeesPerAssessment).toBe(85);
  });
  it("gives no rupee figures when the cost is unknown (CLI mode)", () => {
    expect(runSummary([act("a", 1)], mapOf(exp("a", 1)), null).rupeesPerCase).toBeNull();
  });
});

describe("targetChecks (Z-165 B1)", () => {
  it("passes a perfect run of 100 and flags a one-sided bias", () => {
    const perfect = Array.from({ length: 100 }, (_, i) => ({ expected: i % 5, actual: i % 5 }));
    expect(targetChecks(perfect).filter((c) => !c.na).every((c) => c.pass)).toBe(true);
    const low = Array.from({ length: 100 }, (_, i) => ({ expected: (i % 4) + 1, actual: i % 4 === 0 ? 0 : (i % 4) + 1 }));
    const checks = targetChecks(low);
    expect(checks.find((c) => c.name.startsWith("signed bias"))!.pass).toBe(false);
  });
  it("coverage counts manual rows out of the agreed subset", () => {
    const rows = [
      { expected: 3, actual: 3, stage: "2" },
      { expected: 3, actual: 4, stage: "manual" },
    ];
    const cov = targetChecks(rows).find((c) => c.name === "agreed subset coverage %")!;
    expect(cov.value).toBe(50);
    expect(cov.pass).toBe(false);
  });
  it("wilson bound is below the point estimate", () => {
    expect(wilsonLowerPct(114, 150)).toBeLessThan(76);
    expect(wilsonLowerPct(0, 0)).toBe(0);
  });
});

describe("sample-size helpers and N/A routing (Z-165)", () => {
  it("requiredHits agrees with wilsonLowerPct and is the smallest k", () => {
    const k = requiredHits(150)!;
    expect(wilsonLowerPct(k, 150)).toBeGreaterThanOrEqual(85);
    expect(wilsonLowerPct(k - 1, 150)).toBeLessThan(85);
    expect(k).toBe(137);
  });
  it("requiredCases is large for 87 percent and small for 95 percent", () => {
    expect(requiredCases(87)!).toBeGreaterThan(1000);
    expect(requiredCases(95)!).toBeLessThan(150);
  });
  it("parts 5 and 6 are N/A when Stage 3 never ran, measurable when it did", () => {
    const none = targetChecks([{ expected: 3, actual: 3, stage: "2" }]);
    expect(none.filter((c) => c.na).length).toBe(2);
    const some = targetChecks([{ expected: 3, actual: 3, stage: "3" }]);
    expect(some.filter((c) => c.na).length).toBe(0);
  });
});
