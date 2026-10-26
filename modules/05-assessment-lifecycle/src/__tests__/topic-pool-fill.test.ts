import { describe, it, expect } from "vitest";
import { assertSectionPoolsFillable } from "../service/blueprint.js";

const N = "11111111-1111-4111-8111-111111111111";
type Fact = { type: string; difficulty_est: number | null };
const mcq = (n: number, difficulty_est: number | null = 3): Fact[] => Array.from({ length: n }, () => ({ type: "mcq", difficulty_est }));
const client = (rows: Fact[]) => ({ query: async () => ({ rows }) }) as never;
const section = (extra: Record<string, unknown> = {}) => ({ sections: [{ name: "Topic 1", node_id: N, question_count: 10, ...extra }] });

describe("EXP-11 topic mock supply: publish refuses a topic with too few linked questions", () => {
  it("throws POOL_TOO_SMALL with the counts when the topic holds fewer than asked", async () => {
    await expect(assertSectionPoolsFillable(client(mcq(4)), N, N, section())).rejects.toMatchObject({ details: { available: 4, required: 10 } });
  });
  it("passes when the topic holds enough", async () => {
    await expect(assertSectionPoolsFillable(client(mcq(10)), N, N, section())).resolves.toBeUndefined();
  });
});

describe("CT-0 publish pre-flight uses the draw's type and difficulty filters", () => {
  const pool = [...mcq(6, 2), ...mcq(6, 5), ...Array.from({ length: 6 }, () => ({ type: "subjective", difficulty_est: 3 }))];
  it("counts only the allowed types: 12 mcq pass, 18 mixed would not be needed", async () => {
    await expect(assertSectionPoolsFillable(client(pool), N, N, section({ allowed_types: ["mcq"] }))).resolves.toBeUndefined();
    await expect(assertSectionPoolsFillable(client(pool), N, N, section({ allowed_types: ["subjective"] }))).rejects.toMatchObject({ details: { available: 6, required: 10 } });
  });
  it("counts only the difficulty range: 6 questions are level 5, so 10 asked at level 5 fails", async () => {
    await expect(assertSectionPoolsFillable(client(pool), N, N, section({ difficulty_min: 5 }))).rejects.toMatchObject({ details: { available: 6, required: 10 } });
  });
  it("a question with no difficulty never passes a difficulty range (same as the draw)", async () => {
    await expect(assertSectionPoolsFillable(client(mcq(10, null)), N, N, section({ difficulty_max: 5 }))).rejects.toMatchObject({ details: { available: 0 } });
  });
});
