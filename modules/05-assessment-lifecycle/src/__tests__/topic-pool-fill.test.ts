import { describe, it, expect } from "vitest";
import { assertSectionPoolsFillable } from "../service/blueprint.js";

const N = "11111111-1111-4111-8111-111111111111";
const client = (n: number) => ({ query: async () => ({ rows: [{ n: String(n) }] }) }) as never;
const sections = { sections: [{ name: "Topic 1", node_id: N, question_count: 10 }] };

describe("EXP-11 topic mock supply: publish refuses a topic with too few linked questions", () => {
  it("throws POOL_TOO_SMALL with the counts when the topic holds fewer than asked", async () => {
    await expect(assertSectionPoolsFillable(client(4), N, N, sections)).rejects.toMatchObject({ details: { available: 4, required: 10 } });
  });
  it("passes when the topic holds enough", async () => {
    await expect(assertSectionPoolsFillable(client(10), N, N, sections)).resolves.toBeUndefined();
  });
});
