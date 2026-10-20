// Camera feature: reviewer page. List renders, View fetches the content route, 403 shows the not-a-reviewer page.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { AdminApiError } from "../api.js";

const api = vi.hoisted(() => ({
  listFlaggedCameraApi: vi.fn(),
  listCameraFilesApi: vi.fn(),
  fetchCameraFileBlob: vi.fn(),
  markCameraAttemptReviewedApi: vi.fn(),
  setCameraAppealApi: vi.fn(),
}));
vi.mock("../api/camera.js", () => api);
vi.mock("../components/AdminShell.js", () => ({ AdminShell: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

import { CameraReview } from "../pages/camera-review.js";

const row = {
  attemptId: "a-1", userId: "u-9", candidateName: "Asha", candidateEmail: "asha@x.test",
  assessmentId: "as-1", assessmentName: "Maths mock", flaggedFiles: 2,
  lastFlaggedAt: "2026-10-20T10:00:00.000Z", reviewedAt: null, appealState: "none", uploadRefused: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  URL.createObjectURL = vi.fn(() => "blob:camera-1");
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

describe("CameraReview", () => {
  it("lists flagged attempts and shows the refused-upload badge", async () => {
    api.listFlaggedCameraApi.mockResolvedValue({ items: [row], nextCursor: null });
    const { container } = render(<CameraReview />);
    expect(await screen.findByText("Asha")).toBeTruthy();
    expect(screen.getByText("Uploads refused")).toBeTruthy();
    expect(container.querySelector('[data-help-id="admin.camera.review_list"]')).not.toBeNull();
  });

  it("opens files and View fetches the content route, then shows the file and revokes it on close", async () => {
    api.listFlaggedCameraApi.mockResolvedValue({ items: [row], nextCursor: null });
    api.listCameraFilesApi.mockResolvedValue({
      items: [{ id: "f-1", kind: "photo", takenAt: "2026-10-20T10:01:00.000Z", flagged: false, flagReason: null, sizeBytes: 40960 }],
      review: { reviewedAt: null, appealState: "none", uploadRefused: true },
    });
    api.fetchCameraFileBlob.mockResolvedValue(new Blob(["x"], { type: "image/jpeg" }));
    render(<CameraReview />);
    fireEvent.click(await screen.findByText("Asha"));
    expect(await screen.findByText("Every view is logged.")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "View" }));
    await waitFor(() => expect(api.fetchCameraFileBlob).toHaveBeenCalledWith("f-1"));
    expect(await screen.findByRole("img")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close file" }));
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:camera-1"));
  });

  it("shows the not-a-reviewer page on 403", async () => {
    api.listFlaggedCameraApi.mockRejectedValue(new AdminApiError(403, { code: "AUTHZ_FAILED", message: "no", details: { code: "CAMERA_REVIEWER_REQUIRED" } }));
    render(<CameraReview />);
    expect(await screen.findByTestId("camera-not-reviewer")).toBeTruthy();
    expect(screen.getByText("You are not a camera reviewer.")).toBeTruthy();
  });
});
