import { describe, it, expect, vi } from "vitest";

const create = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "a1" }));
vi.mock("../service/assessments.js", () => ({ createAssessment: create }));
// CT-0: section names come from taxonomy_nodes; the tenant session is faked here.
vi.mock("@assessiq/tenancy", () => ({
  withTenant: async (_t: string, fn: (c: unknown) => Promise<unknown>) =>
    fn({ query: async () => ({ rows: [{ id: "11111111-1111-4111-8111-111111111111", name: "Percentages" }] }) }),
}));

import { createDrill } from "../service/drill.js";

const N = "11111111-1111-4111-8111-111111111111";
const base = { pack_id: N, level_id: N, node_ids: [N], question_count: 5, opens_at: null };

describe("EXP-11 topic mock keeps the Mock card settings", () => {
  it("passes integrity and feedback_level to createAssessment next to the drill sections", async () => {
    await createDrill("t1", { ...base, settings: { integrity: { fullscreen: true, block_copy_paste: true }, feedback_level: "right_wrong" } }, "u1");
    const s = create.mock.calls[0]![1].settings;
    expect(s.integrity).toEqual({ fullscreen: true, block_copy_paste: true });
    expect(s.feedback_level).toBe("right_wrong");
    expect(s.drill).toBe(true);
    expect(s.sections).toHaveLength(1);
    expect(create.mock.calls[0]![1].delivery_mode).toBe("mock");
  });
  it("adds no integrity or feedback key when the card sent none", async () => {
    create.mockClear();
    await createDrill("t1", base, "u1");
    const s = create.mock.calls[0]![1].settings;
    expect(s).not.toHaveProperty("integrity");
    expect(s).not.toHaveProperty("feedback_level");
  });
});

describe("CT-0 topic counts and real topic names", () => {
  it("per-topic counts become the sections, the total is their sum, and the section carries the real topic name", async () => {
    create.mockClear();
    const M = "22222222-2222-4222-8222-222222222222";
    await createDrill("t1", { pack_id: N, level_id: N, topics: [{ node_id: N, count: 12 }, { node_id: M, count: 3 }], opens_at: null }, "u1");
    const arg = create.mock.calls[0]![1];
    expect(arg.question_count).toBe(15);
    expect(arg.settings.sections.map((x: { name: string; question_count: number }) => [x.name, x.question_count])).toEqual([["Percentages", 12], ["Topic 2", 3]]);
    expect(arg.settings.whole_test_minutes).toBe(23);
  });
  it("refuses a request with neither topics nor node_ids with question_count", async () => {
    await expect(createDrill("t1", { pack_id: N, level_id: N, opens_at: null }, "u1")).rejects.toThrow();
  });
});
