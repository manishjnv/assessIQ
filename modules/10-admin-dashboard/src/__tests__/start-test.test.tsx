// "Start a test" one-screen flow — api functions mocked.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";

const api = vi.hoisted(() => ({
  getAvailableSets: vi.fn(), listCandidates: vi.fn(), createAssessmentFromSet: vi.fn(),
  publishAssessmentApi: vi.fn(), inviteAssessmentUsers: vi.fn(), importCandidates: vi.fn(),
}));
vi.mock("../api.js", () => ({
  ...api,
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

import { AdminStartTest, parsePasted } from "../pages/start-test.js";
import { AdminApiError } from "../api.js";

const SET = { source_pack_id: "p1", name: "SOC Basics", domain: "soc", source_version: 1, question_count: 30, level_count: 2, cloned: true, cloned_pack_id: "c1", update_available: false };

function setup() {
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
    fireEvent.click(screen.getByRole("radio"));
    expect((send() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    expect((send() as HTMLButtonElement).disabled).toBe(false);
  });

  it("runs create, publish, invite, import in order with the right bodies", async () => {
    setup();
    await screen.findByText(/Asha/);
    fireEvent.click(screen.getByRole("radio"));
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
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

  it("shows the failed step and the assessment link when publish fails", async () => {
    setup();
    api.publishAssessmentApi.mockRejectedValue(new AdminApiError(403, { code: "NOT_ENTITLED", message: "Not entitled" }));
    await screen.findByText(/Asha/);
    fireEvent.click(screen.getByRole("radio"));
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
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
