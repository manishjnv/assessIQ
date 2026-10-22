// RW-96 — difficulty warnings in the generate wizard Review step.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import React from "react";

const drafts = vi.hoisted(() => ({ items: [] as unknown[] }));

vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../api.js", () => ({
  AdminApiError: class AdminApiError extends Error {},
  adminApi: vi.fn(async () => ({ items: [] })),
  startGenerateForDomainApi: vi.fn(),
  getGenerationAttemptApi: vi.fn(),
  listDomainsApi: async () => ({ items: [], total: 0 }),
  listCategoriesApi: async () => ({ items: [] }),
  createPlatformDomainApi: vi.fn(),
  createCategoryApi: vi.fn(),
  bulkUpdateQuestionStatus: vi.fn(),
  listQuestionsApi: async () => ({ items: drafts.items, total: drafts.items.length }),
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

afterEach(() => { cleanup(); });

function draft(id: string, params: Record<string, unknown> | null) {
  return { id, type: "mcq", topic: `T ${id}`, status: "ai_draft", points: 1, content: {}, rubric: null, level_id: "l1", level_label: "L1", domain_id: null, category_id: null, difficulty_params: params };
}

async function openReview(): Promise<void> {
  render(React.createElement(AdminGenerateWizard));
  fireEvent.click(await screen.findByRole("button", { name: "Review drafts" }));
  await screen.findByText(/Review AI Drafts/);
}

describe("generate wizard review warnings (RW-96)", () => {
  it("shows a chip with codes in the title and a header count", async () => {
    drafts.items = [
      draft("a", { warnings: [{ code: "MCQ_STEM_OVERLAP", message: "overlap" }, { code: "LOG_LINES_OUT_OF_RANGE", message: "too few" }] }),
      draft("b", null),
    ];
    await openReview();
    const chip = await screen.findByText("2 warnings");
    expect(chip.getAttribute("title")).toBe("MCQ_STEM_OVERLAP: overlap\nLOG_LINES_OUT_OF_RANGE: too few");
    expect(chip.getAttribute("data-help-id")).toBe("admin.generate_wizard.review_warnings");
    expect(screen.getByText("1 draft with warnings")).toBeTruthy();
  });

  it("shows nothing when no draft has warnings", async () => {
    drafts.items = [draft("a", { warnings: [] }), draft("b", null)];
    await openReview();
    await screen.findByText("T a");
    expect(screen.queryByText(/warning/)).toBeNull();
  });
});
