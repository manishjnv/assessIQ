// RW-93 — generate wizard starts each category, then polls the attempt.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import React from "react";

const start = vi.fn();
const getAttempt = vi.fn();
const att = (status: string, extra: object = {}) => ({
  id: "a", status, count_requested: 2, count_inserted: status === "success" ? 2 : 0,
  error_code: null, error_message: null, ...extra,
});
const cat = (id: string, name: string) => ({ id, domain_id: "d1", slug: id, name, description: null, relevance_score: 1, default_selected: true, supported_types: ["mcq"], default_question_count: 2, status: "active" });

vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../api.js", () => ({
  AdminApiError: class AdminApiError extends Error { status = 0; },
  adminApi: vi.fn(async () => ({ items: [] })),
  startGenerateForDomainApi: (...a: unknown[]) => start(...a),
  getGenerationAttemptApi: (...a: unknown[]) => getAttempt(...a),
  listDomainsApi: async () => ({ items: [{ id: "d1", slug: "soc", name: "SOC", description: null, status: "active", display_order: 1 }], total: 1 }),
  listCategoriesApi: async () => ({ items: [cat("c1", "Cat one"), cat("c2", "Cat two")] }),
  createPlatformDomainApi: vi.fn(),
  createCategoryApi: vi.fn(),
  bulkUpdateQuestionStatus: vi.fn(),
  listQuestionsApi: async () => ({ items: [], total: 0 }),
  listGenerationAttempts: async () => ({ items: [] }),
  generateRubricApi: vi.fn(),
  saveRubricApi: vi.fn(),
  putGenerationBatchApi: async () => undefined,
  getActiveGenerationBatchApi: async () => null,
  setGenerationBatchStatusApi: async () => undefined,
}));
vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
}));
vi.mock("../components/mfa-step-up.js", () => ({ MfaStepUp: () => null }));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

import { AdminGenerateWizard } from "../pages/generate-wizard.js";

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { cleanup(); vi.useRealTimers(); start.mockReset(); getAttempt.mockReset(); });

async function clickGenerate(): Promise<void> {
  render(React.createElement(AdminGenerateWizard));
  const select = await screen.findByRole("combobox");
  await waitFor(() => expect(select.querySelectorAll("option").length).toBeGreaterThan(1));
  fireEvent.change(select, { target: { value: "d1" } });
  fireEvent.click(await screen.findByRole("button", { name: /Generate \d+ questions/ }));
}

describe("generate wizard polling (RW-93)", () => {
  it("starts, polls running -> success, then starts the next category", async () => {
    start.mockResolvedValue({ attempt_id: "a" });
    getAttempt
      .mockResolvedValueOnce(att("running"))
      .mockResolvedValueOnce(att("running"))
      .mockResolvedValue(att("success"));
    await clickGenerate();
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByTestId("gen-elapsed").textContent).toBe("0:03");
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(getAttempt.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("treats an early 404 as running, then proceeds", async () => {
    start.mockResolvedValue({ attempt_id: "a" });
    getAttempt
      .mockRejectedValueOnce(Object.assign(new Error("nf"), { status: 404 }))
      .mockResolvedValueOnce(att("running"))
      .mockResolvedValue(att("success"));
    await clickGenerate();
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  });

  it("shows the error on failed and continues with the next category", async () => {
    start.mockResolvedValue({ attempt_id: "a" });
    getAttempt
      .mockResolvedValueOnce(att("failed", { error_message: "AI generation already in flight" }))
      .mockImplementation(() => new Promise(() => undefined)); // 2nd category stays running
    await clickGenerate();
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/already in flight/)).toBeTruthy();
  });
});
