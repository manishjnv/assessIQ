import { describe, it, expect, vi, beforeEach } from "vitest";

const state = { settings: {} as Record<string, unknown>, attempts: 0, updated: [] as unknown[] };

vi.mock("@assessiq/tenancy", () => ({
  getPool: vi.fn(),
  withTenant: async (_t: string, fn: (c: unknown) => unknown) =>
    fn({
      query: async (sql: string) => ({ rows: /FROM attempts/.test(sql) && state.attempts > 0 ? [{ "?column?": 1 }] : [] }),
    }),
}));
vi.mock("@assessiq/audit-log", () => ({ auditInTx: vi.fn(async () => undefined) }));
vi.mock("../repository.js", async (orig) => ({
  ...(await orig<object>()),
  findAssessmentById: async () => ({
    id: "a1", name: "n", status: "draft", question_count: 5, randomize: false,
    opens_at: null, closes_at: null, settings: state.settings,
  }),
  updateAssessmentRow: async (_c: unknown, _id: string, patch: unknown) => {
    state.updated.push(patch);
    return { id: "a1", name: "n", question_count: 5, randomize: false, opens_at: null, closes_at: null, settings: {} };
  },
}));

import { updateAssessment } from "../service.js";

const sec = { name: "Quant", question_count: 5, minutes: 10 };

describe("updateAssessment — SECTIONS_LOCKED", () => {
  beforeEach(() => { state.settings = { sections: [sec] }; state.attempts = 0; state.updated = []; });

  it("allows a sections change while no attempt exists", async () => {
    await updateAssessment("t", "a1", { settings: { sections: [{ ...sec, minutes: 20 }] } }, "u");
    expect(state.updated).toHaveLength(1);
  });

  it("409 SECTIONS_LOCKED when sections change and an attempt exists", async () => {
    state.attempts = 1;
    await expect(
      updateAssessment("t", "a1", { settings: { sections: [{ ...sec, minutes: 20 }] } }, "u"),
    ).rejects.toMatchObject({ status: 409, details: { code: "SECTIONS_LOCKED" } });
    expect(state.updated).toHaveLength(0);
  });

  it("removing sections is also locked", async () => {
    state.attempts = 1;
    await expect(updateAssessment("t", "a1", { settings: {} }, "u")).rejects.toMatchObject({ status: 409 });
  });

  it("unchanged sections (different key order) and other edits still work", async () => {
    state.attempts = 1;
    await updateAssessment("t", "a1", { settings: { sections: [{ minutes: 10, question_count: 5, name: "Quant" }] } }, "u");
    await updateAssessment("t", "a1", { name: "renamed" }, "u");
    expect(state.updated).toHaveLength(2);
  });
});
