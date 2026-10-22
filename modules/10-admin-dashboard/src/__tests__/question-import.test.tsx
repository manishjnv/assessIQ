// RW-58: super-admin question import page.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import React from "react";

const upload = vi.fn();
const commit = vi.fn();
const listQ = vi.fn();
const genRubric = vi.fn();
const saveRubric = vi.fn();
let role = "super_admin";

vi.mock("../api.js", () => ({
  adminApi: vi.fn(),
  AdminApiError: class AdminApiError extends Error {
    status: number;
    apiError: { code: string; message: string };
    constructor(status: number, apiError: { code: string; message: string }) { super(apiError.message); this.status = status; this.apiError = apiError; }
  },
  listQuestionsApi: (...a: unknown[]) => listQ(...a),
  generateRubricApi: (...a: unknown[]) => genRubric(...a),
  saveRubricApi: (...a: unknown[]) => saveRubric(...a),
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
import { AdminApiError } from "../api.js";

const REPORT = {
  importId: "imp-1",
  status: "staged",
  counts: { total: 2, ok: 1, error: 1, duplicate: 0, skip: 0 },
  rows: [
    { row: 1, decision: "ok", errors: [], raw: { prompt: "A" } },
    { row: 2, decision: "error", errors: [{ row: 2, column: "options", message: "At least two options" }], raw: { prompt: "B" } },
  ],
};

afterEach(() => { cleanup(); upload.mockReset(); commit.mockReset(); listQ.mockReset(); genRubric.mockReset(); saveRubric.mockReset(); role = "super_admin"; });

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

  async function commitWithRubricless(): Promise<void> {
    upload.mockResolvedValue(REPORT);
    commit.mockResolvedValue({ importId: "imp-1", packId: "pack-9", committed: 3 });
    listQ.mockResolvedValue({ total: 3, items: [
      { id: "q1", type: "subjective", topic: "Phishing", rubric: null },
      { id: "q2", type: "scenario", topic: null, rubric: {} },
      { id: "q3", type: "mcq", topic: "X", rubric: null },
    ] });
    await uploadFile();
    fireEvent.click(await screen.findByRole("button", { name: "Commit (skip errors)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add questions" }));
  }

  it("offers Draft rubrics after commit and drafts each question in order", async () => {
    genRubric.mockResolvedValue({ proposal: { p: 1 } });
    saveRubric.mockResolvedValue({});
    await commitWithRubricless();
    expect(await screen.findByText("2 imported questions have no rubric.")).toBeTruthy();
    expect(listQ).toHaveBeenCalledWith({ pack_id: "pack-9", pageSize: 500 });
    fireEvent.click(screen.getByRole("button", { name: "Draft rubrics" }));
    await waitFor(() => expect(saveRubric).toHaveBeenCalledTimes(2));
    expect(genRubric.mock.calls.map((c) => c[0])).toEqual(["q1", "q2"]);
    expect(saveRubric.mock.calls.map((c) => c[0])).toEqual(["q1", "q2"]);
    expect(saveRubric).toHaveBeenCalledWith("q1", { p: 1 });
  });

  it("stops with a busy message when the AI is busy", async () => {
    genRubric.mockRejectedValue(new AdminApiError(409, { code: "AIG_GRADING_IN_PROGRESS", message: "busy" }));
    await commitWithRubricless();
    await screen.findByText("2 imported questions have no rubric.");
    fireEvent.click(screen.getByRole("button", { name: "Draft rubrics" }));
    expect(await screen.findByText("The AI is busy. Try again in a moment.")).toBeTruthy();
    expect(genRubric).toHaveBeenCalledTimes(1);
    expect(saveRubric).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Draft rubrics" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("is blocked for a tenant admin", async () => {
    role = "admin";
    render(<MemoryRouter><AdminQuestionImport /></MemoryRouter>);
    expect(await screen.findByText("Only platform admins can import questions.")).toBeTruthy();
    expect(screen.queryByText("Import questions.")).toBeNull();
  });
});
