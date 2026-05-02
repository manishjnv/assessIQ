/**
 * Cookie-auth help routes (any authenticated role).
 *
 * GET /api/help?page=...&audience=...&locale=...   — page batch
 * GET /api/help/:key?locale=...                    — single key
 *
 * The `authChain` factory is injected by the API app so this package does not
 * import from apps/api/** (which would create a reverse dependency). The caller
 * (apps/api/src/server.ts) passes its own authChain function in `deps`.
 */

import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { NotFoundError, ValidationError } from "@assessiq/core";
import type { Audience } from "./types.js";
import { getHelpForPage, getHelpKey } from "./service.js";

// Matches help_id segments: lowercase letters, digits, underscores, dots.
const HELP_KEY_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;
const LOCALE_RE = /^\w{2,3}(-[A-Z]{2})?$/;
const AUDIENCE_VALUES = new Set<string>(["admin", "reviewer", "candidate", "all"]);

const DEFAULT_AUDIENCE: Audience = "all";
const DEFAULT_LOCALE = "en";

// Dependency-injection shape: mirrors apps/api/src/middleware/auth-chain.ts
// `authChain` signature without importing it directly.
export interface HelpAuthDeps {
  authChain: (opts?: {
    roles?: readonly string[];
  }) => Array<(req: unknown, reply: unknown) => Promise<void> | void>;
}

export async function registerHelpAuthRoutes(
  app: FastifyInstance,
  deps: HelpAuthDeps,
): Promise<void> {
  // Cast the injected chain to Fastify's native preHandler hook type.
  // The DI chain is structurally compatible (same req/reply shape) — the cast
  // follows the same pattern as apps/api/src/middleware/auth-chain.ts `cast()`.
  const anyRole = deps.authChain() as preHandlerHookHandler[];

  // GET /api/help?page=...&audience=...&locale=...
  app.get(
    "/api/help",
    { preHandler: anyRole },
    async (req) => {
      const tenantId = (req as { session?: { tenantId: string } }).session!.tenantId;
      const q = req.query as Record<string, string | undefined>;

      const page = q["page"];
      const locale = q["locale"] ?? DEFAULT_LOCALE;
      const rawAudience = q["audience"] ?? DEFAULT_AUDIENCE;

      if (page === undefined || page.length === 0) {
        throw new ValidationError("Query param 'page' is required", {
          details: { code: "INVALID_PARAM", param: "page" },
        });
      }
      if (!HELP_KEY_RE.test(page)) {
        throw new ValidationError("Invalid page format", {
          details: { code: "INVALID_PARAM", param: "page" },
        });
      }
      if (!LOCALE_RE.test(locale)) {
        throw new ValidationError("Invalid locale format", {
          details: { code: "INVALID_PARAM", param: "locale" },
        });
      }
      if (!AUDIENCE_VALUES.has(rawAudience)) {
        throw new ValidationError("Invalid audience value", {
          details: { code: "INVALID_PARAM", param: "audience" },
        });
      }

      const audience = rawAudience as Audience;
      return getHelpForPage(tenantId, page, audience, locale);
    },
  );

  // GET /api/help/:key?locale=...
  app.get(
    "/api/help/:key",
    { preHandler: anyRole },
    async (req) => {
      const tenantId = (req as { session?: { tenantId: string } }).session!.tenantId;
      const { key } = req.params as { key: string };
      const q = req.query as Record<string, string | undefined>;
      const locale = q["locale"] ?? DEFAULT_LOCALE;

      if (!HELP_KEY_RE.test(key)) {
        throw new ValidationError("Invalid help key format", {
          details: { code: "INVALID_PARAM", param: "key" },
        });
      }
      if (!LOCALE_RE.test(locale)) {
        throw new ValidationError("Invalid locale format", {
          details: { code: "INVALID_PARAM", param: "locale" },
        });
      }

      const entry = await getHelpKey(tenantId, key, locale);
      if (entry === null) {
        throw new NotFoundError(`Help entry not found: ${key}`);
      }
      return entry;
    },
  );
}
