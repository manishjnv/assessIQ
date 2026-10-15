// RW-58: super-admin CSV/XLSX question import routes (staged -> fix rows -> commit | discard).
// Body is JSON with a base64 file; multipart is a follow-up (@fastify/multipart is not an apps/api dependency).
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { ValidationError, sha256Hex } from "@assessiq/core";
import { QUESTION_TYPES } from "@assessiq/question-types";
import { parseImportFile, IMPORT_MAX_BYTES } from "./import/parse.js";
import { stageImport, getImportReport, fixImportRow, discardImport } from "./import/staging.js";
import { commitImport } from "./import/commit.js";
import { buildTemplate } from "./import/templates.js";

const uuid = z.string().uuid();
const Format = z.enum(["csv", "xlsx"]);
const IdParams = z.object({ id: uuid });
const RowParams = z.object({ id: uuid, row: z.coerce.number().int().min(1) });
const TemplateParams = z.object({ type: z.enum(QUESTION_TYPES) });
const TemplateQuery = z.object({ format: Format.default("csv") });
const UploadBody = z.object({
  file_name: z.string().min(1).max(200),
  format: Format,
  content_base64: z.string().min(1).max(Math.ceil((IMPORT_MAX_BYTES * 4) / 3) + 8),
  domain: z.string().min(1).max(80),
  pack_name: z.string().min(1).max(200).optional(),
});
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
    const body = parse(UploadBody, req.body, "body");
    const data = Buffer.from(body.content_base64, "base64");
    const parsed = await parseImportFile(body.format, data);
    const report = await stageImport(req.session!.tenantId, req.session!.userId, {
      fileName: body.file_name, fileSha256: sha256Hex(data), format: body.format,
      domain: body.domain, packName: body.pack_name ?? body.file_name.replace(/\.[^.]+$/, ""),
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
