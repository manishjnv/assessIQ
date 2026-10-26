// EXP-6 tail: /admin/exam-blueprints — list, upkeep and a Create a test link. Synthetic data only.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router";

const api = vi.hoisted(() => ({
  listExamBlueprintsFullApi: vi.fn(),
  startFullMockApi: vi.fn(),
  markBlueprintCheckedApi: vi.fn(),
  saveBlueprintEditionApi: vi.fn(),
  archiveBlueprintApi: vi.fn(),
  listPlatformPublishedPacks: vi.fn(),
  getPackLevelsApi: vi.fn(),
}));
vi.mock("../api/exam-blueprints.js", () => ({
  listExamBlueprintsFullApi: api.listExamBlueprintsFullApi,
  startFullMockApi: api.startFullMockApi,
  markBlueprintCheckedApi: api.markBlueprintCheckedApi,
  saveBlueprintEditionApi: api.saveBlueprintEditionApi,
  archiveBlueprintApi: api.archiveBlueprintApi,
}));
vi.mock("../api.js", () => ({
  listPlatformPublishedPacks: api.listPlatformPublishedPacks,
  getPackLevelsApi: api.getPackLevelsApi,
  AdminApiError: class AdminApiError extends Error {
    apiError: { code: string; message: string };
    constructor(_s: number, e: { code: string; message: string }) { super(e.message); this.apiError = e; }
  },
}));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { AdminExamBlueprints } from "../pages/exam-blueprints.js";
import { AdminApiError } from "../api.js";

const BP = {
  id: "bp-1", stage_node_id: null, edition: "2099.1", name: "Sample Exam", total_minutes: 90, qualifying: true,
  verification_status: "unverified", source_note: null, total_questions: 30, total_marks: 60,
  max_questions: 100, owner_contact: "sme@example.test", archived_at: null, supersedes_id: null, last_checked_at: null, next_check_due: "2000-01-01",
  sections: [
    { position: 1, name: "Part A", subject_node_id: null, question_count: 20, marks_per_question: 2, negative_marks_per_question: 0.5,
      minutes: 60, sectional_timing: true, qualifying: true, cutoff_marks: 20, calculator_allowed: false, allowed_types: ["mcq"] },
    { position: 2, name: "Part B", subject_node_id: null, question_count: 10, marks_per_question: 2, negative_marks_per_question: 0,
      minutes: 30, sectional_timing: true, qualifying: false, cutoff_marks: null, calculator_allowed: false, allowed_types: ["mcq"] },
  ],
};

function setup(items: unknown[] = [BP]) {
  api.listExamBlueprintsFullApi.mockResolvedValue({ items });
  api.listPlatformPublishedPacks.mockResolvedValue({ packs: [{ id: "pk-1", name: "Sample Set", domain: "demo", status: "published" }] });
  api.getPackLevelsApi.mockResolvedValue({ levels: [{ id: "lv-1", order: 1 }] });
  render(<MemoryRouter><AdminExamBlueprints /></MemoryRouter>);
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("AdminExamBlueprints", () => {
  it("lists each section with questions, marks, negative marks, minutes and qualifying", async () => {
    setup();
    await screen.findByRole("heading", { name: "Sample Exam" });
    const table = screen.getByRole("table", { name: "Sections of Sample Exam" });
    const rowA = screen.getByRole("rowheader", { name: "Part A" }).closest("tr")!;
    expect(rowA.textContent).toContain("20");
    expect(rowA.textContent).toContain("0.5");
    expect(rowA.textContent).toContain("60");
    expect(rowA.textContent).toContain("Yes, cut-off 20");
    expect(table.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(screen.getByText("Unverified")).toBeTruthy();
  });

  it("shows an empty message when there are no blueprints", async () => {
    setup([]);
    await screen.findByText("No exam blueprints yet.");
  });

  it("CT-3: each pattern links to Create a test with the pattern preselected (the old Start full mock form is gone)", async () => {
    setup();
    await screen.findByRole("heading", { name: "Sample Exam" });
    expect(screen.getByRole("link", { name: "Create a test" }).getAttribute("href")).toBe("/admin/create-test?exam=bp-1");
    expect(screen.queryByRole("button", { name: "Start full mock" })).toBeNull();
  });

  it("CT-1: shows the upkeep dates and a due notice; Mark checked sends the note and reloads", async () => {
    setup();
    await screen.findByRole("heading", { name: "Sample Exam" });
    expect(screen.getByText(/Last checked: never. Next check due: 2000-01-01. Owner: sme@example.test. Cap: 100 questions./)).toBeTruthy();
    expect(screen.getByText(/1 exam pattern is due for the monthly check/)).toBeTruthy();
    api.markBlueprintCheckedApi.mockResolvedValue({});
    fireEvent.click(screen.getByRole("button", { name: "Mark checked" }));
    fireEvent.change(screen.getByLabelText("Note (optional)"), { target: { value: "Same as the 2026 notice" } });
    fireEvent.click(screen.getByRole("button", { name: "Save check" }));
    await waitFor(() => expect(api.markBlueprintCheckedApi).toHaveBeenCalledWith("bp-1", "Same as the 2026 notice"));
    await waitFor(() => expect(api.listExamBlueprintsFullApi).toHaveBeenCalledTimes(2));
  });

  it("CT-1: New edition needs a new label and sends the whole pattern with the changed counts", async () => {
    setup();
    await screen.findByRole("heading", { name: "Sample Exam" });
    fireEvent.click(screen.getByRole("button", { name: "New edition" }));
    const save = screen.getByRole("button", { name: "Save new edition" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("New edition label"), { target: { value: "2100.1" } });
    fireEvent.change(screen.getByLabelText("Part B: questions"), { target: { value: "12" } });
    fireEvent.click(screen.getByLabelText(/I checked this against the official notice/));
    expect(save.disabled).toBe(false);
    api.saveBlueprintEditionApi.mockResolvedValue({});
    fireEvent.click(save);
    await waitFor(() => expect(api.saveBlueprintEditionApi).toHaveBeenCalledTimes(1));
    const [id, body] = api.saveBlueprintEditionApi.mock.calls[0]!;
    expect(id).toBe("bp-1");
    expect(body).toMatchObject({ edition: "2100.1", verification_status: "verified", max_questions: 100 });
    expect(body.sections.map((x: { question_count: number }) => x.question_count)).toEqual([20, 12]);
  });

  it("CT-1: Archive asks first, then calls the archive route; a refused confirm sends nothing", async () => {
    setup();
    await screen.findByRole("heading", { name: "Sample Exam" });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(api.archiveBlueprintApi).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    api.archiveBlueprintApi.mockResolvedValue({ archived: true });
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(api.archiveBlueprintApi).toHaveBeenCalledWith("bp-1"));
    confirm.mockRestore();
  });

  it("CT-1: the server message shows when the new edition is refused", async () => {
    setup();
    await screen.findByRole("heading", { name: "Sample Exam" });
    fireEvent.click(screen.getByRole("button", { name: "New edition" }));
    fireEvent.change(screen.getByLabelText("New edition label"), { target: { value: "2100.2" } });
    api.saveBlueprintEditionApi.mockRejectedValue(new AdminApiError(400, { code: "DUPLICATE", message: "a blueprint for this stage and edition exists" }));
    fireEvent.click(screen.getByRole("button", { name: "Save new edition" }));
    expect((await screen.findByRole("alert")).textContent).toBe("a blueprint for this stage and edition exists");
  });
});
