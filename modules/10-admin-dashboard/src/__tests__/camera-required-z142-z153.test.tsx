// Z-142 (7) camera checkbox and Z-153 camera notice link. api functions mocked.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router";

const api = vi.hoisted(() => ({
  adminApi: vi.fn(),
  getAvailableSets: vi.fn(), listCandidates: vi.fn(), createAssessmentFromSet: vi.fn(),
  publishAssessmentApi: vi.fn(), inviteAssessmentUsers: vi.fn(), importCandidates: vi.fn(),
  listExamBlueprintsApi: vi.fn(), createFullMockApi: vi.fn(), getPackLevelsApi: vi.fn(), importLicensedSet: vi.fn(),
}));
vi.mock("../api.js", () => ({
  ...api,
  AdminApiError: class AdminApiError extends Error {
    status: number;
    apiError: { code: string; message: string; details?: Record<string, unknown> };
    constructor(status: number, e: { code: string; message: string; details?: Record<string, unknown> }) {
      super(e.message);
      this.status = status;
      this.apiError = e;
    }
  },
}));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { TestTypeCard } from "../components/TestTypeCard.js";
import { AdminStartTest } from "../pages/start-test.js";
import { cameraNoticeSettingsPath } from "../lib/camera-errors.js";
import { AdminApiError } from "../api.js";

const SET = { source_pack_id: "p1", name: "SOC Basics", domain: "soc", source_version: 1, question_count: 30, level_count: 2, level_minutes: [45, 60], cloned: true, cloned_pack_id: "c1", update_available: false };

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("TestTypeCard camera checkbox", () => {
  it("is disabled while the type is Mock", () => {
    render(<TestTypeCard assessmentId="a1" initial="mock" initialCameraRequired={false} isDraft />);
    const box = screen.getByRole("checkbox", { name: "Camera required" }) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(false);
  });

  it("is enabled for Real and PATCHes camera_required with delivery_mode", async () => {
    api.adminApi.mockResolvedValue({});
    render(<TestTypeCard assessmentId="a1" initial="real" initialCameraRequired={false} isDraft />);
    const box = screen.getByRole("checkbox", { name: "Camera required" }) as HTMLInputElement;
    expect(box.disabled).toBe(false);
    fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Save test type" }));
    await waitFor(() => expect(api.adminApi).toHaveBeenCalledWith("/admin/assessments/a1", {
      method: "PATCH",
      body: JSON.stringify({ delivery_mode: "real", camera_required: true }),
    }));
  });

  it("after publish shows the read-only type line", () => {
    render(<TestTypeCard assessmentId="a1" initial="real" initialCameraRequired isDraft={false} />);
    expect(screen.getByText("Type: Real + camera")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("camera notice link helper", () => {
  it("returns the settings path from a 409 CAMERA_NOTICE_REQUIRED and null for other errors", () => {
    const notice = new AdminApiError(409, { code: "CAMERA_NOTICE_REQUIRED", message: "Confirm the notice.", details: { settingsPath: "/admin/tenant-settings" } });
    expect(cameraNoticeSettingsPath(notice)).toBe("/admin/tenant-settings");
    expect(cameraNoticeSettingsPath(new AdminApiError(409, { code: "CAMERA_OFF_FOR_SCHOOL", message: "Turn on." }))).toBeNull();
    expect(cameraNoticeSettingsPath(new Error("x"))).toBeNull();
  });
});

describe("Start a test camera wiring", () => {
  function setup() {
    api.listExamBlueprintsApi.mockResolvedValue({ items: [] });
    api.getAvailableSets.mockResolvedValue({ sets: [SET] });
    api.listCandidates.mockResolvedValue({ items: [{ id: "u1", email: "a@x.com", name: "Asha", status: "active" }] });
    api.createAssessmentFromSet.mockResolvedValue({ id: "as1" });
    api.publishAssessmentApi.mockRejectedValue(new AdminApiError(409, { code: "CAMERA_NOTICE_REQUIRED", message: "Confirm the camera notice in Settings before you publish a camera test.", details: { settingsPath: "/admin/tenant-settings" } }));
    render(<MemoryRouter><AdminStartTest /></MemoryRouter>);
  }

  it("Camera required is disabled for Mock and sends delivery_mode and camera_required", async () => {
    setup();
    await screen.findByText(/Asha/);
    fireEvent.click(screen.getByRole("radio"));
    fireEvent.click(screen.getByRole("checkbox", { name: /Asha/ }));
    const type = screen.getByLabelText("Test type") as HTMLSelectElement;
    const camera = () => screen.getByRole("checkbox", { name: "Camera required" }) as HTMLInputElement;
    fireEvent.change(type, { target: { value: "mock" } });
    expect(camera().disabled).toBe(true);
    fireEvent.change(type, { target: { value: "real" } });
    fireEvent.click(camera());
    fireEvent.click(screen.getByRole("button", { name: "Send invitations" }));
    await waitFor(() => expect(api.createAssessmentFromSet).toHaveBeenCalled());
    const body = api.createAssessmentFromSet.mock.calls[0]![0];
    expect(body.delivery_mode).toBe("real");
    expect(body.camera_required).toBe(true);
  });

  it("a 409 CAMERA_NOTICE_REQUIRED on publish shows the message and an Open camera settings link", async () => {
    setup();
    await screen.findByText(/Asha/);
    fireEvent.click(screen.getByRole("radio"));
    fireEvent.click(screen.getByRole("checkbox", { name: /Asha/ }));
    fireEvent.click(screen.getByRole("button", { name: "Send invitations" }));
    const link = await screen.findByRole("link", { name: "Open camera settings" });
    expect(link.getAttribute("href")).toBe("/admin/tenant-settings");
    expect(screen.getByRole("alert").textContent).toContain("Confirm the camera notice");
  });
});
