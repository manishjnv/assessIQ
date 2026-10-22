// Z-103: suggested time hint and button on Start a test.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router";

const api = vi.hoisted(() => ({
  getAvailableSets: vi.fn(), listCandidates: vi.fn(), createAssessmentFromSet: vi.fn(),
  publishAssessmentApi: vi.fn(), inviteAssessmentUsers: vi.fn(), importCandidates: vi.fn(),
  listExamBlueprintsApi: vi.fn(), createFullMockApi: vi.fn(), getPackLevelsApi: vi.fn(), importLicensedSet: vi.fn(),
}));
vi.mock("../api.js", () => ({
  ...api,
  AdminApiError: class AdminApiError extends Error {},
}));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { AdminStartTest } from "../pages/start-test.js";

const SET = { source_pack_id: "p1", name: "SOC Basics", domain: "soc", source_version: 1, question_count: 30, level_count: 2, level_minutes: [45, 60], avg_minutes_per_question: 1.25, cloned: true, cloned_pack_id: "c1", update_available: false };

function setup(set: unknown, blueprints: unknown[] = []) {
  api.listExamBlueprintsApi.mockResolvedValue({ items: blueprints });
  api.getAvailableSets.mockResolvedValue({ sets: [set] });
  api.listCandidates.mockResolvedValue({ items: [] });
  render(<MemoryRouter><AdminStartTest /></MemoryRouter>);
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("suggested time", () => {
  it("shows ceil(count * avg) and the button fills the time limit, which stays editable", async () => {
    setup(SET);
    fireEvent.click(await screen.findByRole("radio"));
    expect(screen.getByTestId("st-suggested").textContent).toBe("Suggested time: 13 min"); // 10 * 1.25 = 12.5
    fireEvent.change(screen.getByLabelText(/Number of questions/), { target: { value: "20" } });
    expect(screen.getByTestId("st-suggested").textContent).toBe("Suggested time: 25 min");
    fireEvent.click(screen.getByRole("button", { name: "Use suggested time" }));
    const box = screen.getByLabelText(/Time limit \(minutes\)/) as HTMLInputElement;
    expect(box.value).toBe("25");
    fireEvent.change(box, { target: { value: "30" } });
    expect(box.value).toBe("30");
  });

  it("hides the hint when the average is 0 or missing", async () => {
    setup({ ...SET, avg_minutes_per_question: 0 });
    fireEvent.click(await screen.findByRole("radio"));
    expect(screen.queryByTestId("st-suggested")).toBeNull();
  });

  it("hides the hint for a full mock", async () => {
    setup(SET, [{ id: "bp", name: "SSC", edition: "2026", total_questions: 100, total_minutes: 60, verification_status: "verified" }]);
    fireEvent.click(await screen.findByRole("radio", { name: /SOC Basics/ }));
    expect(screen.getByTestId("st-suggested")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start a full mock" }));
    fireEvent.click(await screen.findByRole("radio", { name: /SSC/ }));
    expect(screen.queryByTestId("st-suggested")).toBeNull();
  });
});
