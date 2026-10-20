// Camera repository. Every function takes the client of an OPEN withTenant transaction
// (RLS pins the tenant). Inserts carry tenant_id explicitly. No AI.

import type { PoolClient } from "pg";
import type { CameraFileKind, CameraFlagReason } from "./constants.js";

export interface CameraConsentRow {
  id: string;
  invitationId: string;
  attemptId: string | null;
  userId: string;
  decision: "agreed" | "declined";
  noticeVersion: string;
  createdAt: Date;
}

interface ConsentDb {
  id: string;
  invitation_id: string;
  attempt_id: string | null;
  user_id: string;
  decision: "agreed" | "declined";
  notice_version: string;
  created_at: Date;
}
const mapConsent = (r: ConsentDb): CameraConsentRow => ({
  id: r.id,
  invitationId: r.invitation_id,
  attemptId: r.attempt_id,
  userId: r.user_id,
  decision: r.decision,
  noticeVersion: r.notice_version,
  createdAt: r.created_at,
});
const CONSENT_COLS = `id, invitation_id, attempt_id, user_id, decision, notice_version, created_at`;

export async function insertConsent(
  client: PoolClient,
  i: {
    tenantId: string;
    invitationId: string;
    attemptId?: string | null;
    userId: string;
    decision: "agreed" | "declined";
    noticeVersion: string;
    ipHash: string;
    deviceType: string;
  },
): Promise<CameraConsentRow> {
  const r = await client.query<ConsentDb>(
    `INSERT INTO camera_consents (tenant_id, invitation_id, attempt_id, user_id, decision, notice_version, ip_hash, device_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${CONSENT_COLS}`,
    [i.tenantId, i.invitationId, i.attemptId ?? null, i.userId, i.decision, i.noticeVersion, i.ipHash, i.deviceType],
  );
  return mapConsent(r.rows[0]!);
}

export async function latestConsentForInvitation(client: PoolClient, invitationId: string): Promise<CameraConsentRow | null> {
  const r = await client.query<ConsentDb>(
    `SELECT ${CONSENT_COLS} FROM camera_consents WHERE invitation_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [invitationId],
  );
  return r.rows[0] ? mapConsent(r.rows[0]) : null;
}

export async function hasAgreedConsentForAttempt(client: PoolClient, attemptId: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM camera_consents WHERE attempt_id = $1 AND decision = 'agreed' LIMIT 1`,
    [attemptId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Link the invitation's newest unlinked consent to the attempt. Returns true when one row was linked. */
export async function linkConsentToAttempt(client: PoolClient, invitationId: string, attemptId: string): Promise<boolean> {
  const r = await client.query(
    `UPDATE camera_consents SET attempt_id = $2
      WHERE id = (SELECT id FROM camera_consents WHERE invitation_id = $1 AND attempt_id IS NULL
                   ORDER BY created_at DESC, id DESC LIMIT 1)`,
    [invitationId, attemptId],
  );
  return (r.rowCount ?? 0) > 0;
}

export interface CameraFileRow {
  id: string;
  attemptId: string;
  userId: string;
  kind: CameraFileKind;
  storagePath: string;
  sizeBytes: number;
  takenAt: Date;
  expiresAt: Date;
  flagged: boolean;
  flagReason: CameraFlagReason | null;
}
interface FileDb {
  id: string;
  attempt_id: string;
  user_id: string;
  kind: CameraFileKind;
  storage_path: string;
  size_bytes: string;
  taken_at: Date;
  expires_at: Date;
  flagged: boolean;
  flag_reason: CameraFlagReason | null;
}
const FILE_COLS = `id, attempt_id, user_id, kind, storage_path, size_bytes::text, taken_at, expires_at, flagged, flag_reason`;
const mapFile = (r: FileDb): CameraFileRow => ({
  id: r.id,
  attemptId: r.attempt_id,
  userId: r.user_id,
  kind: r.kind,
  storagePath: r.storage_path,
  sizeBytes: Number(r.size_bytes),
  takenAt: r.taken_at,
  expiresAt: r.expires_at,
  flagged: r.flagged,
  flagReason: r.flag_reason,
});

export async function insertCameraFile(
  client: PoolClient,
  i: {
    id: string;
    tenantId: string;
    attemptId: string;
    userId: string;
    kind: CameraFileKind;
    storagePath: string;
    sizeBytes: number;
    takenAt: Date;
    expiresAt: Date;
    flagged?: boolean;
    flagReason?: CameraFlagReason | null;
  },
): Promise<CameraFileRow> {
  const r = await client.query<FileDb>(
    `INSERT INTO camera_files (id, tenant_id, attempt_id, user_id, kind, storage_path, size_bytes, taken_at, expires_at, flagged, flag_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${FILE_COLS}`,
    [
      i.id, i.tenantId, i.attemptId, i.userId, i.kind, i.storagePath, i.sizeBytes,
      i.takenAt, i.expiresAt, i.flagged ?? false, i.flagReason ?? null,
    ],
  );
  return mapFile(r.rows[0]!);
}

export async function countFilesForAttempt(client: PoolClient, attemptId: string, kind: CameraFileKind): Promise<number> {
  const r = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM camera_files WHERE attempt_id = $1 AND kind = $2`,
    [attemptId, kind],
  );
  return r.rows[0]?.n ?? 0;
}

export async function getFileForView(client: PoolClient, fileId: string): Promise<CameraFileRow | null> {
  const r = await client.query<FileDb>(`SELECT ${FILE_COLS} FROM camera_files WHERE id = $1`, [fileId]);
  return r.rows[0] ? mapFile(r.rows[0]) : null;
}

export interface FlaggedAttemptRow {
  attemptId: string;
  userId: string;
  assessmentId: string;
  assessmentName: string;
  flaggedFiles: number;
  lastFlaggedAt: Date;
  reviewedAt: Date | null;
  appealState: "none" | "open" | "closed";
  uploadRefused: boolean;
}

/** Flagged attempts, newest flag first. Cursor = "<iso>|<attemptId>" of the previous page's last item. */
export async function listFlaggedAttempts(
  client: PoolClient,
  opts: { limit?: number; cursor?: string | null } = {},
): Promise<{ items: FlaggedAttemptRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const [curTs, curId] = opts.cursor ? opts.cursor.split("|") : [null, null];
  const r = await client.query<{
    attempt_id: string; user_id: string; assessment_id: string; assessment_name: string; n: number;
    last_flagged_at: Date; reviewed_at: Date | null; appeal_state: "none" | "open" | "closed"; upload_refused: boolean | null;
  }>(
    `SELECT g.attempt_id, a.user_id, a.assessment_id, s.name AS assessment_name, g.n, g.last_flagged_at,
            rv.reviewed_at, COALESCE(rv.appeal_state, 'none') AS appeal_state, rv.upload_refused
       FROM (SELECT attempt_id, count(*)::int AS n, max(taken_at) AS last_flagged_at
               FROM camera_files WHERE flagged GROUP BY attempt_id) g
       JOIN attempts a ON a.id = g.attempt_id
       JOIN assessments s ON s.id = a.assessment_id
       LEFT JOIN camera_attempt_reviews rv ON rv.attempt_id = g.attempt_id
      WHERE ($1::timestamptz IS NULL OR (g.last_flagged_at, g.attempt_id) < ($1::timestamptz, $2::uuid))
      ORDER BY g.last_flagged_at DESC, g.attempt_id DESC
      LIMIT $3`,
    [curTs ?? null, curId ?? null, limit + 1],
  );
  const rows = r.rows.slice(0, limit);
  const last = rows[rows.length - 1];
  return {
    items: rows.map((x) => ({
      attemptId: x.attempt_id,
      userId: x.user_id,
      assessmentId: x.assessment_id,
      assessmentName: x.assessment_name,
      flaggedFiles: x.n,
      lastFlaggedAt: x.last_flagged_at,
      reviewedAt: x.reviewed_at,
      appealState: x.appeal_state,
      uploadRefused: x.upload_refused ?? false,
    })),
    nextCursor: r.rows.length > limit && last ? `${last.last_flagged_at.toISOString()}|${last.attempt_id}` : null,
  };
}

// ---- review and appeal state -------------------------------------------------

export interface AttemptReviewRow {
  attemptId: string;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  appealState: "none" | "open" | "closed";
  appealChangedAt: Date | null;
  uploadRefused: boolean;
}
interface ReviewDb {
  attempt_id: string; reviewed_at: Date | null; reviewed_by: string | null;
  appeal_state: "none" | "open" | "closed"; appeal_changed_at: Date | null; upload_refused: boolean;
}
const REVIEW_COLS = `attempt_id, reviewed_at, reviewed_by, appeal_state, appeal_changed_at, upload_refused`;
const mapReview = (r: ReviewDb): AttemptReviewRow => ({
  attemptId: r.attempt_id, reviewedAt: r.reviewed_at, reviewedBy: r.reviewed_by,
  appealState: r.appeal_state, appealChangedAt: r.appeal_changed_at, uploadRefused: r.upload_refused,
});

export async function getAttemptReview(client: PoolClient, attemptId: string): Promise<AttemptReviewRow | null> {
  const r = await client.query<ReviewDb>(`SELECT ${REVIEW_COLS} FROM camera_attempt_reviews WHERE attempt_id = $1`, [attemptId]);
  return r.rows[0] ? mapReview(r.rows[0]) : null;
}

export async function upsertAttemptReview(client: PoolClient, tenantId: string, attemptId: string): Promise<AttemptReviewRow> {
  const r = await client.query<ReviewDb>(
    `INSERT INTO camera_attempt_reviews (tenant_id, attempt_id) VALUES ($1, $2)
     ON CONFLICT (tenant_id, attempt_id) DO UPDATE SET updated_at = camera_attempt_reviews.updated_at
     RETURNING ${REVIEW_COLS}`,
    [tenantId, attemptId],
  );
  return mapReview(r.rows[0]!);
}

export async function markReviewed(client: PoolClient, tenantId: string, attemptId: string, reviewerId: string): Promise<AttemptReviewRow> {
  const r = await client.query<ReviewDb>(
    `INSERT INTO camera_attempt_reviews (tenant_id, attempt_id, reviewed_at, reviewed_by) VALUES ($1, $2, now(), $3)
     ON CONFLICT (tenant_id, attempt_id) DO UPDATE SET reviewed_at = now(), reviewed_by = $3, updated_at = now()
     RETURNING ${REVIEW_COLS}`,
    [tenantId, attemptId, reviewerId],
  );
  return mapReview(r.rows[0]!);
}

export async function setAppealState(
  client: PoolClient,
  tenantId: string,
  attemptId: string,
  state: "none" | "open" | "closed",
): Promise<AttemptReviewRow> {
  const r = await client.query<ReviewDb>(
    `INSERT INTO camera_attempt_reviews (tenant_id, attempt_id, appeal_state, appeal_changed_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (tenant_id, attempt_id) DO UPDATE SET appeal_state = $3, appeal_changed_at = now(), updated_at = now()
     RETURNING ${REVIEW_COLS}`,
    [tenantId, attemptId, state],
  );
  return mapReview(r.rows[0]!);
}

export async function markUploadRefused(client: PoolClient, tenantId: string, attemptId: string): Promise<void> {
  await client.query(
    `INSERT INTO camera_attempt_reviews (tenant_id, attempt_id, upload_refused) VALUES ($1, $2, true)
     ON CONFLICT (tenant_id, attempt_id) DO UPDATE SET upload_refused = true, updated_at = now()`,
    [tenantId, attemptId],
  );
}

// ---- reviewers ---------------------------------------------------------------

export async function listReviewers(client: PoolClient): Promise<Array<{ userId: string; addedBy: string; createdAt: Date }>> {
  const r = await client.query<{ user_id: string; added_by: string; created_at: Date }>(
    `SELECT user_id, added_by, created_at FROM camera_reviewers ORDER BY created_at, user_id`,
  );
  return r.rows.map((x) => ({ userId: x.user_id, addedBy: x.added_by, createdAt: x.created_at }));
}

export async function addReviewer(client: PoolClient, tenantId: string, userId: string, addedBy: string): Promise<void> {
  await client.query(
    `INSERT INTO camera_reviewers (tenant_id, user_id, added_by) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, user_id) DO NOTHING`,
    [tenantId, userId, addedBy],
  );
}

export async function removeReviewer(client: PoolClient, userId: string): Promise<boolean> {
  const r = await client.query(`DELETE FROM camera_reviewers WHERE user_id = $1`, [userId]);
  return (r.rowCount ?? 0) > 0;
}

export async function isReviewer(client: PoolClient, userId: string): Promise<boolean> {
  const r = await client.query(`SELECT 1 FROM camera_reviewers WHERE user_id = $1`, [userId]);
  return (r.rowCount ?? 0) > 0;
}
