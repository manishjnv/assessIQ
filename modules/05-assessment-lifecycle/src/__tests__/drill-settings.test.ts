import { describe, it, expect, vi } from "vitest";

const create = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "a1" }));
vi.mock("../service/assessments.js", () => ({ createAssessment: create }));

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
