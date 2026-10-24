// EXP-6 tail: /admin/exam-blueprints — read-only list plus "Start full mock". Synthetic data only.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router";

const api = vi.hoisted(() => ({
  listExamBlueprintsFullApi: vi.fn(),
  startFullMockApi: vi.fn(),
  listPlatformPublishedPacks: vi.fn(),
  getPackLevelsApi: vi.fn(),
}));
vi.mock("../api/exam-blueprints.js", () => ({
  listExamBlueprintsFullApi: api.listExamBlueprintsFullApi,
  startFullMockApi: api.startFullMockApi,
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

  it("starts a full mock from the chosen set and level, then shows the draft id", async () => {
    setup();
    await screen.findByRole("heading", { name: "Sample Exam" });
    const toggle = screen.getByRole("button", { name: "Start full mock" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await screen.findByRole("option", { name: "Sample Set" });
    fireEvent.change(screen.getByLabelText("Question set"), { target: { value: "pk-1" } });
    await screen.findByRole("option", { name: "Level 1" });
    fireEvent.change(screen.getByLabelText("Level"), { target: { value: "lv-1" } });
    api.startFullMockApi.mockResolvedValue({ assessment: { id: "as-9" }, warnings: ["This blueprint is not verified."] });
    fireEvent.click(screen.getByRole("button", { name: "Create draft mock" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("as-9"));
    expect(api.startFullMockApi).toHaveBeenCalledWith("bp-1", expect.objectContaining({ pack_id: "pk-1", level_id: "lv-1" }));
    expect(screen.getByText("This blueprint is not verified.")).toBeTruthy();
  });

  it("EXP-35: chosen subjects and a smaller size send section_positions and scale_percent", async () => {
    setup();
    await screen.findByRole("heading", { name: "Sample Exam" });
    fireEvent.click(screen.getByRole("button", { name: "Start full mock" }));
    await screen.findByRole("option", { name: "Sample Set" });
    fireEvent.change(screen.getByLabelText("Question set"), { target: { value: "pk-1" } });
    await screen.findByRole("option", { name: "Level 1" });
    fireEvent.change(screen.getByLabelText("Level"), { target: { value: "lv-1" } });
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "subjects" } });
    const create = screen.getByRole("button", { name: "Create draft mock" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true); // no subject ticked yet
    fireEvent.click(screen.getByLabelText("Part B"));
    fireEvent.change(screen.getByLabelText("Size"), { target: { value: "50" } });
    expect(create.disabled).toBe(false);
    api.startFullMockApi.mockResolvedValue({ assessment: { id: "as-10" }, warnings: [] });
    fireEvent.click(create);
    await waitFor(() => expect(api.startFullMockApi).toHaveBeenCalledWith("bp-1", expect.objectContaining({ section_positions: [1], scale_percent: 50 })));
  });

  it("shows the server message when the mock cannot be created", async () => {
    setup();
    await screen.findByRole("heading", { name: "Sample Exam" });
    fireEvent.click(screen.getByRole("button", { name: "Start full mock" }));
    await screen.findByRole("option", { name: "Sample Set" });
    fireEvent.change(screen.getByLabelText("Question set"), { target: { value: "pk-1" } });
    await screen.findByRole("option", { name: "Level 1" });
    fireEvent.change(screen.getByLabelText("Level"), { target: { value: "lv-1" } });
    api.startFullMockApi.mockRejectedValue(new AdminApiError(400, { code: "INVALID_PARAM", message: "opens_at is in the past" }));
    fireEvent.click(screen.getByRole("button", { name: "Create draft mock" }));
    expect((await screen.findByRole("alert")).textContent).toBe("opens_at is in the past");
  });
});
