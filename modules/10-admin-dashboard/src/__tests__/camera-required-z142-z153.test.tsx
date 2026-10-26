// Z-142 / Z-153: the camera notice link helper. (The Start a test camera cases moved to create-test.test.tsx in CT-3.)
import { describe, it, expect } from "vitest";
import { cameraNoticeSettingsPath } from "../lib/camera-errors.js";
import { AdminApiError } from "../api.js";

describe("camera notice link helper", () => {
  it("returns the settings path from a 409 CAMERA_NOTICE_REQUIRED and null for other errors", () => {
    const notice = new AdminApiError(409, { code: "CAMERA_NOTICE_REQUIRED", message: "Confirm the notice.", details: { settingsPath: "/admin/tenant-settings" } });
    expect(cameraNoticeSettingsPath(notice)).toBe("/admin/tenant-settings");
    expect(cameraNoticeSettingsPath(new AdminApiError(409, { code: "CAMERA_OFF_FOR_SCHOOL", message: "Turn on." }))).toBeNull();
    expect(cameraNoticeSettingsPath(new Error("x"))).toBeNull();
  });
});
