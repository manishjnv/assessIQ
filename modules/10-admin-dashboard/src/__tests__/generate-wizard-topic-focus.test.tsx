// RW-46 — generate wizard "Topic focus" field.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const generate = vi.fn();

vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../api.js", () => ({
  AdminApiError: class AdminApiError extends Error {},
  adminApi: vi.fn(async () => ({ items: [] })),
  startGenerateForDomainApi: (...a: unknown[]) => generate(...a),
  getGenerationAttemptApi: async () => ({ id: "a1", status: "success", count_requested: 2, count_inserted: 2, error_code: null, error_message: null }),
  listDomainsApi: async () => ({ items: [{ id: "d1", slug: "soc", name: "SOC", description: null, status: "active", display_order: 1 }], total: 1 }),
  listCategoriesApi: async () => ({ items: [{ id: "c1", domain_id: "d1", slug: "c", name: "Cat one", description: null, relevance_score: 1, default_selected: true, supported_types: ["mcq"], default_question_count: 2, status: "active" }] }),
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

afterEach(() => { cleanup(); generate.mockReset(); });

async function setup(): Promise<HTMLButtonElement> {
  generate.mockResolvedValue({ attempt_id: "a1" });
  render(React.createElement(AdminGenerateWizard));
  const select = await screen.findByRole("combobox");
  await waitFor(() => expect(select.querySelectorAll("option").length).toBeGreaterThan(1));
  fireEvent.change(select, { target: { value: "d1" } });
  return (await screen.findByRole("button", { name: /Generate \d+ questions/ })) as HTMLButtonElement;
}

describe("generate wizard topic focus", () => {
  it("sends topic_focus when typed", async () => {
    const btn = await setup();
    fireEvent.change(screen.getByLabelText(/Topic focus/), { target: { value: "  phishing triage " } });
    fireEvent.click(btn);
    await waitFor(() => expect(generate).toHaveBeenCalled());
    expect(generate.mock.calls[0]![2]).toMatchObject({ topic_focus: "phishing triage" });
  });

  it("sends no topic_focus key when empty", async () => {
    const btn = await setup();
    fireEvent.click(btn);
    await waitFor(() => expect(generate).toHaveBeenCalled());
    expect("topic_focus" in (generate.mock.calls[0]![2] as object)).toBe(false);
  });

  it("blocks input over 200 characters with a message", async () => {
    const btn = await setup();
    fireEvent.change(screen.getByLabelText(/Topic focus/), { target: { value: "a".repeat(201) } });
    expect(screen.getByText(/too long/)).toBeTruthy();
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(generate).not.toHaveBeenCalled();
  });
});
