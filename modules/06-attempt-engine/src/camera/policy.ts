// Pure camera policy. No I/O, no AI. Rules (owner, 2026-10-19/20):
//   mock exam -> no camera. Embed -> no camera (accepted gap). CAMERA_ENFORCED off -> no camera.
//   School: required = cameraEnabled, photos = photosEnabled, keep 7 days for both.
//   Other real exam: required, photos on, keep 90 days (photo) / 7 days (video).

import { PHOTO_KEEP_DAYS, SCHOOL_KEEP_DAYS, VIDEO_KEEP_DAYS, type CameraFileKind } from "./constants.js";

export interface CameraTenantPolicyInput {
  isSchool: boolean;
  cameraEnabled: boolean;
  photosEnabled: boolean;
  noticeConfirmedVersion: string | null;
}

export interface CameraPolicy {
  required: boolean;
  photos: boolean;
  video: boolean;
  keepDays: { photo: number; video: number };
  reason: "mock" | "embed" | "not_enforced" | "school_off" | "school" | "real";
}

export function resolveCameraPolicy(input: {
  deliveryMode: "mock" | "real";
  isEmbed: boolean;
  tenantCamera: CameraTenantPolicyInput;
  enforced: boolean;
}): CameraPolicy {
  const none = (reason: CameraPolicy["reason"]): CameraPolicy => ({
    required: false,
    photos: false,
    video: false,
    keepDays: { photo: PHOTO_KEEP_DAYS, video: VIDEO_KEEP_DAYS },
    reason,
  });
  if (input.deliveryMode !== "real") return none("mock");
  if (input.isEmbed) return none("embed");
  if (!input.enforced) return none("not_enforced");
  const t = input.tenantCamera;
  if (t.isSchool) {
    if (!t.cameraEnabled) return none("school_off");
    return {
      required: true,
      photos: t.photosEnabled,
      video: true,
      keepDays: { photo: SCHOOL_KEEP_DAYS, video: SCHOOL_KEEP_DAYS },
      reason: "school",
    };
  }
  return { required: true, photos: true, video: true, keepDays: { photo: PHOTO_KEEP_DAYS, video: VIDEO_KEEP_DAYS }, reason: "real" };
}

/** 'NOT_CONFIRMED' when a camera is required but the organisation has not confirmed the notice. */
export function cameraSetupBlocker(policy: CameraPolicy, tenantCamera: CameraTenantPolicyInput): "NOT_CONFIRMED" | null {
  return policy.required && tenantCamera.noticeConfirmedVersion === null ? "NOT_CONFIRMED" : null;
}

export function computeExpiresAt(kind: CameraFileKind, takenAt: Date, policy: Pick<CameraPolicy, "keepDays">): Date {
  const days = kind === "photo" ? policy.keepDays.photo : policy.keepDays.video;
  return new Date(takenAt.getTime() + days * 86_400_000);
}
