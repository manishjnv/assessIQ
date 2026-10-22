// AssessIQ — real-exam camera, staff side (Batch A part 2).
//
// File routes (flagged list, file list, file content, reviewed, appeal) need a CAMERA REVIEWER:
// the platform super admin, or a tenant admin who is named in camera_reviewers. A plain tenant admin
// who is not named gets 403. Reviewer admin, settings and notice routes need a tenant admin.
// The school flag is super admin only. Files are streamed from disk behind a session check, one
// audit row each time (camera.file.viewed); there is no public URL and no static plugin.
// No AI, no image processing.

import { createReadStream, promises as fs } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { AuthzError, NotFoundError, ValidationError, streamLogger } from "@assessiq/core";
import { getCameraTenantSettings, confirmCameraNotice, setTenantIsSchool, updateCameraSettings, withTenant } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import { CAMERA_NOTICE_VERSION, PHOTO_MIME, VIDEO_MIME } from "./camera/constants.js";
import {
  addReviewer,
  getAttemptReview,
  getFileForView,
  isReviewer,
  listFlaggedAttempts,
  listReviewers,
  markReviewed,
  removeReviewer,
  setAppealState,
} from "./camera/repository.js";
import { diskGuard, resolveSafe } from "./camera/storage.js";

const log = streamLogger("app");

export interface CameraUserLookup {
  /** Display data for a user of this tenant, or null when the user does not exist in it. */
  get(tenantId: string, userId: string): Promise<{ id: string; name: string; email: string } | null>;
}

export interface RegisterCameraAdminRoutesOptions {
  /** Tenant admin chain (super admin also passes). */
  adminOnly: preHandlerHookHandler[] | preHandlerHookHandler;
  /** Super admin only chain, for the school flag. */
  superAdminOnly: preHandlerHookHandler[] | preHandlerHookHandler;
  /** From apps/api (the users module). Optional so module tests can run without it: names then stay empty. */
  users?: CameraUserLookup;
}

const uuid = z.string().uuid();
const attemptIdParams = z.object({ attemptId: uuid });
const fileIdParams = z.object({ fileId: uuid });
const userIdParams = z.object({ userId: uuid });
const tenantIdParams = z.object({ tenantId: uuid });
const listQuery = z.object({
  cursor: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const appealBody = z.object({ state: z.enum(["open", "closed", "none"]) });
const reviewerBody = z.object({ userId: uuid });
const settingsBody = z.object({ cameraEnabled: z.boolean().optional(), photosEnabled: z.boolean().optional() });
const confirmBody = z.object({ confirm: z.literal(true) });
const schoolBody = z.object({ isSchool: z.boolean() });

function parseOr400<S extends z.ZodTypeAny>(schema: S, data: unknown, part: "body" | "params" | "query"): z.infer<S> {
  const r = schema.safeParse(data);
  if (r.success) return r.data as z.infer<S>;
  const first = r.error.issues[0];
  throw new ValidationError(first?.message ?? `invalid request ${part}`, {
    details: { code: `INVALID_${part.toUpperCase()}`, part, issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
  });
}

/** Super admin, or a tenant admin named in camera_reviewers. Runs AFTER the adminOnly chain. */
export const requireCameraReviewer: preHandlerHookHandler = async (req) => {
  const s = req.session;
  if (s === undefined) throw new AuthzError("not signed in");
  if (s.role === "super_admin") return;
  if (s.role === "admin" && (await withTenant(s.tenantId, (c) => isReviewer(c, s.userId)))) return;
  throw new AuthzError("camera reviewer access required", { details: { code: "CAMERA_REVIEWER_REQUIRED" } });
};

const asChain = (a: preHandlerHookHandler[] | preHandlerHookHandler): preHandlerHookHandler[] => (Array.isArray(a) ? a : [a]);

export async function registerCameraAdminRoutes(app: FastifyInstance, opts: RegisterCameraAdminRoutesOptions): Promise<void> {
  const reviewerOnly = [...asChain(opts.adminOnly), requireCameraReviewer];
  const adminOnly = opts.adminOnly;
  const { users } = opts;

  // ---- flagged attempts ---------------------------------------------------------------------
  // Nav probe: always 200 for an admin, so a non-reviewer does not log a 403 in the browser console on every page.
  app.get("/api/admin/camera/access", { preHandler: adminOnly }, async (req) => {
    const s = req.session!;
    const reviewer = s.role === "super_admin" || (s.role === "admin" && (await withTenant(s.tenantId, (c) => isReviewer(c, s.userId))));
    return { reviewer };
  });

  app.get("/api/admin/camera/flagged", { preHandler: reviewerOnly }, async (req) => {
    const q = parseOr400(listQuery, req.query, "query");
    const { tenantId } = req.session!;
    const page = await withTenant(tenantId, (c) => listFlaggedAttempts(c, { limit: q.limit ?? 50, cursor: q.cursor ?? null }));
    const names = new Map<string, { name: string; email: string }>();
    if (users !== undefined) {
      await Promise.all(
        [...new Set(page.items.map((i) => i.userId))].map(async (id) => {
          const u = await users.get(tenantId, id).catch(() => null);
          if (u !== null) names.set(id, { name: u.name, email: u.email });
        }),
      );
    }
    return {
      items: page.items.map((i) => ({
        attemptId: i.attemptId,
        userId: i.userId,
        candidateName: names.get(i.userId)?.name ?? null,
        candidateEmail: names.get(i.userId)?.email ?? null,
        assessmentId: i.assessmentId,
        assessmentName: i.assessmentName,
        flaggedFiles: i.flaggedFiles,
        lastFlaggedAt: i.lastFlaggedAt.toISOString(),
        reviewedAt: i.reviewedAt?.toISOString() ?? null,
        appealState: i.appealState,
        uploadRefused: i.uploadRefused,
      })),
      nextCursor: page.nextCursor,
    };
  });

  // ---- file list (metadata only) ------------------------------------------------------------
  app.get("/api/admin/camera/attempts/:attemptId/files", { preHandler: reviewerOnly }, async (req) => {
    const { attemptId } = parseOr400(attemptIdParams, req.params, "params");
    const rows = await withTenant(req.session!.tenantId, async (c) => {
      const a = await c.query(`SELECT 1 FROM attempts WHERE id = $1`, [attemptId]);
      if (a.rowCount === 0) throw new NotFoundError("attempt not found");
      const r = await c.query<{ id: string; kind: string; taken_at: Date; flagged: boolean; flag_reason: string | null; size_bytes: string }>(
        `SELECT id, kind, taken_at, flagged, flag_reason, size_bytes::text FROM camera_files WHERE attempt_id = $1 ORDER BY taken_at, id`,
        [attemptId],
      );
      const review = await getAttemptReview(c, attemptId);
      return { files: r.rows, review };
    });
    return {
      items: rows.files.map((f) => ({
        id: f.id,
        kind: f.kind,
        takenAt: f.taken_at.toISOString(),
        flagged: f.flagged,
        flagReason: f.flag_reason,
        sizeBytes: Number(f.size_bytes),
      })),
      review:
        rows.review === null
          ? { reviewedAt: null, appealState: "none", uploadRefused: false }
          : {
              reviewedAt: rows.review.reviewedAt?.toISOString() ?? null,
              appealState: rows.review.appealState,
              uploadRefused: rows.review.uploadRefused,
            },
    };
  });

  // ---- file content -------------------------------------------------------------------------
  app.get("/api/admin/camera/files/:fileId/content", { preHandler: reviewerOnly }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { fileId } = parseOr400(fileIdParams, req.params, "params");
    const { tenantId, userId } = req.session!;
    // One tx: RLS-scoped load, then the audit row. It commits BEFORE any byte is sent.
    const file = await withTenant(tenantId, async (c) => {
      const f = await getFileForView(c, fileId);
      if (f === null) return null;
      await auditInTx(c, {
        tenantId,
        actorKind: "user",
        actorUserId: userId,
        action: "camera.file.viewed",
        entityType: "camera_file",
        entityId: f.id,
      });
      return f;
    });
    if (file === null) throw new NotFoundError("file not found");
    let abs: string;
    let size: number;
    try {
      abs = await resolveSafe(file.storagePath);
      size = (await fs.stat(abs)).size;
    } catch (err) {
      log.warn({ fileId, error: err instanceof Error ? err.message : String(err) }, "camera file missing on disk");
      throw new NotFoundError("file not found");
    }
    return reply
      .header("Content-Type", file.kind === "photo" ? PHOTO_MIME : VIDEO_MIME)
      .header("Content-Length", String(size))
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Disposition", "inline")
      .send(createReadStream(abs));
  });

  // ---- review and appeal --------------------------------------------------------------------
  app.post("/api/admin/camera/attempts/:attemptId/reviewed", { preHandler: reviewerOnly }, async (req) => {
    const { attemptId } = parseOr400(attemptIdParams, req.params, "params");
    const { tenantId, userId } = req.session!;
    await withTenant(tenantId, async (c) => {
      if ((await c.query(`SELECT 1 FROM attempts WHERE id = $1`, [attemptId])).rowCount === 0) throw new NotFoundError("attempt not found");
      const r = await markReviewed(c, tenantId, attemptId, userId);
      await auditInTx(c, {
        tenantId,
        actorKind: "user",
        actorUserId: userId,
        action: "camera.review.marked",
        entityType: "attempt",
        entityId: attemptId,
        after: { reviewedAt: r.reviewedAt?.toISOString() ?? null },
      });
    });
    return { ok: true };
  });

  app.post("/api/admin/camera/attempts/:attemptId/appeal", { preHandler: reviewerOnly }, async (req) => {
    const { attemptId } = parseOr400(attemptIdParams, req.params, "params");
    const body = parseOr400(appealBody, req.body, "body");
    const { tenantId, userId } = req.session!;
    await withTenant(tenantId, async (c) => {
      if ((await c.query(`SELECT 1 FROM attempts WHERE id = $1`, [attemptId])).rowCount === 0) throw new NotFoundError("attempt not found");
      const before = (await getAttemptReview(c, attemptId))?.appealState ?? "none";
      await setAppealState(c, tenantId, attemptId, body.state);
      await auditInTx(c, {
        tenantId,
        actorKind: "user",
        actorUserId: userId,
        action: "camera.appeal.changed",
        entityType: "attempt",
        entityId: attemptId,
        before: { appealState: before },
        after: { appealState: body.state },
      });
    });
    return { ok: true };
  });

  // ---- reviewers (tenant admin) -------------------------------------------------------------
  app.get("/api/admin/camera/reviewers", { preHandler: adminOnly }, async (req) => {
    const { tenantId } = req.session!;
    const rows = await withTenant(tenantId, (c) => listReviewers(c));
    const items = await Promise.all(
      rows.map(async (r) => {
        const u = users === undefined ? null : await users.get(tenantId, r.userId).catch(() => null);
        return { userId: r.userId, name: u?.name ?? null, email: u?.email ?? null, addedBy: r.addedBy, createdAt: r.createdAt.toISOString() };
      }),
    );
    return { items };
  });

  app.post("/api/admin/camera/reviewers", { preHandler: adminOnly }, async (req, reply) => {
    const body = parseOr400(reviewerBody, req.body, "body");
    const { tenantId, userId, role } = req.session!;
    // A3-5: another person must grant the reviewer role; only a super admin may add themselves.
    if (body.userId === userId && role !== "super_admin") {
      throw new AuthzError("Another administrator must add you as a camera reviewer.");
    }
    if (users !== undefined && (await users.get(tenantId, body.userId)) === null) throw new NotFoundError("user not found in this organisation");
    await withTenant(tenantId, async (c) => {
      // Without a users lookup (module tests) the FK-free table still needs a tenant check: the user row is RLS-scoped.
      if (users === undefined && (await c.query(`SELECT 1 FROM users WHERE id = $1`, [body.userId])).rowCount === 0) {
        throw new NotFoundError("user not found in this organisation");
      }
      await addReviewer(c, tenantId, body.userId, userId);
      await auditInTx(c, {
        tenantId,
        actorKind: "user",
        actorUserId: userId,
        action: "camera.reviewer.added",
        entityType: "user",
        entityId: body.userId,
      });
    });
    return reply.code(201).send({ ok: true });
  });

  app.delete("/api/admin/camera/reviewers/:userId", { preHandler: adminOnly }, async (req) => {
    const p = parseOr400(userIdParams, req.params, "params");
    const { tenantId, userId } = req.session!;
    await withTenant(tenantId, async (c) => {
      if (!(await removeReviewer(c, p.userId))) throw new NotFoundError("reviewer not found");
      await auditInTx(c, {
        tenantId,
        actorKind: "user",
        actorUserId: userId,
        action: "camera.reviewer.removed",
        entityType: "user",
        entityId: p.userId,
      });
    });
    return { ok: true };
  });

  // ---- settings (tenant admin) --------------------------------------------------------------
  app.get("/api/admin/camera/settings", { preHandler: adminOnly }, async (req) => {
    const s = await getCameraTenantSettings(req.session!.tenantId);
    const g = await diskGuard({ incomingBytes: 0 });
    return {
      isSchool: s.isSchool,
      cameraEnabled: s.cameraEnabled,
      photosEnabled: s.photosEnabled,
      noticeConfirmedVersion: s.noticeConfirmedVersion,
      requiredNoticeVersion: CAMERA_NOTICE_VERSION,
      // The usage is system wide (one disk for every organisation).
      storage: { usedBytes: g.usedBytes, maxBytes: g.maxBytes, warn: g.warn },
    };
  });

  app.patch("/api/admin/camera/settings", { preHandler: adminOnly }, async (req, reply) => {
    const body = parseOr400(settingsBody, req.body, "body");
    const { tenantId, userId } = req.session!;
    if (!(await getCameraTenantSettings(tenantId)).isSchool) {
      return reply.code(403).send({ error: { code: "CAMERA_SCHOOL_ONLY", message: "Only a school can change these camera settings." } });
    }
    await updateCameraSettings(
      tenantId,
      {
        ...(body.cameraEnabled !== undefined ? { cameraEnabled: body.cameraEnabled } : {}),
        ...(body.photosEnabled !== undefined ? { photosEnabled: body.photosEnabled } : {}),
      },
      userId,
    );
    return { ok: true };
  });

  app.post("/api/admin/camera/confirm-notice", { preHandler: adminOnly }, async (req) => {
    parseOr400(confirmBody, req.body, "body");
    const { tenantId, userId } = req.session!;
    await confirmCameraNotice(tenantId, CAMERA_NOTICE_VERSION, userId);
    return { ok: true, noticeConfirmedVersion: CAMERA_NOTICE_VERSION };
  });

  // ---- school flag (super admin only) -------------------------------------------------------
  app.post("/api/admin/platform/tenants/:tenantId/school", { preHandler: opts.superAdminOnly }, async (req) => {
    const p = parseOr400(tenantIdParams, req.params, "params");
    const body = parseOr400(schoolBody, req.body, "body");
    await setTenantIsSchool(p.tenantId, body.isSchool, req.session!.userId);
    return { ok: true, isSchool: body.isSchool };
  });
}
