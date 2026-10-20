// Real-exam camera constants (Batch A). Numbers only; no prices, no names.

export const CAMERA_NOTICE_VERSION = "2026-10-20.v1";

export const PHOTO_KEEP_DAYS = 90;
export const VIDEO_KEEP_DAYS = 7;
export const SCHOOL_KEEP_DAYS = 7;
/** A flagged, unreviewed (or appealed) attempt is held past expiry up to this age. */
export const FLAG_MAX_DAYS_SCHOOL = 90;
export const FLAG_MAX_DAYS_OTHER = 365;

export const PHOTO_MAX_BYTES = 400 * 1024;
export const VIDEO_MAX_BYTES = 3 * 1024 * 1024;
export const PHOTO_MIME = "image/jpeg";
export const VIDEO_MIME = "video/webm";

export const UPLOAD_MAX_PER_ATTEMPT_PER_MIN = 12;
/** The candidate page takes one photo this often. Sent to the page by /camera/status. */
export const PHOTO_INTERVAL_SECONDS = 60;
export const MAX_PHOTOS_PER_ATTEMPT = 400;
export const MAX_VIDEOS_PER_ATTEMPT = 40;

export type CameraFileKind = "photo" | "video";
export type CameraFlagReason = "camera_stopped" | "camera_blocked";
