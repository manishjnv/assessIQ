/**
 * Admin help routes — admin role only.
 *
 * PATCH  /api/admin/help/:key           — upsert / update a help entry
 * GET    /api/admin/help/export?locale= — export all entries for translation
 * POST   /api/admin/help/import?locale= — bulk upsert from translation import
 *
 * NOTE: 'export' route MUST be registered before '/:key' to prevent Fastify
 * from treating the literal segment "export" as a key parameter.
 * Fastify matches static segments before parameterised ones, but explicit
 * ordering is a safety net (same pattern as admin-users.ts import route).
 *
 * `authChain` is injected via deps — see routes-auth.ts for the rationale.
 */

import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { ValidationError } from "@assessiq/core";
import { UpsertHelpInputSchema } from "./types.js";
import {
  upsertHelpForTenant,
  exportHelp,
  importHelp,
} from "./service.js";

const HELP_KEY_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;
const LOCALE_RE = /^\w{2,3}(-[A-Z]{2})?$/;

export interface HelpAdminDeps {
  authChain: (opts?: {
    roles?: readonly string[];
  }) => Array<(req: unknown, reply: unknown) => Promise<void> | void>;
}

export async function registerHelpAdminRoutes(
  app: FastifyInstance,
  deps: HelpAdminDeps,
): Promise<void> {
  // Cast the injected chain to Fastify's native preHandler hook type.
  // Same structural-cast pattern as apps/api/src/middleware/auth-chain.ts.
  const adminOnly = deps.authChain({ roles: ["admin"] }) as preHandlerHookHandler[];

  // GET /api/admin/help/export?locale=...
  // Registered BEFORE /:key so 'export' is not consumed as a key param.
  app.get(
    "/api/admin/help/export",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = (req as { session?: { tenantId: string } }).session!.tenantId;
      const q = req.query as Record<string, string | undefined>;
      const locale = q["locale"] ?? "en";

      if (!LOCALE_RE.test(locale)) {
        throw new ValidationError("Invalid locale format", {
          details: { code: "INVALID_PARAM", param: "locale" },
        });
      }

      return exportHelp(tenantId, locale);
    },
  );

  // PATCH /api/admin/help/:key
  app.patch(
    "/api/admin/help/:key",
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = (req as { session?: { tenantId: string } }).session!.tenantId;
      const { key } = req.params as { key: string };

      if (!HELP_KEY_RE.test(key)) {
        throw new ValidationError("Invalid help key format", {
          details: { code: "INVALID_PARAM", param: "key" },
        });
      }

      const parsed = UpsertHelpInputSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid request body", {
          details: { code: "VALIDATION_FAILED", issues: parsed.error.issues },
        });
      }

      return upsertHelpForTenant(tenantId, key, parsed.data);
    },
  );

  // POST /api/admin/help/import?locale=...
  app.post(
    "/api/admin/help/import",
    { preHandler: adminOnly },
    async (req, reply) => {
      const tenantId = (req as { session?: { tenantId: string } }).session!.tenantId;
      const q = req.query as Record<string, string | undefined>;
      const locale = q["locale"] ?? "en";

      if (!LOCALE_RE.test(locale)) {
        throw new ValidationError("Invalid locale format", {
          details: { code: "INVALID_PARAM", param: "locale" },
        });
      }

      const body = req.body as { rows?: unknown };
      if (!Array.isArray(body?.rows)) {
        throw new ValidationError("Request body must have a 'rows' array", {
          details: { code: "VALIDATION_FAILED" },
        });
      }

      // Validate each row.
      const rows: Array<{ key: string; input: import("./types.js").UpsertHelpInput }> = [];
      for (let i = 0; i < body.rows.length; i++) {
        const item = body.rows[i] as { key?: unknown; input?: unknown };
        if (typeof item.key !== "string" || !HELP_KEY_RE.test(item.key)) {
          throw new ValidationError(`Row ${i}: missing or invalid 'key'`, {
            details: { code: "VALIDATION_FAILED", index: i },
          });
        }
        const inputParsed = UpsertHelpInputSchema.safeParse(item.input);
        if (!inputParsed.success) {
          throw new ValidationError(`Row ${i}: invalid 'input'`, {
            details: {
              code: "VALIDATION_FAILED",
              index: i,
              issues: inputParsed.error.issues,
            },
          });
        }
        rows.push({ key: item.key, input: inputParsed.data });
      }

      const result = await importHelp(tenantId, locale, rows);
      return reply.code(200).send(result);
    },
  );
}
