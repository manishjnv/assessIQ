// Camera feature: tenant settings camera card (notice checkbox, school switches, storage banner, reviewers).
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  getCameraSettingsApi: vi.fn(),
  patchCameraSettingsApi: vi.fn(),
  confirmCameraNoticeApi: vi.fn(),
  listCameraReviewersApi: vi.fn(),
  listTenantAdminsApi: vi.fn(),
  addCameraReviewerApi: vi.fn(),
  removeCameraReviewerApi: vi.fn(),
}));
vi.mock("../api/camera.js", () => api);

import { CameraSettingsCard } from "../components/CameraSettingsCard.js";

const base = {
  isSchool: true,
  cameraEnabled: false,
  photosEnabled: false,
  noticeConfirmedVersion: null,
  requiredNoticeVersion: "v2",
  storage: { usedBytes: 10, maxBytes: 100, warn: false },
  cameraEnforced: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listCameraReviewersApi.mockResolvedValue({ items: [{ userId: "u-1", name: "Ravi", email: "ravi@x.test", addedBy: null, createdAt: null }] });
  api.listTenantAdminsApi.mockResolvedValue({ items: [{ id: "u-1", email: "ravi@x.test", name: "Ravi", status: "active" }, { id: "u-2", email: "meena@x.test", name: null, status: "active" }] });
  api.confirmCameraNoticeApi.mockResolvedValue({ ok: true, noticeConfirmedVersion: "v2" });
  api.patchCameraSettingsApi.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe("CameraSettingsCard", () => {
  it("confirms the notice when the checkbox is ticked", async () => {
    api.getCameraSettingsApi.mockResolvedValueOnce({ ...base, isSchool: false }).mockResolvedValue({ ...base, isSchool: false, noticeConfirmedVersion: "v2" });
    const { container } = render(<CameraSettingsCard />);
    const box = await screen.findByRole("checkbox");
    fireEvent.click(box);
    await waitFor(() => expect(api.confirmCameraNoticeApi).toHaveBeenCalledTimes(1));
    expect(container.querySelector('[data-help-id="admin.tenant_settings.camera_notice"]')).not.toBeNull();
    expect(await screen.findByText("Confirmed, version v2")).toBeTruthy();
  });

  it("asks to confirm again when the notice version changed", async () => {
    api.getCameraSettingsApi.mockResolvedValue({ ...base, isSchool: false, noticeConfirmedVersion: "v1" });
    render(<CameraSettingsCard />);
    expect(await screen.findByText(/changed to version v2/)).toBeTruthy();
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });

  it("school: switches call PATCH with the one field changed", async () => {
    api.getCameraSettingsApi.mockResolvedValue({ ...base, noticeConfirmedVersion: "v2" });
    render(<CameraSettingsCard />);
    expect(await screen.findByText("Off. The camera is off until you turn it on.")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Camera for real tests" }));
    await waitFor(() => expect(api.patchCameraSettingsApi).toHaveBeenCalledWith({ cameraEnabled: true }));
    fireEvent.click(screen.getByRole("switch", { name: "Photos" }));
    await waitFor(() => expect(api.patchCameraSettingsApi).toHaveBeenCalledWith({ photosEnabled: true }));
  });

  it("not a school: no switches, one line about the notice and the camera", async () => {
    api.getCameraSettingsApi.mockResolvedValue({ ...base, isSchool: false, noticeConfirmedVersion: "v2" });
    render(<CameraSettingsCard />);
    expect(await screen.findByText("Confirm the camera notice to publish tests with the camera.")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Photos" })).toBeNull();
  });

  it("normal organisation sees the notice confirm button", async () => {
    api.getCameraSettingsApi.mockResolvedValue({ ...base, isSchool: false, noticeConfirmedVersion: null });
    render(<CameraSettingsCard />);
    const box = (await screen.findByRole("checkbox")) as HTMLInputElement;
    expect(box.disabled).toBe(false);
    expect(screen.getByText("I have the consent and notice my candidates need for camera use.")).toBeTruthy();
  });

  it("shows the storage warning banner when storage is nearly full", async () => {
    api.getCameraSettingsApi.mockResolvedValue({ ...base, isSchool: false, storage: { usedBytes: 95, maxBytes: 100, warn: true } });
    render(<CameraSettingsCard />);
    expect(await screen.findByText("Camera storage is almost full. Contact AssessIQ support.")).toBeTruthy();
  });

  it("reviewers: lists them and removes one; adds a picked admin who is not yet a reviewer", async () => {
    api.getCameraSettingsApi.mockResolvedValue({ ...base, isSchool: false, noticeConfirmedVersion: "v2" });
    api.removeCameraReviewerApi.mockResolvedValue({ ok: true });
    api.addCameraReviewerApi.mockResolvedValue({ ok: true });
    const { container } = render(<CameraSettingsCard />);
    expect(await screen.findByText("Only these people can open camera files.")).toBeTruthy();
    expect(container.querySelector('[data-help-id="admin.tenant_settings.camera_reviewers"]')).not.toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(api.removeCameraReviewerApi).toHaveBeenCalledWith("u-1"));
    const picker = screen.getByLabelText("Admin to add as reviewer") as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: "u-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Add reviewer" }));
    await waitFor(() => expect(api.addCameraReviewerApi).toHaveBeenCalledWith("u-2"));
  });
});
