// EXP-17: organisation question upload page. Synthetic data only.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import React from "react";

const upload = vi.fn();
const commit = vi.fn();
const list = vi.fn();
const withdraw = vi.fn();

vi.mock("../api.js", () => ({
  listTenantPacksApi: () => Promise.resolve({ packs: [] }),
  getPackLevelsApi: () => Promise.resolve({ levels: [] }),
  adminApi: vi.fn(),
  AdminApiError: class AdminApiError extends Error {
    status: number;
    apiError: { code: string; message: string };
    constructor(status: number, apiError: { code: string; message: string }) { super(apiError.message); this.status = status; this.apiError = apiError; }
  },
  listDomainsApi: vi.fn().mockResolvedValue({ items: [{ id: "d1", slug: "maths", name: "Maths" }], total: 1 }),
}));
vi.mock("../api/question-imports.js", async () => {
  const { AdminApiError } = await import("../api.js");
  return {
    IMPORT_MAX_BYTES: 4 * 1024 * 1024,
    uploadOrgImportApi: (...a: unknown[]) => upload(...a),
    commitOrgImportApi: (...a: unknown[]) => commit(...a),
    discardOrgImportApi: vi.fn(),
    listOrgUploadsApi: () => list(),
    withdrawOrgUploadApi: (...a: unknown[]) => withdraw(...a),
    downloadOrgImportTemplate: vi.fn(),
    isTierLocked: (e: unknown) => e instanceof AdminApiError && e.status === 403 && e.apiError.code === "TIER_NOT_INCLUDED",
  };
});
vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
}));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => React.createElement("span", null, children),
}));

import { OrgQuestionUpload, ORG_UPLOAD_WARRANTY_TEXT } from "../pages/org-question-upload.js";
import { AdminApiError } from "../api.js";

const REPORT = {
  importId: "imp-1",
  status: "staged",
  counts: { total: 3, ok: 2, error: 1, duplicate: 0, skip: 0 },
  rows: [
    { row: 1, decision: "ok", errors: [], raw: {} },
    { row: 2, decision: "ok", errors: [], raw: {} },
    { row: 3, decision: "error", errors: [{ row: 3, column: "options", message: "At least two options" }], raw: {} },
  ],
};
const ITEM = {
  id: "imp-9", file_name: "set.csv", format: "csv", status: "committed", row_count: 2, error_count: 0,
  rights_status: "original", created_at: "2026-10-19T10:00:00Z", committed_pack_id: "pack-9", question_count: 2, withdrawn_count: 0,
};

afterEach(() => { cleanup(); upload.mockReset(); commit.mockReset(); list.mockReset(); withdraw.mockReset(); });

function fillForm(): void {
  const file = new File(["question\nWhat is 2 + 2?"], "q.csv", { type: "text/csv" });
  fireEvent.change(screen.getByLabelText(/^File, CSV or XLSX/), { target: { files: [file] } });
  fireEvent.change(screen.getByLabelText("Subject *"), { target: { value: "maths" } });
  fireEvent.change(screen.getByLabelText("Rights *"), { target: { value: "original" } });
}

describe("Organisation question upload page", () => {
  it("shows the Contact us panel instead of the form when the plan lacks the feature", async () => {
    list.mockRejectedValue(new AdminApiError(403, { code: "TIER_NOT_INCLUDED", message: "no" }));
    render(<MemoryRouter><OrgQuestionUpload /></MemoryRouter>);
    expect(await screen.findByText("Question upload is not in your plan.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check file" })).toBeNull();
  });

  it("keeps Check file disabled until the warranty is ticked, then shows the preview without committing", async () => {
    list.mockResolvedValue({ items: [] });
    upload.mockResolvedValue(REPORT);
    render(<MemoryRouter><OrgQuestionUpload /></MemoryRouter>);
    await screen.findByText("Maths");
    expect(screen.getByLabelText(ORG_UPLOAD_WARRANTY_TEXT)).toBeTruthy();
    const check = screen.getByRole("button", { name: "Check file" }) as HTMLButtonElement;
    expect(check.disabled).toBe(true);
    fillForm();
    fireEvent.click(screen.getByLabelText(ORG_UPLOAD_WARRANTY_TEXT));
    expect(check.disabled).toBe(false);
    fireEvent.click(check);
    expect(await screen.findByText("2 valid")).toBeTruthy();
    expect(screen.getByText("1 with problems")).toBeTruthy();
    expect(screen.getByText("options: At least two options")).toBeTruthy();
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ rights_status: "original", domain: "maths", format: "csv" }));
    expect(commit).not.toHaveBeenCalled();
  });

  it("commits only on the second click and shows the result", async () => {
    list.mockResolvedValue({ items: [] });
    upload.mockResolvedValue(REPORT);
    commit.mockResolvedValue({ importId: "imp-1", packId: "pack-1", committed: 2 });
    render(<MemoryRouter><OrgQuestionUpload /></MemoryRouter>);
    await screen.findByText("Maths");
    fillForm();
    fireEvent.click(screen.getByLabelText(ORG_UPLOAD_WARRANTY_TEXT));
    fireEvent.click(screen.getByRole("button", { name: "Check file" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add 2 questions" }));
    expect(await screen.findByText("Done. 2 questions added.")).toBeTruthy();
    expect(commit).toHaveBeenCalledWith("imp-1");
  });

  it("withdraws an upload after the confirm step", async () => {
    list.mockResolvedValue({ items: [ITEM] });
    withdraw.mockResolvedValue({ importId: "imp-9", withdrawn: 2 });
    render(<MemoryRouter><OrgQuestionUpload /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw upload set.csv" }));
    expect(withdraw).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(withdraw).toHaveBeenCalledWith("imp-9"));
    expect(await screen.findByText("2 questions withdrawn.")).toBeTruthy();
  });
});
