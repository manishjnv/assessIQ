// @vitest-environment node
import { describe, expect, it } from "vitest";
import { analyzePool, seededRng, type PoolItem, type PoolSection } from "../pool-usage-report.js";

const mk = (i: number, o: Partial<PoolItem> = {}): PoolItem => ({
  id: `q${i}`, node_ids: ["S1"], style_node_ids: [], type: "mcq", difficulty_est: [1, 3, 5][i % 3]!, template_key: `k${i}`, ...o,
});
const items: PoolItem[] = [
  ...Array.from({ length: 30 }, (_, i) => mk(i)),
  mk(100, { node_ids: ["S2"] }), // subject no section reaches
  mk(101, { type: "numeric" }), // type no section allows
];
const sections: PoolSection[] = [{ blueprint: "B", name: "Quant", subject_node_id: "S1", question_count: 5, allowed_types: ["mcq"], difficulty_min: 1, difficulty_max: 3 }];

describe("analyzePool", () => {
  it("finds unreachable items by subject and difficulty", () => {
    const r = analyzePool(items, sections, 200, seededRng(1));
    expect(r.unreachable.total).toBe(2 + 10); // S2 item, numeric item, and the ten level-5 items
    expect(r.unreachable.bySubject["S2"]).toBe(1);
    expect(r.unreachable.byDifficulty["5"]).toBeGreaterThanOrEqual(10);
  });
  it("warns when bands miss level 5", () => {
    expect(analyzePool(items, sections, 10, seededRng(1)).warnings.some((w) => /miss level\(s\) 5/.test(w))).toBe(true);
  });
  it("warns when template keys are under 5x question_count, and not when keyless", () => {
    const few = items.map((it) => ({ ...it, template_key: "same" }));
    expect(analyzePool(few, sections, 10, seededRng(1)).warnings.some((w) => /distinct template keys/.test(w))).toBe(true);
    const keyless = items.map((it) => ({ ...it, template_key: null }));
    expect(analyzePool(keyless, [{ ...sections[0]!, question_count: 2 }], 10, seededRng(1)).warnings.some((w) => /distinct template keys/.test(w))).toBe(false);
  });
  it("is deterministic with a seeded rng and touches the whole reachable pool", () => {
    const a = analyzePool(items, sections, 300, seededRng(7));
    expect(analyzePool(items, sections, 300, seededRng(7))).toEqual(a);
    expect(a.sections[0]!.pool).toBe(20);
    expect(a.sections[0]!.touched).toBe(20);
    expect(a.sections[0]!.meanUses).toBeCloseTo((300 * 5) / 20, 5);
  });
});
