// RW-58: super-admin CSV/XLSX question import routes (staged -> fix rows -> commit | discard).
// Body is JSON with a base64 file, or multipart/form-data (RW-97).
import type {} from "@fastify/multipart"; // request.file() / isMultipart() types only; the plugin is registered by apps/api
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { AppError, ValidationError, sha256Hex } from "@assessiq/core";
import { QUESTION_TYPES } from "@assessiq/question-types";
import { parseImportFile, IMPORT_MAX_BYTES } from "./import/parse.js";
import { stageImport, getImportReport, fixImportRow, discardImport, TENANT_UPLOAD_RIGHTS, type TenantUploadRights } from "./import/staging.js";
import { commitImport } from "./import/commit.js";
import { buildTemplate } from "./import/templates.js";
import { exportPackQti } from "./import/export.js";
import { withdrawQuestion } from "./service/questions.js";
import { listOrgUploads, withdrawImport } from "./import/org-uploads.js";

const uuid = z.string().uuid();
const Format = z.enum(["csv", "xlsx", "gift", "aiken", "qti"]);
// Templates exist for the spreadsheet formats only.
const TemplateFormat = z.enum(["csv", "xlsx"]);
const IdParams = z.object({ id: uuid });
const RowParams = z.object({ id: uuid, row: z.coerce.number().int().min(1) });
const TemplateParams = z.object({ type: z.enum(QUESTION_TYPES) });
const TemplateQuery = z.object({ format: TemplateFormat.default("csv") });
const UploadBody = z.object({
  file_name: z.string().min(1).max(200),
  format: Format,
  content_base64: z.string().min(1).max(Math.ceil((IMPORT_MAX_BYTES * 4) / 3) + 8),
  domain: z.string().min(1).max(80),
  pack_name: z.string().min(1).max(200).optional(),
  /** EXP-17: default source reference for every row that has no source_ref cell of its own. */
  source_ref: z.string().max(500).optional(),
});
const MultipartFields = UploadBody.omit({ content_base64: true });
const PatchBody = z.object({
  values: z.record(z.string().max(20_000)).optional(),
  skip: z.boolean().optional(),
}).refine((b) => b.values !== undefined || b.skip !== undefined, { message: "values or skip is required" });

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, v: unknown, what: string): T {
  const r = schema.safeParse(v);
  if (!r.success) {
    throw new ValidationError(`invalid ${what}`, { details: { code: "INVALID_PARAM", issues: r.error.issues } });
  }
  return r.data;
}

const TenantExtra = z.object({
  content_warranty: z.literal(true, { errorMap: () => ({ message: "content_warranty must be true: you must hold the rights to this content" }) }),
  rights_status: z.enum(TENANT_UPLOAD_RIGHTS),
});

type Upload = { fileName: string; format: z.infer<typeof Format>; domain: string; packName: string | undefined; sourceRef?: string | undefined; data: Buffer };

/** Reads a JSON-base64 or multipart upload. `extra` carries the tenant-only fields (warranty, rights). */
async function readUpload(req: FastifyRequest): Promise<{ upload: Upload; extra: Record<string, unknown> }> {
  const tooLarge = () => new AppError("The file is larger than 4 MB.", "FILE_TOO_LARGE", 413);
  if (req.isMultipart()) {
    let part;
    try { part = await req.file(); } catch (e) {
      if ((e as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") throw tooLarge();
      throw e;
    }
    if (part === undefined) throw new ValidationError("invalid body", { details: { code: "INVALID_PARAM", issues: [{ message: "file part is required" }] } });
    let data: Buffer;
    try { data = await part.toBuffer(); } catch (e) {
      if ((e as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") throw tooLarge();
      throw e;
    }
    if (part.file.truncated) throw tooLarge();
    const text = (k: string): string | undefined => {
      const f = part.fields[k] as { value?: unknown } | undefined;
      return typeof f?.value === "string" ? f.value : undefined;
    };
    const f = parse(MultipartFields, {
      file_name: text("file_name") ?? part.filename, format: text("format"), domain: text("domain"), pack_name: text("pack_name"), source_ref: text("source_ref"),
    }, "body");
    return {
      upload: { fileName: f.file_name, format: f.format, domain: f.domain, packName: f.pack_name, sourceRef: f.source_ref, data },
      extra: { content_warranty: text("content_warranty") === "true" ? true : undefined, rights_status: text("rights_status") },
    };
  }
  const raw = (req.body ?? {}) as Record<string, unknown>;
  const body = parse(UploadBody, raw, "body");
  return {
    upload: { fileName: body.file_name, format: body.format, domain: body.domain, packName: body.pack_name, sourceRef: body.source_ref, data: Buffer.from(body.content_base64, "base64") },
    extra: { content_warranty: raw["content_warranty"], rights_status: raw["rights_status"] },
  };
}

async function stageAndReply(req: FastifyRequest, reply: FastifyReply, u: Upload, tenantUpload?: { rightsStatus: TenantUploadRights }) {
  const parsed = await parseImportFile(u.format, u.data);
  const ref = u.sourceRef?.trim();
  if (ref) {
    // The form-level source reference fills rows that have none of their own.
    for (const p of parsed.rows) {
      const has = Object.entries(p.cells).some(([k, v]) => k.trim().toLowerCase() === "source_ref" && String(v).trim() !== "");
      if (!has) p.cells = { ...p.cells, source_ref: ref };
    }
  }
  const report = await stageImport(req.session!.tenantId, req.session!.userId, {
    fileName: u.fileName, fileSha256: sha256Hex(u.data), format: u.format,
    domain: u.domain, packName: u.packName ?? u.fileName.replace(/\.[^.]+$/, ""),
  }, parsed, tenantUpload);
  return reply.code(201).send(report);
}

const ExportParams = z.object({ id: uuid });
const ExportQuery = z.object({ format: z.literal("qti3") });

const MIME = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;

// Shared by the super-admin and the organisation-admin routes.
const templateHandler = async (req: FastifyRequest, reply: FastifyReply) => {
  const { type } = parse(TemplateParams, req.params, "type");
  const { format } = parse(TemplateQuery, req.query, "query");
  const file = await buildTemplate(type, format);
  return reply
    .header("content-type", MIME[format])
    .header("content-disposition", `attachment; filename="question-import-${type}.${format}"`)
    .send(file);
};
const getHandler = async (req: FastifyRequest) => {
  const { id } = parse(IdParams, req.params, "id");
  return getImportReport(req.session!.tenantId, id);
};
const patchHandler = async (req: FastifyRequest) => {
  const { id, row } = parse(RowParams, req.params, "params");
  const body = parse(PatchBody, req.body, "body");
  return fixImportRow(req.session!.tenantId, req.session!.userId, id, row, body);
};
const commitHandler = async (req: FastifyRequest) => {
  const { id } = parse(IdParams, req.params, "id");
  return commitImport(req.session!.tenantId, req.session!.userId, id, { mode: "skip-errors" });
};
const discardHandler = async (req: FastifyRequest) => {
  const { id } = parse(IdParams, req.params, "id");
  return discardImport(req.session!.tenantId, req.session!.userId, id);
};

export function registerImportRoutes(
  app: FastifyInstance,
  preHandler: preHandlerHookHandler[] | preHandlerHookHandler,
  tenantPreHandler: preHandlerHookHandler[] | preHandlerHookHandler,
  orgUploadGuard: preHandlerHookHandler[] | preHandlerHookHandler = tenantPreHandler,
): void {
  // EXP-17: upload, template, list, row edit and commit use orgUploadGuard (admin chain + the 'question_upload' plan gate).
  // Read, discard and withdraw stay on the plain admin chain (gate finding 2, S34).
  // Literal paths on purpose: tools/lint-ui-api-contract.ts matches route strings, not template variables.

  // EXP-17: organisation admins upload into their own tenant. Same service, same limits; the body must carry
  // content_warranty: true and the uploader's rights_status.
  app.post("/api/admin/question-imports", { preHandler: orgUploadGuard, bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    const { upload, extra } = await readUpload(req);
    const w = parse(TenantExtra, extra, "body");
    return stageAndReply(req, reply, upload, { rightsStatus: w.rights_status });
  });

  app.post("/api/admin/super/question-imports", { preHandler, bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    const { upload } = await readUpload(req);
    return stageAndReply(req, reply, upload);
  });

  // Static "/templates/:type" is registered before "/:id".
  app.get(`/api/admin/super/question-imports/templates/:type`, { preHandler }, templateHandler);

  // RW-59: QTI 3.0 package of one pack. The answer key is included on purpose (super-admin only).
  app.get(`/api/admin/super/packs/:id/export`, { preHandler }, async (req, reply) => {
    const { id } = parse(ExportParams, req.params, "params");
    parse(ExportQuery, req.query, "query");
    const { file, fileName } = await exportPackQti(req.session!.tenantId, req.session!.userId, id);
    return reply
      .header("content-type", "application/zip")
      .header("content-disposition", `attachment; filename="${fileName}"`)
      .send(file);
  });

  // EXP-17: organisation-admin copies of the five routes below (RLS limits every query to the caller's tenant).
  app.get(`/api/admin/question-imports/templates/:type`, { preHandler: orgUploadGuard }, templateHandler);
  // List of the organisation's own uploads, and withdraw of every question one upload made.
  app.get(`/api/admin/question-imports`, { preHandler: orgUploadGuard }, async (req) => listOrgUploads(req.session!.tenantId, req.session!.role));
  app.post(`/api/admin/question-imports/:id/withdraw`, { preHandler: tenantPreHandler }, async (req) => {
    const { id } = parse(IdParams, req.params, "id");
    return withdrawImport(req.session!.tenantId, req.session!.userId, req.session!.role, id);
  });
  // A lapsed plan must not remove the takedown path: read, discard and withdraw use the plain admin chain.
  app.get(`/api/admin/question-imports/:id`, { preHandler: tenantPreHandler }, getHandler);
  app.patch(`/api/admin/question-imports/:id/rows/:row`, { preHandler: orgUploadGuard }, patchHandler);
  app.post(`/api/admin/question-imports/:id/commit`, { preHandler: orgUploadGuard }, commitHandler);
  app.post(`/api/admin/question-imports/:id/discard`, { preHandler: tenantPreHandler }, discardHandler);

  app.get(`/api/admin/super/question-imports/:id`, { preHandler }, getHandler);

  app.patch(`/api/admin/super/question-imports/:id/rows/:row`, { preHandler }, patchHandler);

  app.post(`/api/admin/super/question-imports/:id/commit`, { preHandler }, commitHandler);

  app.post(`/api/admin/super/question-imports/:id/discard`, { preHandler }, discardHandler);

  // EXP-2: takedown of one question (rights_status = 'withdrawn', status = 'archived'). Super admin only.
  app.post(`/api/admin/super/questions/:id/withdraw`, { preHandler }, async (req) => {
    const { id } = parse(IdParams, req.params, "id");
    return withdrawQuestion(req.session!.tenantId, req.session!.userId, id);
  });
}
