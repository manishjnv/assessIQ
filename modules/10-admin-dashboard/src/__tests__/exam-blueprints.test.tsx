// EXP-6 tail: /admin/exam-blueprints — list, upkeep, and the super-admin editor (create, edit, delete). Synthetic data only.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
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
  adminApi: vi.fn(),
}));
const sess = vi.hoisted(() => ({ role: "super_admin" as "super_admin" | "admin" }));
vi.mock("../api/exam-blueprints.js", () => ({
  listExamBlueprintsFullApi: api.listExamBlueprintsFullApi,
  startFullMockApi: api.startFullMockApi,
  markBlueprintCheckedApi: api.markBlueprintCheckedApi,
  saveBlueprintEditionApi: api.saveBlueprintEditionApi,
  archiveBlueprintApi: api.archiveBlueprintApi,
}));
vi.mock("../api.js", () => ({
  adminApi: api.adminApi,
  listPlatformPublishedPacks: api.listPlatformPublishedPacks,
  getPackLevelsApi: api.getPackLevelsApi,
  AdminApiError: class AdminApiError extends Error {
    apiError: { code: string; message: string };
    status: number;
    constructor(s: number, e: { code: string; message: string }) { super(e.message); this.status = s; this.apiError = e; }
  },
}));
vi.mock("../session.js", () => ({
  useAdminSession: () => ({
    session: { user: { id: "u-1", email: null, name: null, role: sess.role }, tenant: { id: "t-1", slug: null }, mfaStatus: "verified" },
    loading: false,
  }),
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

/** Fills the pattern fields of the open form (create or edit) and returns the form element. */
function openForm(label: string): HTMLElement {
  return screen.getByRole("form", { name: label });
}

beforeEach(() => { sess.role = "super_admin"; });
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

  it("CT-1: the server message shows when the new edition is refused", async () => {
    setup();
    await screen.findByRole("heading", { name: "Sample Exam" });
    fireEvent.click(screen.getByRole("button", { name: "New edition" }));
    fireEvent.change(screen.getByLabelText("New edition label"), { target: { value: "2100.2" } });
    api.saveBlueprintEditionApi.mockRejectedValue(new AdminApiError(400, { code: "DUPLICATE", message: "a blueprint for this stage and edition exists" }));
    fireEvent.click(screen.getByRole("button", { name: "Save new edition" }));
    expect((await screen.findByRole("alert")).textContent).toBe("a blueprint for this stage and edition exists");
  });

  describe("super-admin editor", () => {
    it("shows New pattern, Edit and Delete to a super admin", async () => {
      setup();
      await screen.findByRole("heading", { name: "Sample Exam" });
      expect(screen.getByRole("button", { name: "New pattern" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    });

    it("hides New pattern, Edit and Delete from other admins", async () => {
      sess.role = "admin";
      setup();
      await screen.findByRole("heading", { name: "Sample Exam" });
      expect(screen.queryByRole("button", { name: "New pattern" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
      expect(screen.getByRole("button", { name: "Mark checked" })).toBeTruthy();
    });

    it("invalid input shows the messages and sends nothing", async () => {
      setup();
      await screen.findByRole("heading", { name: "Sample Exam" });
      fireEvent.click(screen.getByRole("button", { name: "New pattern" }));
      const form = openForm("New exam pattern");
      fireEvent.click(within(form).getByRole("button", { name: "Save pattern" }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Type a pattern name of up to 120 characters.");
      expect(alert.textContent).toContain("Total minutes must be a whole number from 1 to 600.");
      expect(alert.textContent).toContain("Section 1: type a name of up to 80 characters.");
      expect(api.adminApi).not.toHaveBeenCalled();
    });

    it("the section rules: a cut-off needs Qualifying, and the sections cannot go over the cap", async () => {
      setup();
      await screen.findByRole("heading", { name: "Sample Exam" });
      fireEvent.click(screen.getByRole("button", { name: "New pattern" }));
      const form = openForm("New exam pattern");
      fireEvent.change(within(form).getByLabelText("Pattern name"), { target: { value: "Sample Two" } });
      fireEvent.change(within(form).getByLabelText("Edition label"), { target: { value: "2101.1" } });
      fireEvent.change(within(form).getByLabelText("Total minutes"), { target: { value: "60" } });
      fireEvent.change(within(form).getByLabelText("Question cap"), { target: { value: "15" } });
      const sec = within(within(form).getByRole("group", { name: "Section 1" }));
      fireEvent.change(sec.getByLabelText("Section name"), { target: { value: "Part A" } });
      fireEvent.change(sec.getByLabelText("Questions"), { target: { value: "20" } });
      fireEvent.change(sec.getByLabelText("Marks per question"), { target: { value: "2" } });
      fireEvent.change(sec.getByLabelText("Cut-off mark"), { target: { value: "5" } });
      fireEvent.click(within(form).getByRole("button", { name: "Save pattern" }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Section 1: a cut-off mark needs Qualifying section to be ticked.");
      expect(alert.textContent).toContain("The sections add up to 20 questions, above the cap of 15.");
      expect(api.adminApi).not.toHaveBeenCalled();
    });

    it("create sends POST /admin/blueprints with the typed fields, then reloads", async () => {
      setup();
      await screen.findByRole("heading", { name: "Sample Exam" });
      fireEvent.click(screen.getByRole("button", { name: "New pattern" }));
      const form = openForm("New exam pattern");
      fireEvent.change(within(form).getByLabelText("Pattern name"), { target: { value: "Sample New" } });
      fireEvent.change(within(form).getByLabelText("Edition label"), { target: { value: "2101.1" } });
      fireEvent.change(within(form).getByLabelText("Total minutes"), { target: { value: "60" } });
      const sec = within(within(form).getByRole("group", { name: "Section 1" }));
      fireEvent.change(sec.getByLabelText("Section name"), { target: { value: "Part A" } });
      fireEvent.change(sec.getByLabelText("Questions"), { target: { value: "10" } });
      fireEvent.change(sec.getByLabelText("Marks per question"), { target: { value: "1" } });
      api.adminApi.mockResolvedValue({ id: "bp-new" });
      fireEvent.click(within(form).getByRole("button", { name: "Save pattern" }));
      await waitFor(() => expect(api.adminApi).toHaveBeenCalledTimes(1));
      const [path, init] = api.adminApi.mock.calls[0]!;
      expect(path).toBe("/admin/blueprints");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({
        stage_node_id: null, edition: "2101.1", name: "Sample New", total_minutes: 60, qualifying: false,
        verification_status: "unverified", max_questions: 100, owner_contact: null, source_note: null,
      });
      expect(body.sections).toEqual([expect.objectContaining({ name: "Part A", question_count: 10, marks_per_question: 1, negative_marks_per_question: 0, minutes: null, allowed_types: ["mcq"] })]);
      await waitFor(() => expect(api.listExamBlueprintsFullApi).toHaveBeenCalledTimes(2));
    });

    it("edit sends PUT /blueprints/:id with the changed name and the stored sections", async () => {
      setup();
      await screen.findByRole("heading", { name: "Sample Exam" });
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      const form = openForm("Edit Sample Exam 2099.1");
      fireEvent.change(within(form).getByLabelText("Pattern name"), { target: { value: "Sample Exam Revised" } });
      api.saveBlueprintEditionApi.mockResolvedValue({});
      fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(api.saveBlueprintEditionApi).toHaveBeenCalledTimes(1));
      const [id, body] = api.saveBlueprintEditionApi.mock.calls[0]!;
      expect(id).toBe("bp-1");
      expect(body).toMatchObject({ name: "Sample Exam Revised", edition: "2099.1", total_minutes: 90, stage_node_id: null, verification_status: "unverified" });
      expect(body.sections.map((s: { name: string }) => s.name)).toEqual(["Part A", "Part B"]);
      expect(body.sections[0]).toMatchObject({ question_count: 20, marks_per_question: 2, negative_marks_per_question: 0.5, minutes: 60, sectional_timing: true, cutoff_marks: 20 });
    });

    it("editing a verified pattern with the same label is refused before any request", async () => {
      api.listExamBlueprintsFullApi.mockResolvedValue({ items: [{ ...BP, verification_status: "verified" }] });
      setup([{ ...BP, verification_status: "verified" }]);
      await screen.findByRole("heading", { name: "Sample Exam" });
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      const form = openForm("Edit Sample Exam 2099.1");
      fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));
      expect((await screen.findByRole("alert")).textContent).toContain("A verified edition needs a new edition label to save a change.");
      expect(api.saveBlueprintEditionApi).not.toHaveBeenCalled();
    });

    it("Delete asks in the page first; Keep pattern sends nothing; Confirm delete calls the archive route", async () => {
      setup();
      await screen.findByRole("heading", { name: "Sample Exam" });
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
      const box = screen.getByRole("group", { name: "Delete Sample Exam 2099.1" });
      expect(box.textContent).toContain("Nothing is erased");
      fireEvent.click(within(box).getByRole("button", { name: "Keep pattern" }));
      expect(api.archiveBlueprintApi).not.toHaveBeenCalled();
      expect(screen.queryByRole("group", { name: "Delete Sample Exam 2099.1" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
      api.archiveBlueprintApi.mockResolvedValue({ archived: true });
      fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
      await waitFor(() => expect(api.archiveBlueprintApi).toHaveBeenCalledWith("bp-1"));
      expect(confirm).not.toHaveBeenCalled();
      confirm.mockRestore();
    });
  });
});
