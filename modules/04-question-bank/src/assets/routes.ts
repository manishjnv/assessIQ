// EXP-10 part 1: admin routes for question images.
//   POST /api/admin/question-assets          multipart (file, pack_id, alt_text) or JSON { pack_id, alt_text, content_base64 }
//   GET  /api/admin/question-assets/:id/meta JSON metadata (never the bytes)
//   GET  /api/admin/question-assets/:id      the cleaned bytes, with locked-down headers
// Auth is the admin chain passed in by routes.ts. Tenant and actor come from the session, never from the body.
import type {} from "@fastify/multipart"; // request.file() / isMultipart() types only; the plugin is registered by apps/api
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { AppError, ValidationError } from "@assessiq/core";
import { ASSET_MAX_BYTES } from "./image-clean.js";
import { getAssetBytes, getAssetMeta, uploadQuestionAsset } from "./assets.js";

const JsonBody = z.object({
  pack_id: z.string().uuid(),
  alt_text: z.string().max(2000),
  content_base64: z.string().min(1), // size is judged on the decoded bytes (413); the route bodyLimit stops anything huge first
}).strict();
const IdParams = z.object({ id: z.string().uuid() });

const tooLarge = (): AppError => new AppError("The image is larger than 400 KB.", "ASSET_TOO_LARGE", 413, { details: { code: "ASSET_TOO_LARGE" } });

async function readUpload(req: FastifyRequest): Promise<{ packId: unknown; alt: unknown; data: Buffer }> {
  if (req.isMultipart()) {
    let part;
    try {
      // Per-call limit: stop reading at 400 KB + 1, not at the global 4 MB.
      part = await req.file({ limits: { fileSize: ASSET_MAX_BYTES + 1 } });
    } catch (e) {
      if ((e as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") throw tooLarge();
      throw e;
    }
    if (part === undefined) throw new ValidationError("file part is required", { details: { code: "ASSET_FILE_REQUIRED" } });
    const text = (k: string): unknown => (part!.fields[k] as { value?: unknown } | undefined)?.value;
    let data: Buffer;
    try { data = await part.toBuffer(); } catch (e) {
      if ((e as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") throw tooLarge();
      throw e;
    }
    if (part.file.truncated || data.length > ASSET_MAX_BYTES) throw tooLarge();
    return { packId: text("pack_id"), alt: text("alt_text"), data };
  }
  const r = JsonBody.safeParse(req.body ?? {});
  if (!r.success) throw new ValidationError("invalid body", { details: { code: "INVALID_PARAM", issues: r.error.issues } });
  const data = Buffer.from(r.data.content_base64, "base64");
  if (data.length > ASSET_MAX_BYTES) throw tooLarge();
  return { packId: r.data.pack_id, alt: r.data.alt_text, data };
}

/** Headers for every response that carries image bytes. */
export function assetResponseHeaders(mime: string, sha256: string): Record<string, string> {
  return {
    "content-type": mime,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "same-origin",
    "content-disposition": 'inline; filename="image"',
    "cache-control": "private, max-age=3600",
    etag: `"${sha256}"`,
  };
}

export function registerAssetRoutes(app: FastifyInstance, adminOnly: preHandlerHookHandler[] | preHandlerHookHandler): void {
  app.post("/api/admin/question-assets", { preHandler: adminOnly, bodyLimit: 700 * 1024 }, async (req, reply) => {
    const { packId, alt, data } = await readUpload(req);
    const meta = await uploadQuestionAsset(req.session!.tenantId, req.session!.userId, packId as string, data, alt);
    return reply.code(meta.deduped ? 200 : 201).send(meta);
  });

  app.get("/api/admin/question-assets/:id/meta", { preHandler: adminOnly }, async (req) => {
    const p = IdParams.safeParse(req.params);
    if (!p.success) throw new ValidationError("invalid id", { details: { code: "INVALID_PARAM" } });
    return getAssetMeta(req.session!.tenantId, p.data.id);
  });

  app.get("/api/admin/question-assets/:id", { preHandler: adminOnly }, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    if (!p.success) throw new ValidationError("invalid id", { details: { code: "INVALID_PARAM" } });
    const a = await getAssetBytes(req.session!.tenantId, p.data.id);
    return reply.headers(assetResponseHeaders(a.mime, a.sha256)).send(a.data);
  });
}
