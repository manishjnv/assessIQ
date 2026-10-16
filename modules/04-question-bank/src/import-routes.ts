// RW-58: super-admin CSV/XLSX question import routes (staged -> fix rows -> commit | discard).
// Body is JSON with a base64 file, or multipart/form-data (RW-97).
import type {} from "@fastify/multipart"; // request.file() / isMultipart() types only; the plugin is registered by apps/api
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { AppError, ValidationError, sha256Hex } from "@assessiq/core";
import { QUESTION_TYPES } from "@assessiq/question-types";
import { parseImportFile, IMPORT_MAX_BYTES } from "./import/parse.js";
import { stageImport, getImportReport, fixImportRow, discardImport } from "./import/staging.js";
import { commitImport } from "./import/commit.js";
import { buildTemplate } from "./import/templates.js";
import { exportPackQti } from "./import/export.js";

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

const ExportParams = z.object({ id: uuid });
const ExportQuery = z.object({ format: z.literal("qti3") });

const MIME = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;

export function registerImportRoutes(
  app: FastifyInstance,
  preHandler: preHandlerHookHandler[] | preHandlerHookHandler,
): void {
  // Literal paths on purpose: tools/lint-ui-api-contract.ts matches route strings, not template variables.

  app.post("/api/admin/super/question-imports", { preHandler, bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    const tooLarge = () => new AppError("The file is larger than 4 MB.", "FILE_TOO_LARGE", 413);
    let fileName: string; let format: z.infer<typeof Format>; let domain: string; let packName: string | undefined; let data: Buffer;
    if (req.isMultipart()) {
      let part;
      try { part = await req.file(); } catch (e) {
        if ((e as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") throw tooLarge();
        throw e;
      }
      if (part === undefined) throw new ValidationError("invalid body", { details: { code: "INVALID_PARAM", issues: [{ message: "file part is required" }] } });
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
        file_name: text("file_name") ?? part.filename, format: text("format"), domain: text("domain"), pack_name: text("pack_name"),
      }, "body");
      ({ file_name: fileName, format, domain, pack_name: packName } = f);
    } else {
      const body = parse(UploadBody, req.body, "body");
      ({ file_name: fileName, format, domain, pack_name: packName } = body);
      data = Buffer.from(body.content_base64, "base64");
    }
    const parsed = await parseImportFile(format, data);
    const report = await stageImport(req.session!.tenantId, req.session!.userId, {
      fileName, fileSha256: sha256Hex(data), format,
      domain, packName: packName ?? fileName.replace(/\.[^.]+$/, ""),
    }, parsed);
    return reply.code(201).send(report);
  });

  // Static "/templates/:type" is registered before "/:id".
  app.get(`/api/admin/super/question-imports/templates/:type`, { preHandler }, async (req, reply) => {
    const { type } = parse(TemplateParams, req.params, "type");
    const { format } = parse(TemplateQuery, req.query, "query");
    const file = await buildTemplate(type, format);
    return reply
      .header("content-type", MIME[format])
      .header("content-disposition", `attachment; filename="question-import-${type}.${format}"`)
      .send(file);
  });

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

  app.get(`/api/admin/super/question-imports/:id`, { preHandler }, async (req) => {
    const { id } = parse(IdParams, req.params, "id");
    return getImportReport(req.session!.tenantId, id);
  });

  app.patch(`/api/admin/super/question-imports/:id/rows/:row`, { preHandler }, async (req) => {
    const { id, row } = parse(RowParams, req.params, "params");
    const body = parse(PatchBody, req.body, "body");
    return fixImportRow(req.session!.tenantId, req.session!.userId, id, row, body);
  });

  app.post(`/api/admin/super/question-imports/:id/commit`, { preHandler }, async (req) => {
    const { id } = parse(IdParams, req.params, "id");
    return commitImport(req.session!.tenantId, req.session!.userId, id, { mode: "skip-errors" });
  });

  app.post(`/api/admin/super/question-imports/:id/discard`, { preHandler }, async (req) => {
    const { id } = parse(IdParams, req.params, "id");
    return discardImport(req.session!.tenantId, req.session!.userId, id);
  });
}
