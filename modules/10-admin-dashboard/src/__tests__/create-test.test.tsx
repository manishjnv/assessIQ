// CT-2 "Create a test" page — api modules mocked. Synthetic data only.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router";

const api = vi.hoisted(() => ({
  getAvailableSets: vi.fn(), listExamBlueprintsApi: vi.fn(), getPackLevelsApi: vi.fn(), importLicensedSet: vi.fn(), createTestApi: vi.fn(),
}));
vi.mock("../components/FrameworkTreePicker.js", () => ({
  FrameworkTreePicker: ({ onChange }: { onChange: (ids: string[], nodes: unknown[], lookup: Map<string, { label: string }>) => void }) => (
    <button type="button" onClick={() => onChange(["n1", "n2", "n3"], [], new Map([["n1", { label: "Percentages" }], ["n2", { label: "Series" }], ["n3", { label: "Ratios" }]]))}>Pick topics</button>
  ),
}));
vi.mock("../api.js", () => ({
  getAvailableSets: api.getAvailableSets, listExamBlueprintsApi: api.listExamBlueprintsApi,
  getPackLevelsApi: api.getPackLevelsApi, importLicensedSet: api.importLicensedSet,
  AdminApiError: class AdminApiError extends Error {
    apiError: { code: string; message: string };
    constructor(_s: number, e: { code: string; message: string }) { super(e.message); this.apiError = e; }
  },
}));
vi.mock("../api/create-test.js", () => ({ createTestApi: api.createTestApi }));
vi.mock("../api/camera.js", () => ({
  getCameraSettingsApi: vi.fn().mockResolvedValue({ isSchool: false, cameraEnabled: true, cameraEnforced: true }),
}));
vi.mock("@assessiq/help-system/components", () => ({ HelpTip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("../components/AdminShell.js", () => ({ AdminShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { AdminCreateTest, evenSplit } from "../pages/create-test.js";
import { AdminApiError } from "../api.js";

const SET = { source_pack_id: "p1", name: "Aptitude", domain: "apt", source_version: 1, question_count: 500, level_count: 2, level_minutes: [45, 60], cloned: true, cloned_pack_id: "c1", update_available: false };
const EXAM = { id: "bp1", name: "SSC CGL", edition: "current", total_questions: 100, total_minutes: 60, verification_status: "verified", sections: [{ name: "Reasoning" }, { name: "Quant" }] };

async function setup() {
  api.getAvailableSets.mockResolvedValue({ sets: [SET] });
  api.listExamBlueprintsApi.mockResolvedValue({ items: [EXAM] });
  api.importLicensedSet.mockResolvedValue({ cloned_pack_id: "c1" });
  api.getPackLevelsApi.mockResolvedValue({ levels: [{ id: "lv1", order: 1 }, { id: "lv2", order: 2 }] });
  api.createTestApi.mockResolvedValue({ assessment: { id: "as1" }, warnings: [] });
  render(<MemoryRouter><AdminCreateTest /></MemoryRouter>);
  await screen.findByRole("option", { name: /Aptitude/ });
}
const chooseSet = () => fireEvent.change(screen.getByLabelText("Question set"), { target: { value: "p1" } });
const save = () => screen.getByRole("button", { name: "Save as draft" });

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("evenSplit", () => {
  it("shares the total, remainder to the first rows", () => {
    expect(evenSplit(10, 3)).toEqual([4, 3, 3]);
    expect(evenSplit(5, 0)).toEqual([]);
  });
});

describe("Create a test", () => {
  it("whole set happy path sends cover, type and settings, then shows Draft saved", async () => {
    await setup();
    chooseSet();
    fireEvent.change(await screen.findByLabelText(/Number of questions/), { target: { value: "40" } });
    fireEvent.click(screen.getByRole("radio", { name: "Mock" }));
    fireEvent.change(screen.getByLabelText("Time limit (minutes)"), { target: { value: "50" } });
    fireEvent.click(save());
    await screen.findByText("Draft saved.");
    expect(api.importLicensedSet).toHaveBeenCalledWith("p1");
    const body = api.createTestApi.mock.calls[0]![0];
    expect(body).toMatchObject({
      pack_id: "c1", level_id: "lv1", cover: { kind: "whole", question_count: 40 }, minutes: 50,
      delivery_mode: "mock", camera_required: false,
      settings: { integrity: { fullscreen: false, block_copy_paste: false }, feedback_level: "none" },
    });
    expect(screen.getByRole("link", { name: /Open assessment/ }).getAttribute("href")).toBe("/admin/assessments/as1");
  });

  it("Real + camera sends camera_required with integrity on (moved from Start a test, CT-3)", async () => {
    await setup();
    chooseSet();
    await screen.findByLabelText(/Number of questions/);
    fireEvent.click(screen.getByRole("radio", { name: "Real + camera" }));
    fireEvent.click(save());
    await waitFor(() => expect(api.createTestApi).toHaveBeenCalled());
    const body = api.createTestApi.mock.calls[0]![0];
    expect(body).toMatchObject({ delivery_mode: "real", camera_required: true });
    expect(body.settings.integrity).toEqual({ fullscreen: true, block_copy_paste: true });
  });

  it("Real forces the integrity settings on", async () => {
    await setup();
    chooseSet();
    await screen.findByLabelText(/Number of questions/);
    fireEvent.click(save());
    await waitFor(() => expect(api.createTestApi).toHaveBeenCalled());
    expect(api.createTestApi.mock.calls[0]![0].settings.integrity).toEqual({ fullscreen: true, block_copy_paste: true });
    expect(api.createTestApi.mock.calls[0]![0].delivery_mode).toBe("real");
  });

  it("topics: even split first, uneven edit, total follows, cap blocks saving", async () => {
    await setup();
    chooseSet();
    fireEvent.click(screen.getByRole("radio", { name: "Chosen topics" }));
    fireEvent.click(screen.getByRole("button", { name: "Pick topics" }));
    const box = (n: string) => screen.getByLabelText(`Questions for ${n}`) as HTMLInputElement;
    expect([box("Percentages").value, box("Series").value, box("Ratios").value]).toEqual(["20", "20", "20"]);
    fireEvent.change(box("Percentages"), { target: { value: "30" } });
    screen.getByText("Total 70 of 100");
    fireEvent.change(box("Series"), { target: { value: "90" } });
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    screen.getByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Split evenly" }));
    expect(box("Series").value).toBe("33"); // total capped at 100 then shared
    fireEvent.click(screen.getByRole("button", { name: "Remove Ratios" }));
    fireEvent.change(box("Percentages"), { target: { value: "30" } });
    fireEvent.change(box("Series"), { target: { value: "5" } });
    fireEvent.click(save());
    await waitFor(() => expect(api.createTestApi).toHaveBeenCalled());
    expect(api.createTestApi.mock.calls[0]![0].cover).toEqual({ kind: "topics", topics: [{ node_id: "n1", count: 30 }, { node_id: "n2", count: 5 }] });
  });

  it("pattern: chosen subjects and a smaller size are sent; no time limit field", async () => {
    await setup();
    fireEvent.change(screen.getByLabelText("Exam"), { target: { value: "bp1" } });
    chooseSet();
    await screen.findByRole("radio", { name: "Exam pattern" });
    expect(screen.queryByLabelText("Time limit (minutes)")).toBeNull();
    fireEvent.change(screen.getByLabelText("Sections"), { target: { value: "subjects" } });
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Quant"));
    fireEvent.change(screen.getByLabelText("Size"), { target: { value: "50" } });
    fireEvent.click(save());
    await waitFor(() => expect(api.createTestApi).toHaveBeenCalled());
    const body = api.createTestApi.mock.calls[0]![0];
    expect(body.cover).toEqual({ kind: "pattern", blueprint_id: "bp1", section_positions: [1], scale_percent: 50 });
    expect(body.minutes).toBeUndefined();
    expect(body.name).toContain("SSC CGL");
  });

  it("a failed step shows the step and the server message", async () => {
    await setup();
    api.createTestApi.mockRejectedValue(new AdminApiError(422, { code: "POOL_TOO_SMALL", message: "Topic Series has too few questions" }));
    chooseSet();
    await screen.findByLabelText(/Number of questions/);
    fireEvent.click(save());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Step failed: Save the draft.");
    expect(alert.textContent).toContain("Topic Series has too few questions");
  });
});
