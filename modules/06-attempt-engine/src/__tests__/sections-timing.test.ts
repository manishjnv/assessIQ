import { describe, it, expect } from "vitest";
import { readSections, resolveSection, totalSectionSeconds } from "../sections.js";

const S = [
  { name: "A", question_count: 1, minutes: 20 },
  { name: "B", question_count: 1, minutes: 15 },
  { name: "C", question_count: 1, minutes: 15 },
];
const t0 = new Date("2026-10-02T10:00:00Z");
const at = (min: number) => new Date(t0.getTime() + min * 60_000);

describe("section timing (pure)", () => {
  it("stays in section 0 before its deadline", () => {
    expect(resolveSection(S, null, t0, at(19))).toMatchObject({ current: 0 });
  });
  it("next section opens at the previous DEADLINE, not at read time", () => {
    const p = resolveSection(S, null, t0, at(25));
    expect(p?.current).toBe(1);
    expect(p?.startedAt.getTime()).toBe(at(20).getTime());
  });
  it("skips several finished sections at once and ends after the last", () => {
    expect(resolveSection(S, null, t0, at(40))?.current).toBe(2);
    expect(resolveSection(S, null, t0, at(50))).toBeNull();
  });
  it("honours stored progress (finish-early)", () => {
    const stored = { current: 1, started_at: at(5).toISOString() };
    expect(resolveSection(S, stored, t0, at(19))).toMatchObject({ current: 1 });
    expect(resolveSection(S, stored, t0, at(21))).toMatchObject({ current: 2 });
  });
  it("totals minutes, optionally from a section", () => {
    expect(totalSectionSeconds(S)).toBe(50 * 60);
    expect(totalSectionSeconds(S, 1)).toBe(30 * 60);
  });
  it("readSections: absent or malformed = null", () => {
    expect(readSections({})).toBeNull();
    expect(readSections({ sections: [{ name: "", minutes: 0 }] })).toBeNull();
    expect(readSections({ sections: S })).toHaveLength(3);
  });
});
