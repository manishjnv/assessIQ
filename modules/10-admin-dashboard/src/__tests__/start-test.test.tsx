// "Start a test" one-screen flow — api functions mocked.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router";

const api = vi.hoisted(() => ({
  getAvailableSets: vi.fn(), listCandidates: vi.fn(), createAssessmentFromSet: vi.fn(),
  publishAssessmentApi: vi.fn(), inviteAssessmentUsers: vi.fn(), importCandidates: vi.fn(),
  listExamBlueprintsApi: vi.fn(), createFullMockApi: vi.fn(), getPackLevelsApi: vi.fn(), importLicensedSet: vi.fn(),
}));
vi.mock("../api.js", () => ({
  ...api,
  AdminApiError: class AdminApiError extends Error {
    apiError: { code: string; message: string };
    constructor(_s: number, e: { code: string; message: string }) { super(e.message); this.apiError = e; }
  },
}));
vi.mock("../api/camera.js", () => ({
  getCameraSettingsApi: vi.fn().mockResolvedValue({ isSchool: false, cameraEnabled: true, cameraEnforced: true }),
}));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { AdminStartTest, START_TEST_HELP_PAGE, START_TEST_MOCK_HELP, parsePasted } from "../pages/start-test.js";
import { AdminApiError } from "../api.js";

const SET = { source_pack_id: "p1", name: "SOC Basics", domain: "soc", source_version: 1, question_count: 30, level_count: 2, level_minutes: [45, 60], cloned: true, cloned_pack_id: "c1", update_available: false };

function setup(blueprints: unknown[] = []) {
  api.listExamBlueprintsApi.mockResolvedValue({ items: blueprints });
  api.getAvailableSets.mockResolvedValue({ sets: [SET] });
  api.listCandidates.mockResolvedValue({ items: [{ id: "u1", email: "a@x.com", name: "Asha", status: "active" }, { id: "u2", email: "z@x.com", name: "Zed", status: "suspended" }] });
  api.createAssessmentFromSet.mockResolvedValue({ id: "as1" });
  api.publishAssessmentApi.mockResolvedValue({});
  api.inviteAssessmentUsers.mockResolvedValue({ invited: 1, skipped: [] });
  api.importCandidates.mockResolvedValue({ created: 1, existing: 0, invited: 1, skipped: [{ row: 3, email: "b@x.com", reason: "INVITATION_EXISTS" }] });
  render(<MemoryRouter><AdminStartTest /></MemoryRouter>);
}
const send = () => screen.getByRole("button", { name: "Send invitations" });

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("parsePasted", () => {
  it("reads emails, names and invalid entries", () => {
    const p = parsePasted("A@x.com, Asha\nb@x.com,c@x.com\nnope\na@x.com");
    expect(p.entries).toEqual([{ email: "a@x.com", name: "Asha" }, { email: "b@x.com", name: "" }, { email: "c@x.com", name: "" }]);
    expect(p.invalid).toEqual(["nope"]);
  });
});

describe("AdminStartTest", () => {
  it("lists sets and active candidates; button waits for a set and a candidate", async () => {
    setup();
    await screen.findByText(/SOC Basics/);
    await screen.findByText(/Asha/);
    expect(screen.queryByText(/Zed/)).toBeNull();
    expect((send() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /SOC Basics/ }));
    expect((send() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /Asha/ }));
    expect((send() as HTMLButtonElement).disabled).toBe(false);
  });

  it("runs create, publish, invite, import in order with the right bodies", async () => {
    setup();
    await screen.findByText(/Asha/);
    fireEvent.click(screen.getByRole("radio", { name: /SOC Basics/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Asha/ }));
    fireEvent.change(screen.getByLabelText(/Or paste/), { target: { value: "b@x.com, Bo" } });
    fireEvent.click(send());
    await screen.findByTestId("start-test-result");
    const body = api.createAssessmentFromSet.mock.calls[0]![0];
    expect(body).toMatchObject({ source_pack_id: "p1", level_position: 1, question_count: 10 });
    expect(new Date(body.opens_at).toISOString()).toBe(body.opens_at);
    expect(api.publishAssessmentApi).toHaveBeenCalledWith("as1");
    expect(api.inviteAssessmentUsers).toHaveBeenCalledWith("as1", ["u1"]);
    expect(api.importCandidates).toHaveBeenCalledWith("name,email\nBo,b@x.com", "as1");
    expect(api.createAssessmentFromSet.mock.invocationCallOrder[0]!).toBeLessThan(api.publishAssessmentApi.mock.invocationCallOrder[0]!);
    expect(api.inviteAssessmentUsers.mock.invocationCallOrder[0]!).toBeLessThan(api.importCandidates.mock.invocationCallOrder[0]!);
    expect(screen.getByText(/b@x.com: Already invited/)).toBeTruthy();
  });

  it("sends the time limit when typed, nothing when empty, and shows the level time as placeholder", async () => {
    setup();
    await screen.findByText(/Asha/);
    fireEvent.click(screen.getByRole("radio", { name: /SOC Basics/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Asha/ }));
    const box = screen.getByLabelText(/Time limit \(minutes\)/) as HTMLInputElement;
    expect(box.placeholder).toBe("45");
    fireEvent.change(box, { target: { value: "20" } });
    fireEvent.click(send());
    await screen.findByTestId("start-test-result");
    expect(api.createAssessmentFromSet.mock.calls[0]![0].duration_minutes).toBe(20);
  });

  it("leaves duration_minutes out when the time limit is empty and blocks a value over 600", async () => {
    setup();
    await screen.findByText(/Asha/);
    fireEvent.click(screen.getByRole("radio", { name: /SOC Basics/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Asha/ }));
    const box = screen.getByLabelText(/Time limit \(minutes\)/);
    fireEvent.change(box, { target: { value: "601" } });
    expect((send() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.click(send());
    await screen.findByTestId("start-test-result");
    expect("duration_minutes" in api.createAssessmentFromSet.mock.calls[0]![0]).toBe(false);
  });

  it("shows the failed step and the assessment link when publish fails", async () => {
    setup();
    api.publishAssessmentApi.mockRejectedValue(new AdminApiError(403, { code: "NOT_ENTITLED", message: "Not entitled" }));
    await screen.findByText(/Asha/);
    fireEvent.click(screen.getByRole("radio", { name: /SOC Basics/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Asha/ }));
    fireEvent.click(send());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Publish the assessment");
    expect(screen.getByRole("link", { name: /Open it/ }).getAttribute("href")).toBe("/admin/assessments/as1");
    expect(api.inviteAssessmentUsers).not.toHaveBeenCalled();
  });

  it("lists invalid pasted entries", async () => {
    setup();
    await screen.findByText(/Asha/);
    fireEvent.change(screen.getByLabelText(/Or paste/), { target: { value: "ok@x.com\nnot-an-email" } });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("not-an-email"));
  });
});

const BLUEPRINTS = [
  { id: "bp-ssc", name: "SSC CGL Tier 1", edition: "2026", total_questions: 100, total_minutes: 60, verification_status: "verified" },
  { id: "bp-other", name: "IBPS PO Prelims", edition: "2026", total_questions: 100, total_minutes: 60, verification_status: "unverified" },
];

function setupMock() {
  api.importLicensedSet.mockResolvedValue({ cloned_pack_id: "c-pack", slug: "soc", reused: true, question_count: 30 });
  api.getPackLevelsApi.mockResolvedValue({ levels: [{ id: "lv1", order: 1 }, { id: "lv2", order: 2 }] });
  api.createFullMockApi.mockResolvedValue({ assessment: { id: "mock1" }, warnings: [] });
  setup(BLUEPRINTS);
}

async function chooseMockFlow(blueprintName: RegExp) {
  await screen.findByText(/SOC Basics/);
  fireEvent.click(screen.getByRole("radio", { name: /SOC Basics/ }));
  fireEvent.click(screen.getByRole("button", { name: "Start a full mock" }));
  fireEvent.click(await screen.findByRole("radio", { name: blueprintName }));
  await screen.findByText(/Asha/);
  fireEvent.click(screen.getByRole("checkbox", { name: /Asha/ }));
}

describe("full mock on Start a test (EXP-6 / Z-42 tail)", () => {
  it("offers the verified blueprint and marks the others unverified", async () => {
    setupMock();
    fireEvent.click(screen.getByRole("button", { name: "Start a full mock" }));
    await screen.findByRole("radio", { name: /SSC CGL Tier 1/ });
    expect(screen.getByText("Verified")).toBeTruthy();
    expect(screen.getByText("Unverified")).toBeTruthy();
  });

  it("copies the set, finds the level, then creates, publishes and invites", async () => {
    setupMock();
    await chooseMockFlow(/SSC CGL Tier 1/);
    fireEvent.click(send());
    await screen.findByTestId("start-test-result");
    expect(api.importLicensedSet).toHaveBeenCalledWith("p1");
    expect(api.getPackLevelsApi).toHaveBeenCalledWith("c-pack");
    expect(api.createFullMockApi).toHaveBeenCalledWith("bp-ssc", expect.objectContaining({ pack_id: "c-pack", level_id: "lv1" }));
    expect(api.createAssessmentFromSet).not.toHaveBeenCalled();
    expect(api.publishAssessmentApi).toHaveBeenCalledWith("mock1");
    expect(api.inviteAssessmentUsers).toHaveBeenCalledWith("mock1", ["u1"]);
  });

  it("rejects a set that has no chosen difficulty and does not publish", async () => {
    setupMock();
    api.getPackLevelsApi.mockResolvedValue({ levels: [] });
    await chooseMockFlow(/SSC CGL Tier 1/);
    fireEvent.click(send());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Find the difficulty level");
    expect(alert.textContent).toContain("has no difficulty 1");
    expect(api.createFullMockApi).not.toHaveBeenCalled();
    expect(api.publishAssessmentApi).not.toHaveBeenCalled();
  });

  it("help ids start with the page prefix and contain no hyphen", () => {
    expect(START_TEST_HELP_PAGE).toBe("admin.start_test");
    for (const id of Object.values(START_TEST_MOCK_HELP)) {
      expect(id.startsWith(`${START_TEST_HELP_PAGE}.`)).toBe(true);
      expect(id.includes("-")).toBe(false);
    }
  });
});
