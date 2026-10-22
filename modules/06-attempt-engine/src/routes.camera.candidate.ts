// AssessIQ — real-exam camera, candidate side (Batch A part 2).
//
//   GET  /api/me/attempts/:attemptId/camera/status
//   POST /api/me/attempts/:attemptId/camera/photo           (image/jpeg body)
//   POST /api/me/attempts/:attemptId/camera/video?reason=   (video/webm body; camera_stopped | camera_blocked)
//
// Registered as an ENCAPSULATED plugin: the raw-body parsers for image/jpeg and video/webm exist
// only inside this scope, so the global parsers are untouched. No AI, no image processing, no face
// matching: bytes are checked (type, size, magic number) and stored as they are.
//
// The server decides everything. The client sends no time, no path and no filename. The camera
// policy is re-resolved on every upload from the attempt row and the tenant settings.

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { streamLogger } from "@assessiq/core";
import { consumeRateLimit } from "@assessiq/auth";
import { withTenant } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import type { PoolClient } from "pg";
import {
  CAMERA_NOTICE_VERSION,
  MAX_PHOTOS_PER_ATTEMPT,
  MAX_VIDEOS_PER_ATTEMPT,
  PHOTO_INTERVAL_SECONDS,
  PHOTO_MAX_BYTES,
  PHOTO_MIME,
  UPLOAD_MAX_PER_ATTEMPT_PER_MIN,
  VIDEO_MAX_BYTES,
  VIDEO_MIME,
  type CameraFileKind,
  type CameraFlagReason,
} from "./camera/constants.js";
import { resolvePolicyInTx } from "./camera/gate.js";
import { computeExpiresAt, type CameraPolicy } from "./camera/policy.js";
import {
  countFilesForAttempt,
  hasAgreedConsentForAttempt,
  insertCameraFile,
  markUploadRefused,
} from "./camera/repository.js";
import { buildCameraRelativePath, deleteFile, diskGuard, writeFileAtomic } from "./camera/storage.js";

const log = streamLogger("app");

export interface RegisterCameraCandidateRoutesOptions {
  candidateOnly: preHandlerHookHandler[] | preHandlerHookHandler;
}

/** Same body for every "not yours / not there" outcome, so an id cannot be probed. */
const NOT_FOUND = { error: { code: "ATTEMPT_NOT_FOUND", message: "Attempt not found." } };
const END_GRACE_MS = 60_000;
const WARN_EVERY_MS = 10 * 60_000;
// ponytail: per-process throttle for the 80 percent log line; one line per 10 minutes per process is enough.
let lastWarnAt = 0;

const attemptParams = z.object({ attemptId: z.string().uuid() });
const videoQuery = z.object({ reason: z.enum(["camera_stopped", "camera_blocked"]) });

const fail = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ error: { code, message } });

interface AttemptFacts {
  userId: string;
  status: string;
  endsAt: Date | null;
  deliveryMode: "real" | "mock";
  embedOrigin: boolean;
}

async function loadOwnedAttempt(client: PoolClient, attemptId: string, userId: string): Promise<AttemptFacts | null> {
  const r = await client.query<{ user_id: string; status: string; ends_at: Date | null; delivery_mode: string; embed_origin: boolean }>(
    `SELECT user_id, status, ends_at, delivery_mode, embed_origin FROM attempts WHERE id = $1`,
    [attemptId],
  );
  const row = r.rows[0];
  if (row === undefined || row.user_id !== userId) return null;
  return {
    userId: row.user_id,
    status: row.status,
    endsAt: row.ends_at,
    deliveryMode: row.delivery_mode === "mock" ? "mock" : "real",
    embedOrigin: row.embed_origin,
  };
}

const hasMagic = (kind: CameraFileKind, b: Buffer): boolean =>
  kind === "photo"
    ? b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
    : b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;

export async function registerCameraCandidateRoutes(
  app: FastifyInstance,
  opts: RegisterCameraCandidateRoutesOptions,
): Promise<void> {
  await app.register(async (scope) => {
    // The default text parser would answer binary text/plain with a 400; drop it so any other type is a plain 415.
    scope.removeContentTypeParser("text/plain");
    for (const mime of [PHOTO_MIME, VIDEO_MIME]) {
      scope.addContentTypeParser(mime, { parseAs: "buffer", bodyLimit: VIDEO_MAX_BYTES }, (_req, body, done) => {
        done(null, body);
      });
    }

    // ---- status -----------------------------------------------------------------------------
    scope.get("/api/me/attempts/:attemptId/camera/status", { preHandler: opts.candidateOnly }, async (req, reply) => {
      const p = attemptParams.safeParse(req.params);
      if (!p.success) return reply.code(404).send(NOT_FOUND);
      const { tenantId, userId } = req.session!;
      const out = await withTenant(tenantId, async (client) => {
        const a = await loadOwnedAttempt(client, p.data.attemptId, userId);
        if (a === null) return null;
        return (await resolvePolicyInTx(client, tenantId, a.deliveryMode, a.embedOrigin)).policy;
      });
      if (out === null) return reply.code(404).send(NOT_FOUND);
      return {
        required: out.required,
        photos: out.photos,
        video: out.video,
        photoIntervalSeconds: PHOTO_INTERVAL_SECONDS,
        noticeVersion: CAMERA_NOTICE_VERSION,
      };
    });

    // ---- uploads ----------------------------------------------------------------------------
    async function upload(kind: CameraFileKind, req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
      const p = attemptParams.safeParse(req.params);
      if (!p.success) return reply.code(404).send(NOT_FOUND);
      const attemptId = p.data.attemptId;
      const { tenantId, userId } = req.session!;

      let reason: CameraFlagReason | null = null;
      if (kind === "video") {
        const q = videoQuery.safeParse(req.query);
        if (!q.success) return fail(reply, 400, "INVALID_REASON", "reason must be camera_stopped or camera_blocked.");
        reason = q.data.reason;
      }

      // 1. Owner, active window, policy, consent and counts: one read tx, no writes.
      const pre = await withTenant(tenantId, async (client) => {
        const a = await loadOwnedAttempt(client, attemptId, userId);
        if (a === null) return { code: 404 as const };
        if (a.status !== "in_progress" || (a.endsAt !== null && Date.now() > a.endsAt.getTime() + END_GRACE_MS)) {
          return { code: 409 as const };
        }
        const { policy } = await resolvePolicyInTx(client, tenantId, a.deliveryMode, a.embedOrigin);
        if (!policy.required) return { code: "not_required" as const };
        if (kind === "photo" && !policy.photos) return { code: "photos_off" as const };
        if (!(await hasAgreedConsentForAttempt(client, attemptId))) return { code: "no_consent" as const };
        return { code: "ok" as const, policy, count: await countFilesForAttempt(client, attemptId, kind) };
      });
      if (pre.code === 404) return reply.code(404).send(NOT_FOUND);
      if (pre.code === 409) return fail(reply, 409, "ATTEMPT_NOT_ACTIVE", "This attempt is not active.");
      if (pre.code === "not_required") return fail(reply, 403, "CAMERA_NOT_REQUIRED", "The camera is not required for this test.");
      if (pre.code === "photos_off") return fail(reply, 403, "CAMERA_PHOTOS_OFF", "Photos are switched off for this organisation.");
      if (pre.code === "no_consent") return fail(reply, 403, "CAMERA_CONSENT_REQUIRED", "Camera consent is required.");
      const policy: CameraPolicy = pre.policy;

      // 2. Rate limit per attempt.
      const bucket = await consumeRateLimit(`aiq:rl:camera-up:${attemptId}`, UPLOAD_MAX_PER_ATTEMPT_PER_MIN, 60);
      if (!bucket.allowed) {
        reply.header("Retry-After", String(bucket.retryAfterSeconds));
        return fail(reply, 429, "RATE_LIMITED", "Too many camera uploads. Please wait a moment.");
      }

      // 3. Content type (exact media type; codec parameters such as ;codecs=vp9 are allowed), size, magic bytes.
      const mime = kind === "photo" ? PHOTO_MIME : VIDEO_MIME;
      const ct = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      if (ct !== mime) return fail(reply, 415, "UNSUPPORTED_MEDIA_TYPE", `Content-Type must be ${mime}.`);
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) return fail(reply, 400, "EMPTY_BODY", "The upload is empty.");
      if (body.length > (kind === "photo" ? PHOTO_MAX_BYTES : VIDEO_MAX_BYTES)) {
        return fail(reply, 413, "PAYLOAD_TOO_LARGE", "The upload is too large.");
      }
      if (!hasMagic(kind, body)) return fail(reply, 415, "UNSUPPORTED_MEDIA_TYPE", "The file is not a valid image or video.");

      // 4. Per-attempt caps.
      if (pre.count >= (kind === "photo" ? MAX_PHOTOS_PER_ATTEMPT : MAX_VIDEOS_PER_ATTEMPT)) {
        return fail(reply, 429, "CAMERA_LIMIT", "The camera upload limit for this attempt is reached.");
      }

      // 5. Disk guard.
      const guard = await diskGuard({ incomingBytes: body.length });
      if (guard.full) {
        await withTenant(tenantId, async (client) => {
          await markUploadRefused(client, tenantId, attemptId);
          await auditInTx(client, {
            tenantId,
            actorKind: "user",
            actorUserId: userId,
            action: "camera.upload.refused",
            entityType: "attempt",
            entityId: attemptId,
            after: { kind, usedBytes: guard.usedBytes, maxBytes: guard.maxBytes },
          });
        });
        log.warn({ attemptId, usedBytes: guard.usedBytes, maxBytes: guard.maxBytes }, "camera upload refused: storage full");
        return fail(reply, 507, "CAMERA_STORAGE_FULL", "The camera could not be saved because storage is full. The organiser has been flagged.");
      }
      if (guard.warn && Date.now() - lastWarnAt > WARN_EVERY_MS) {
        lastWarnAt = Date.now();
        log.warn({ usedBytes: guard.usedBytes, maxBytes: guard.maxBytes }, "camera storage is at 80 percent or more of its cap");
      }

      // 6. Write the file, then the row. A DB failure removes the file again.
      const fileId = randomUUID();
      const rel = buildCameraRelativePath(tenantId, attemptId, fileId, kind);
      await writeFileAtomic(rel, body);
      const takenAt = new Date(); // server clock only
      let overLimit = false;
      try {
        await withTenant(tenantId, async (client) => {
          // A3-7: recount under a per-attempt advisory lock so parallel uploads cannot pass the cap together.
          await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [attemptId]);
          if ((await countFilesForAttempt(client, attemptId, kind)) >= (kind === "photo" ? MAX_PHOTOS_PER_ATTEMPT : MAX_VIDEOS_PER_ATTEMPT)) {
            overLimit = true;
            return;
          }
          await insertCameraFile(client, {
            id: fileId,
            tenantId,
            attemptId,
            userId,
            kind,
            storagePath: rel,
            sizeBytes: body.length,
            takenAt,
            expiresAt: computeExpiresAt(kind, takenAt, policy),
            flagged: kind === "video",
            flagReason: reason,
          });
        });
      } catch (err) {
        await deleteFile(rel).catch(() => undefined);
        throw err;
      }
      if (overLimit) {
        await deleteFile(rel).catch(() => undefined);
        return fail(reply, 429, "CAMERA_LIMIT", "The camera upload limit for this attempt is reached.");
      }
      return reply.code(201).send({ id: fileId });
    }

    scope.post("/api/me/attempts/:attemptId/camera/photo", { preHandler: opts.candidateOnly, bodyLimit: PHOTO_MAX_BYTES + 1024 }, (req, reply) =>
      upload("photo", req, reply),
    );
    scope.post("/api/me/attempts/:attemptId/camera/video", { preHandler: opts.candidateOnly, bodyLimit: VIDEO_MAX_BYTES + 1024 }, (req, reply) =>
      upload("video", req, reply),
    );
  });
}
