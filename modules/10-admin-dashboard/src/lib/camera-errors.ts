// AssessIQ — camera error helper (Z-153). A 409 CAMERA_NOTICE_REQUIRED means the
// organisation has not confirmed the camera notice yet. The server names the page to open.
import { AdminApiError } from "../api.js";

const DEFAULT_SETTINGS_PATH = "/admin/tenant-settings";

/** Settings path to link from an error, or null when the error is not a camera notice error. */
export function cameraNoticeSettingsPath(err: unknown): string | null {
  if (!(err instanceof AdminApiError) || err.apiError.code !== "CAMERA_NOTICE_REQUIRED") return null;
  const path = err.apiError.details?.settingsPath;
  return typeof path === "string" && path.startsWith("/") ? path : DEFAULT_SETTINGS_PATH;
}
