// Real-exam camera staff API (camera feature, screens). Kept out of src/api.ts.
// Routes: docs/03-api-contract.md "Real-exam camera routes". Literal paths only (lint:ui-api-contract).
import { createApiRawRequest } from "@assessiq/http-client";
import { adminApi, AdminApiError } from "../api.js";

export interface CameraSettings {
  isSchool: boolean;
  /** Platform switch: false = camera tests are temporarily off (CAMERA_TEMPORARILY_OFF). */
  cameraEnforced: boolean;
  cameraEnabled: boolean;
  photosEnabled: boolean;
  noticeConfirmedVersion: string | null;
  requiredNoticeVersion: string;
  storage: { usedBytes: number; maxBytes: number; warn: boolean };
}

export interface CameraReviewer {
  userId: string;
  name: string | null;
  email: string;
  addedBy: string | null;
  createdAt: string | null;
}

export interface FlaggedAttempt {
  attemptId: string;
  userId: string;
  candidateName: string | null;
  candidateEmail: string | null;
  assessmentId: string;
  assessmentName: string | null;
  flaggedFiles: number;
  lastFlaggedAt: string;
  reviewedAt: string | null;
  appealState: "none" | "open" | "closed";
  uploadRefused: boolean;
}

export interface CameraFileRow {
  id: string;
  kind: "photo" | "video";
  takenAt: string;
  flagged: boolean;
  flagReason: string | null;
  sizeBytes: number;
}

export interface CameraReviewState {
  reviewedAt: string | null;
  appealState: "none" | "open" | "closed";
  uploadRefused: boolean;
}

export async function getCameraSettingsApi(): Promise<CameraSettings> {
  return adminApi<CameraSettings>("/admin/camera/settings");
}

export async function patchCameraSettingsApi(body: { cameraEnabled?: boolean; photosEnabled?: boolean }): Promise<{ ok: true }> {
  return adminApi<{ ok: true }>("/admin/camera/settings", { method: "PATCH", body: JSON.stringify(body) });
}

export async function confirmCameraNoticeApi(): Promise<{ ok: true; noticeConfirmedVersion: string }> {
  return adminApi<{ ok: true; noticeConfirmedVersion: string }>("/admin/camera/confirm-notice", {
    method: "POST",
    body: JSON.stringify({ confirm: true }),
  });
}

export async function listCameraReviewersApi(): Promise<{ items: CameraReviewer[] }> {
  return adminApi<{ items: CameraReviewer[] }>("/admin/camera/reviewers");
}

export async function addCameraReviewerApi(userId: string): Promise<{ ok: true }> {
  return adminApi<{ ok: true }>("/admin/camera/reviewers", { method: "POST", body: JSON.stringify({ userId }) });
}

export async function removeCameraReviewerApi(userId: string): Promise<{ ok: true }> {
  return adminApi<{ ok: true }>(`/admin/camera/reviewers/${encodeURIComponent(userId)}`, { method: "DELETE" });
}

/** Admin users of this tenant, for the reviewer picker. */
export async function listTenantAdminsApi(): Promise<{ items: Array<{ id: string; email: string; name: string | null; status: string }> }> {
  return adminApi<{ items: Array<{ id: string; email: string; name: string | null; status: string }> }>(
    "/admin/users?role=admin&pageSize=100",
  );
}

/** Nav probe. Always 200 for an admin, so a non-reviewer sees no console error. */
export async function cameraAccessApi(): Promise<{ reviewer: boolean }> {
  return adminApi<{ reviewer: boolean }>("/admin/camera/access");
}

export async function listFlaggedCameraApi(opts?: { cursor?: string; limit?: number }): Promise<{ items: FlaggedAttempt[]; nextCursor: string | null }> {
  const q = new URLSearchParams();
  if (opts?.cursor) q.set("cursor", opts.cursor);
  q.set("limit", String(opts?.limit ?? 50));
  return adminApi<{ items: FlaggedAttempt[]; nextCursor: string | null }>(`/admin/camera/flagged?${q.toString()}`);
}

export async function listCameraFilesApi(attemptId: string): Promise<{ items: CameraFileRow[]; review: CameraReviewState }> {
  return adminApi<{ items: CameraFileRow[]; review: CameraReviewState }>(
    `/admin/camera/attempts/${encodeURIComponent(attemptId)}/files`,
  );
}

export async function markCameraAttemptReviewedApi(attemptId: string): Promise<{ ok: true }> {
  return adminApi<{ ok: true }>(`/admin/camera/attempts/${encodeURIComponent(attemptId)}/reviewed`, { method: "POST" });
}

export async function setCameraAppealApi(attemptId: string, state: "open" | "closed" | "none"): Promise<{ ok: true }> {
  return adminApi<{ ok: true }>(`/admin/camera/attempts/${encodeURIComponent(attemptId)}/appeal`, {
    method: "POST",
    body: JSON.stringify({ state }),
  });
}

const cameraRaw = createApiRawRequest("/api");

/**
 * Fetch one camera file's bytes. Every call is logged server side (camera.file.viewed).
 * Throws AdminApiError on a non-2xx answer. The caller makes an object URL and revokes it.
 */
export async function fetchCameraFileBlob(fileId: string): Promise<Blob> {
  const res = await cameraRaw(`/admin/camera/files/${encodeURIComponent(fileId)}/content`);
  if (!res.ok) {
    let body: { error?: { code: string; message: string; details?: Record<string, unknown> } } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      body = {};
    }
    throw new AdminApiError(res.status, body.error ?? { code: `HTTP_${res.status}`, message: res.statusText });
  }
  return res.blob();
}

/** POST /api/admin/platform/tenants/:tenantId/school (super admin, fresh MFA). */
export async function setTenantSchoolApi(tenantId: string, isSchool: boolean): Promise<{ ok: true; isSchool: boolean }> {
  return adminApi<{ ok: true; isSchool: boolean }>(`/admin/platform/tenants/${encodeURIComponent(tenantId)}/school`, {
    method: "POST",
    body: JSON.stringify({ isSchool }),
  });
}
