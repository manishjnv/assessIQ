// RW-58: super-admin question import page.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import React from "react";

const upload = vi.fn();
const commit = vi.fn();
let role = "super_admin";

vi.mock("../api.js", () => ({
  adminApi: vi.fn(),
  AdminApiError: class AdminApiError extends Error {},
  listDomainsApi: vi.fn().mockResolvedValue({ items: [{ id: "d1", slug: "security", name: "Security" }], total: 1 }),
}));
vi.mock("../api/question-imports.js", () => ({
  IMPORT_MAX_BYTES: 4 * 1024 * 1024,
  uploadImportApi: (...a: unknown[]) => upload(...a),
  commitImportApi: (...a: unknown[]) => commit(...a),
  discardImportApi: vi.fn(),
  fixImportRowApi: vi.fn(),
  getImportApi: vi.fn(),
  downloadImportTemplate: vi.fn(),
}));
vi.mock("../session.js", () => ({ useAdminSession: () => ({ session: { user: { id: "u", role } }, loading: false }) }));
vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
}));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => React.createElement("span", null, children),
}));

import { AdminQuestionImport } from "../pages/question-import.js";

const REPORT = {
  importId: "imp-1",
  status: "staged",
  counts: { total: 2, ok: 1, error: 1, duplicate: 0, skip: 0 },
  rows: [
    { row: 1, decision: "ok", errors: [], raw: { prompt: "A" } },
    { row: 2, decision: "error", errors: [{ row: 2, column: "options", message: "At least two options" }], raw: { prompt: "B" } },
  ],
};

afterEach(() => { cleanup(); upload.mockReset(); commit.mockReset(); role = "super_admin"; });

async function uploadFile(): Promise<void> {
  render(<MemoryRouter><AdminQuestionImport /></MemoryRouter>);
  await screen.findByText("Security");
  fireEvent.change(screen.getByLabelText("Subject *"), { target: { value: "security" } });
  const file = new File(["prompt\nA"], "q.csv", { type: "text/csv" });
  fireEvent.change(screen.getByLabelText(/^File [(]/), { target: { files: [file] } });
  fireEvent.click(screen.getByRole("button", { name: "Check file" }));
}

describe("Question import page", () => {
  it("shows counts and per-row errors after upload", async () => {
    upload.mockResolvedValue(REPORT);
    await uploadFile();
    expect(await screen.findByText("1 need a fix")).toBeTruthy();
    expect(screen.getByText("1 ready")).toBeTruthy();
    expect(screen.getByText(/options: At least two options/)).toBeTruthy();
    expect(upload.mock.calls[0]![0]).toMatchObject({ file_name: "q.csv", format: "csv", domain: "security" });
  });

  it("commits after confirm and shows the draft pack link", async () => {
    upload.mockResolvedValue(REPORT);
    commit.mockResolvedValue({ importId: "imp-1", packId: "pack-9", committed: 1 });
    await uploadFile();
    fireEvent.click(await screen.findByRole("button", { name: "Commit (skip errors)" }));
    expect(commit).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Add questions" }));
    await waitFor(() => expect(commit).toHaveBeenCalledWith("imp-1"));
    const link = await screen.findByRole("link", { name: "Open the draft question set" });
    expect(link.getAttribute("href")).toBe("/admin/question-bank/pack-9");
  });

  it("is blocked for a tenant admin", async () => {
    role = "admin";
    render(<MemoryRouter><AdminQuestionImport /></MemoryRouter>);
    expect(await screen.findByText("Only platform admins can import questions.")).toBeTruthy();
    expect(screen.queryByText("Import questions.")).toBeNull();
  });
});
